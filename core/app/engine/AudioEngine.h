#pragma once

// AudioEngine public header. The class is large, so public API and private
// state are split across sibling headers included inside the class body
// (same readability approach as AudioEngine*.cpp). External code still
// includes only this file.
//
//   AudioEngineProjectApi.h    load/save/import/dirty
//   AudioEngineTransportApi.h  selectSong/play/stop/seek/cycle/history
//   AudioEngineRoutingApi.h    mix controls + routing rebuild
//   AudioEnginePeaksApi.h      peak overview / waveform cache
//   AudioEngineMembers.h       private fields + private methods
//
// Shared free helpers for the .cpp TUs live in AudioEngineInternal.h.

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_events/juce_events.h>

#include "audio/ClickGenerator.h"
#include "audio/Metering.h"
#include "audio/PeakBuildThreadPool.h"
#include "audio/PeakOverview.h"
#include "audio/MixRenderer.h"
#include "audio/RoutingEngine.h"
#include "audio/StreamingEngine.h"
#include "events/EventDispatcher.h"
#include "LightEngine.h"
#include "midi/CoreMidiDispatcher.h"
#include "project/ProjectHistory.h"
#include "project/ProjectLoader.h"
#include "project/ProjectSchema.h"
#include "telemetry/SeqLock.h"
#include "telemetry/SystemHealth.h"
#include "telemetry/Telemetry.h"
#include "timing/MasterClock.h"

#include <algorithm>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace resostage {

// One row of the mixer's flat bus rail (0 = Main, 1..N = Sends in project
// order, then the fabricated Direct Output lanes). Derived wholesale from the
// published MixGraph -- never assembled independently, which is how the rail
// and the actual mix used to drift apart.
struct LoadedBus {
    std::string id;
    std::string name;
    int channelCount = 2;
    int startChannel = 0; // first physical output channel (0-based)
    // A fabricated Direct Output lane rather than an authorable project bus:
    // hidden from the editable rail, never persisted.
    bool isDirectOut = false;
    // False when a Direct Output lane's physical channel is currently gone
    // (device dropped / channel switched off). Routing is preserved and the
    // lane simply renders to silence until the channel returns.
    bool available = true;
    // This row's strip in the MixGraph, for meter reads.
    uint32_t stripIndex = MixGraph::kNoStrip;
};

// The only piece of the engine that touches JUCE audio APIs. Owns the
// CoreAudio device connection, and on every real-time callback: advances
// MasterClock, pulls the current block's audio from StreamingEngine (disk-
// backed SPSC ring buffers, not a full-song RAM preload -- see StreamingEngine
// and StreamingTrackBuffer for the streaming/catch-up design), walks the
// active RoutingEngine snapshot to mix tracks -> busses -> physical outputs,
// updates per-bus metering, fires any TimelineEvents whose time has arrived
// (MIDI/HTTP/DMX, dispatched off-thread via CoreMidiDispatcher/EventDispatcher),
// and detects song end to apply the song's playback mode (auto-advance or
// wait-for-trigger).
class AudioEngine final : public juce::AudioIODeviceCallback, private juce::ChangeListener {
public:
    AudioEngine();

    ~AudioEngine() override;

    juce::AudioDeviceManager& deviceManager() { return deviceManagerInstance; }

    CoreMidiDispatcher& midi() { return midiDispatcher; }

    EventDispatcher& events() { return eventDispatcher; }

    LightHardwareServer& lightHardware() { return lightHardwareServer; }

    const Project& project() const { return loader.project(); }

    Project& project() { return loader.project(); }

    bool isProjectLoaded() const { return projectLoaded; }

    size_t currentSongIndex() const { return currentSong; }

    // Called by MainComponent after any in-place edit of Project data so the
    // LightEngine thread picks up the change on the next DMX frame. Also
    // re-applies the Art-Net unicast/broadcast target every time -- cheap
    // (a string compare + assignment inside EventDispatcher), and this is
    // the one choke point every lighting mutator AND project load already
    // funnels through, so a saved artNetTargetHost takes effect immediately
    // without needing its own separate wiring at every load site.
    void notifyLightEngineProjectChanged() {
        lightEngine.setProject(std::make_shared<Project>(loader.project()));
        const auto& target = loader.project().lighting.artNetTargetHost;
        eventDispatcher.setArtNetTargetAddress(
            (!target.has_value() || target->empty()) ? "255.255.255.255" : *target);
    }

    // Called by MainComponent when the CURRENTLY ACTIVE song's own BPM is
    // edited live (builderSongUpdate). goToSong() already pushes BPM to
    // LightEngine on every song switch (see switchToSongGapless), but
    // editing the tempo of the song that's already staged/playing never
    // goes through that path -- without this, tempo-synced light effects on
    // the real DMX output silently keep running at the stale old BPM until
    // the next song change, even though the operator's own preview (which
    // reads SongDef::bpm fresh every publish) shows the new tempo instantly.
    void notifyLightEngineBpmChanged(double bpm) {
        lightEngine.setBpm(bpm);
    }

#include "AudioEngineProjectApi.h"
#include "AudioEngineTransportApi.h"
#include "AudioEngineRoutingApi.h"
#include "AudioEnginePeaksApi.h"

    // Safe wrapper around AudioDeviceManager::initialiseWithDefaultDevices and setAudioDeviceSetup
    // that suppresses false-positive hardwareAlarm triggers during intentional device re-configuration.
    juce::String initialiseDefaultDevices(int numInputChannels = 0, int numOutputChannels = 2);

    juce::String setAudioDeviceSetup(const juce::AudioDeviceManager::AudioDeviceSetup& setup, bool treatAsPreferred);

    MasterClock& masterClock() { return clock; }

    // Debug-only: makes the NEXT audio callback sleep for `milliseconds`
    // before doing any work, simulating a driver stall/underrun so the
    // fail-safe playhead behavior can be verified manually on real hardware.
    // Deliberately violates real-time-thread rules -- that's the point, it's
    // a manual test trigger, never called in normal operation.
    void simulateUnderrun(double milliseconds) { simulatedStallMs.store(milliseconds, std::memory_order_release); }

    // Per-bus / per-track telemetry for the UI to poll.
    const SeqLock<MeterFrame>* busMeterAt(size_t index) const;

    const SeqLock<MeterFrame>* trackMeterAt(size_t index) const;

    /** Peak of the metronome only (not the bus it is routed into). */
    const SeqLock<MeterFrame>* clickMeter() const { return &clickMeterFrame; }

    // Consume max click peak since the previous call (linear → MeterFrame dB).
    // Message-thread UI poll: a single audio-block impulse would otherwise be
    // overwritten by silence before the next 30 Hz sample, so the audio thread
    // accumulates interval max and this clears it.
    //
    // Each non-zero interval peak is also echoed for one extra poll so a single
    // skipped WS frame (client timer vs publish phase, or writePending drop)
    // cannot erase an audible tick from the wire. Still the true rendered
    // peak — not a post-silence display hold beyond that one-frame delivery
    // redundancy.
    MeterFrame consumeClickMeterInterval();

    // Same interval-max pattern as the click strip, but for every bus. The
    // metronome is mixed into busScratch *before* bus metering, yet a short
    // click (~30ms) is still overwritten by silent blocks before the ~30 Hz
    // UI poll reads busMeters -- so the main/aux bus needle "misses" ticks
    // even though they are audible. This returns LUFS/etc from the latest
    // frame with peak fields replaced by the interval max (+ one-frame echo).
    MeterFrame consumeBusMeterInterval(size_t busIndex);

    bool isBusMuted(size_t busIndex) const;

    bool isBusSoloed(size_t busIndex) const;

    double busGainDb(size_t busIndex) const;

    const TransportTelemetry& transport() const { return transportTelemetry; }

    SystemHealth& health() { return systemHealth; }

    const SystemHealth& health() const { return systemHealth; }

    // Times a stem's ring buffer ran dry mid-block while the file still had
    // audio to give -- see StreamingTrackBuffer::starveCount(). The render
    // callback cannot react (the block is due now), so it emits part real
    // audio and part silence: a step to zero inside a block, i.e. a click.
    // The driver was serviced on time, so this never appears as an underrun.
    uint64_t streamStarveCount() const { return StreamingTrackBuffer::totalStarveCount(); }

    // juce::AudioIODeviceCallback
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext& context) override;

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;

    void audioDeviceStopped() override;

private:
#include "AudioEngineMembers.h"
};

} // namespace resostage
