#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include "audio/Metering.h"
#include "audio/RoutingEngine.h"
#include "project/ProjectLoader.h"
#include "project/ProjectSchema.h"
#include "telemetry/SeqLock.h"
#include "telemetry/Telemetry.h"
#include "timing/MasterClock.h"

#include <atomic>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace resoset {

// One fully-decoded stem, resident in RAM. Milestone 1 simplification: stems
// are decoded in full at project/song-load time rather than streamed from
// disk in a ring buffer (that's Milestone 2). Fine for short test fixtures
// and even a real short set; not yet the ~150-300MB-footprint design target.
//
// Also assumes the WAV's sample rate matches the audio device's current
// sample rate (no resampling) -- documented Milestone 1 limitation.
struct LoadedTrack {
    std::string id;
    juce::AudioBuffer<float> samples;
    int64_t lengthSamples = 0;
};

struct LoadedBus {
    std::string id;
    int channelCount = 2;
};

// The only piece of the engine that touches JUCE audio APIs. Owns the
// CoreAudio device connection, decodes stems via juce::AudioFormatReader,
// and on every real-time callback: advances MasterClock, walks the active
// RoutingEngine snapshot to mix tracks -> busses -> physical outputs, and
// updates per-bus metering.
class AudioEngine final : public juce::AudioIODeviceCallback {
public:
    AudioEngine();
    ~AudioEngine() override;

    juce::AudioDeviceManager& deviceManager() { return deviceManagerInstance; }

    // Loads a .rsnraset and its global bus list. Does not decode any song's
    // stems yet -- call selectSong() next. Returns false + fills `error` on failure.
    bool loadProject(const std::string& path, std::string& error);

    // Decodes the given song's stems to RAM and publishes its routing. Stops
    // playback first if currently playing.
    bool selectSong(size_t songIndex, std::string& error);

    void play();
    void stop();
    bool isPlaying() const { return playing.load(std::memory_order_acquire); }

    const Project& project() const { return loader.project(); }
    size_t currentSongIndex() const { return currentSong; }
    size_t busCount() const { return busses.size(); }
    const std::string& busIdAt(size_t index) const { return busses[index].id; }

    MasterClock& masterClock() { return clock; }

    // Debug-only: makes the NEXT audio callback sleep for `milliseconds`
    // before doing any work, simulating a driver stall/underrun so the
    // fail-safe playhead behavior can be verified manually on real hardware
    // (see Milestone 1 verification plan, step 5). Deliberately violates
    // real-time-thread rules -- that's the point, it's a manual test trigger,
    // never called in normal operation.
    void simulateUnderrun(double milliseconds) { simulatedStallMs.store(milliseconds, std::memory_order_release); }

    // Per-bus telemetry, keyed by bus index (0..busCount()), for the UI to poll.
    const SeqLock<MeterFrame>* busMeterAt(size_t index) const;

    const TransportTelemetry& transport() const { return transportTelemetry; }

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
    juce::AudioDeviceManager deviceManagerInstance;
    juce::AudioFormatManager formatManager;

    ProjectLoader loader;
    MasterClock clock;
    RoutingEngine routing;
    TransportTelemetry transportTelemetry;

    std::vector<LoadedBus> busses; // global, built once per loadProject()
    std::unordered_map<std::string, size_t> busIndexById;

    std::vector<LoadedTrack> tracks; // rebuilt per selectSong()
    std::vector<std::unique_ptr<SeqLock<MeterFrame>>> busMeters;
    std::vector<LoudnessMeter> busLoudnessMeters;

    size_t currentSong = 0;
    std::atomic<bool> playing{false};
    std::atomic<int64_t> hwSamplePosition{0};
    std::atomic<double> simulatedStallMs{0.0};

    double currentSampleRate = 48000.0;
    int currentBlockSize = 512;

    // Reused every callback; resized only from non-real-time call sites
    // (audioDeviceAboutToStart, loadProject) -- never on the audio thread.
    juce::AudioBuffer<float> busScratch;

    void ensureScratchSize();
    void buildBusListFromProject();
};

} // namespace resoset
