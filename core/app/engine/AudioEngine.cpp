// AudioEngine implementation core: construction/teardown, device setup,
// hot-plug fail-safe, meters, timeline length helpers, and the realtime
// audioDeviceIOCallback path. Sibling TUs (same class, full private access):
//   AudioEngineProject.cpp   load/save/new/dirty
//   AudioEngineTransport.cpp selectSong/play/stop/seek/gapless/events
//   AudioEngineRouting.cpp   routing snapshot + live mix controls
//   AudioEnginePeaks.cpp     peak overview build/cache
//   AudioEngineImport.cpp    WAV/folder import
// Shared free helpers live in AudioEngineInternal.h.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "timing/CycleMath.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <thread>

namespace resostage {

using audio_engine_detail::dbToGain;
using audio_engine_detail::shapedFadeGain;
using audio_engine_detail::kRingBufferSeconds;
using audio_engine_detail::purgeStaleDrafts;

namespace {
// The normal device callback is deliberately monolithic: it owns the one
// graph snapshot, scratch lifetime and physical-output write for a block. At
// an exact project-cycle boundary we invoke that same bounded renderer for the
// two contiguous portions of the device block. This guard prevents either
// child render from attempting to split itself again.
thread_local bool gRenderingExactCycleSegment = false;
thread_local int gExactCycleSegmentOrdinal = 0;
thread_local int gExactCycleRootSamples = 0;
thread_local uint64_t gExactCycleHostOffsetNanos = 0;
}

AudioEngine::AudioEngine() {
    trackToAudioRecordSession.fill(-1);

    // Before anything can play. A few hundred thousand transcendental
    // evaluations, once, on the thread that constructs the engine -- never on
    // the audio thread, and never in response to a speed change.
    sincTables.build();

    // Reclaim disk from previous sessions even if the user never hits New
    // Project this launch (makeDraftArchivePath also rotates on create).
    {
        const juce::File userData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
#if JUCE_MAC
        const juce::File appSupport = userData.getChildFile("Application Support");
#else
        const juce::File appSupport = userData;
#endif
        purgeStaleDrafts(appSupport.getChildFile("ResoStage").getChildFile("Drafts"));
    }
    startPluginBankBuilder();
    deviceManagerInstance.addAudioCallback(this);
    deviceManagerInstance.addChangeListener(this);
    midiDispatcher.start();
    eventDispatcher.start();
    lightHardwareServer.start();

    // Start LightEngine: provide bus- and track-peak callbacks so a Meter
    // effect can sample either pool's audio level without touching the
    // audio thread directly.
    lightEngine.start(
        clock,
        eventDispatcher,
        &lightHardwareServer,
        [this](const std::string& busId) -> SourceLevels {
            // Empty busId → use first bus (master mix).
            size_t idx = 0;
            if (!busId.empty()) {
                auto it = busIndexById.find(busId);
                if (it == busIndexById.end()) return SourceLevels{};
                idx = it->second;
            }
            if (const auto* m = busMeterAt(idx)) {
                MeterFrame f{};
                m->read(f);
                SourceLevels lv;
                lv.peakDb = f.peakDb;
                for (int b = 0; b < kLightBandCount; ++b)
                    lv.bandLevel[b] = f.bandLevel[b];
                return lv;
            }
            return SourceLevels{};
        },
        [this](const std::string& trackId) -> SourceLevels {
            for (size_t i = 0; i < trackIdByIndex.size(); ++i) {
                if (trackIdByIndex[i] != trackId)
                    continue;
                if (const auto* m = trackMeterAt(i)) {
                    MeterFrame f{};
                    m->read(f);
                    SourceLevels lv;
                    lv.peakDb = f.peakDb;
                    for (int b = 0; b < kLightBandCount; ++b)
                        lv.bandLevel[b] = f.bandLevel[b];
                    return lv;
                }
                break;
            }
            return SourceLevels{};
        }
    );
}

AudioEngine::~AudioEngine() {
    // If an async import is still running (rare -- app quit mid-import), let
    // it finish rather than tearing down loader/streaming out from under its
    // background thread. Imports are seconds, not minutes, so this is a
    // bounded, acceptable delay on quit.
    if (importThread.joinable())
        importThread.join();
    if (saveThread.joinable())
        saveThread.join();
    if (pendingFinishImport) {
        auto fn = std::move(pendingFinishImport);
        pendingFinishImport = nullptr;
        fn();
    }
    // Background peak builds also read `loader` (see rebuildTrackPeaks());
    // wait for them before streaming.stop() hands loader ownership to us.
    joinPendingPeakBuilds();
    stop();
    streaming.stop();
    purgeStaleSavePackages();
    lightEngine.stop();
    lightHardwareServer.stop();
    midiDispatcher.stop();
    eventDispatcher.stop();
    deviceManagerInstance.removeChangeListener(this);
    deviceManagerInstance.removeAudioCallback(this);
    deviceManagerInstance.closeAudioDevice();
    stopPluginBankBuilder();
}

juce::String AudioEngine::initialiseDefaultDevices(int numInputChannels, int numOutputChannels) {
    isChangingSetup.store(true, std::memory_order_relaxed);
    const juce::String error = deviceManagerInstance.initialiseWithDefaultDevices(numInputChannels, numOutputChannels);
    isChangingSetup.store(false, std::memory_order_relaxed);

    if (auto* dev = deviceManagerInstance.getCurrentAudioDevice()) {
        lastKnownDeviceName = dev->getName().toStdString();
        transportTelemetry.hardwareAlarm.store(false, std::memory_order_relaxed);
    }
    return error;
}

juce::String AudioEngine::setAudioDeviceSetup(const juce::AudioDeviceManager::AudioDeviceSetup& setup, bool treatAsPreferred) {
    isChangingSetup.store(true, std::memory_order_relaxed);
    const juce::String error = deviceManagerInstance.setAudioDeviceSetup(setup, treatAsPreferred);
    isChangingSetup.store(false, std::memory_order_relaxed);

    if (auto* dev = deviceManagerInstance.getCurrentAudioDevice()) {
        lastKnownDeviceName = dev->getName().toStdString();
        transportTelemetry.hardwareAlarm.store(false, std::memory_order_relaxed);
    }
    return error;
}

void AudioEngine::changeListenerCallback(juce::ChangeBroadcaster*) {
    checkForDeviceLoss();
}

void AudioEngine::checkForDeviceLoss() {
    if (isChangingSetup.load(std::memory_order_relaxed))
        return;

    auto* currentDevice = deviceManagerInstance.getCurrentAudioDevice();
    if (currentDevice != nullptr) {
        lastKnownDeviceName = currentDevice->getName().toStdString();
        transportTelemetry.hardwareAlarm.store(false, std::memory_order_relaxed);
        return;
    }

    if (lastKnownDeviceName.empty())
        return; // never had a device yet -- nothing to fail over from

    // The device we were using is gone. Alarm the UI and fall back to the
    // system default output. MasterClock is deliberately left running (not
    // stopped here) -- it keeps advancing off wall-clock time regardless of
    // whether the audio callback is firing, so when a device comes back
    // online, StreamingTrackBuffer's catch-up logic resyncs audio to
    // wherever the timeline says it should be rather than restarting from
    // where playback happened to stop.
    lastKnownDeviceName.clear();
    transportTelemetry.hardwareAlarm.store(true, std::memory_order_relaxed);
    isChangingSetup.store(true, std::memory_order_relaxed);
    deviceManagerInstance.initialiseWithDefaultDevices(0, 2);
    isChangingSetup.store(false, std::memory_order_relaxed);
}

const SeqLock<MeterFrame>* AudioEngine::busMeterAt(size_t index) const {
    if (index >= busMeters.size())
        return nullptr;
    return busMeters[index].get();
}

const SeqLock<MeterFrame>* AudioEngine::trackMeterAt(size_t index) const {
    if (index >= trackMeters.size())
        return nullptr;
    return trackMeters[index].get();
}

namespace {
void atomicMaxFloat(std::atomic<float>& slot, float v) {
    if (!(v > 0.0f) || !std::isfinite(v))
        return;
    float cur = slot.load(std::memory_order_relaxed);
    while (v > cur
           && !slot.compare_exchange_weak(cur, v, std::memory_order_relaxed,
                                          std::memory_order_relaxed)) {
        // cur updated by CAS failure
    }
}

float linearPeakToDb(float p) {
    if (!(p > 1.0e-9f) || !std::isfinite(p))
        return -144.0f;
    return 20.0f * std::log10(std::min(p, 32.0f));
}

/**
 * Loudest thing this meter measured since the last poll.
 *
 * A true interval peak: the audio thread measures every 64 samples, so the
 * answer does not depend on where the callback boundaries happened to fall.
 * That is what makes a 512-frame buffer and a 4096-frame buffer read the same.
 *
 * Nothing drained means no audio was rendered since the last publish -- at a
 * big buffer that is most polls -- so the previous value stands. That is not a
 * decay: it is the absence of a new measurement, and how the needle FALLS is
 * the display's decision, not ours. Real silence still reads as silence
 * immediately, because a rendered block of silence measures zero and says so.
 */
template <size_t Capacity>
const MeterEnvelopePoint& drainEnvelope(MeterEnvelopeRing<Capacity>& ring,
                                        MeterEnvelopePoint& lastPoint) {
    MeterEnvelopePoint points[Capacity];
    const size_t n = ring.drain(points, Capacity);
    if (n == 0)
        return lastPoint;

    MeterEnvelopePoint loudest;
    for (size_t i = 0; i < n; ++i) {
        loudest.peakL = std::max(loudest.peakL, points[i].peakL);
        loudest.peakR = std::max(loudest.peakR, points[i].peakR);
    }
    lastPoint = loudest;
    return lastPoint;
}
} // namespace

MeterFrame AudioEngine::consumeClickMeterInterval() {
    // Take the max peak rendered since the previous UI poll, then clear.
    const float peakL = clickPeakIntervalMaxL.exchange(0.0f, std::memory_order_relaxed);
    const float peakR = clickPeakIntervalMaxR.exchange(0.0f, std::memory_order_relaxed);

    // Echo last interval once: publish N carries real peak, publish N+1 still
    // carries it if this interval was silent. WS client that only samples the
    // later frame still sees the tick. Next silent interval clears delivery.
    // Whichever is louder: the impulse latch (catches a click that came and
    // went between polls) or the last block the audio thread actually
    // rendered.
    //
    // The latch ALONE is empty on any poll that lands between callbacks, and
    // at a big buffer that is most of them -- reporting zero there is not a
    // quiet moment, it is a measurement that never happened, and the needle
    // answered by slamming to the floor twelve times a second. Falling back
    // to the last rendered block is not a simulated decay: it is the most
    // recent measurement there is. Real silence still reads as silence the
    // moment a block of silence is rendered.
    const float lastL = clickLastBlockPeakL.load(std::memory_order_relaxed);
    const float lastR = clickLastBlockPeakR.load(std::memory_order_relaxed);
    const float outL = std::max(peakL, lastL);
    const float outR = std::max(peakR, lastR);

    MeterFrame frame;
    // What a bar is driven by: the loudest sample since the last poll,
    // measured every 64 samples, so it reads the same at 512 frames and at
    // 4096.
    const MeterEnvelopePoint& click = drainEnvelope(clickEnvelopeRing, clickLastPeak);
    frame.intervalPeakDbL = linearPeakToDb(click.peakL);
    frame.intervalPeakDbR = linearPeakToDb(click.peakR);
    frame.peakDbL = linearPeakToDb(outL);
    frame.peakDbR = linearPeakToDb(outR);
    frame.peakDb = linearPeakToDb(std::max(outL, outR));
    frame.truePeakDb = frame.peakDb;
    return frame;
}

MeterFrame AudioEngine::consumeTrackMeterInterval(size_t trackIndex) {
    MeterFrame frame;
    if (trackIndex < trackMeters.size() && trackMeters[trackIndex] != nullptr)
        (void)trackMeters[trackIndex]->read(frame);

    float peakL = 0.0f;
    float peakR = 0.0f;
    if (trackIndex < trackPeakIntervalCount && trackPeakIntervalMaxL && trackPeakIntervalMaxR) {
        peakL = trackPeakIntervalMaxL[trackIndex].exchange(0.0f, std::memory_order_relaxed);
        peakR = trackPeakIntervalMaxR[trackIndex].exchange(0.0f, std::memory_order_relaxed);
    }

    // Same logic as consumeBusMeterInterval: use the interval latch (catches
    // a short impulse that came and went between polls) OR the last rendered
    // block (so a poll landing between audio callbacks still has a real
    // measurement, not a zero it has no evidence for).
    float outL = peakL;
    float outR = peakR;
    if (trackIndex < trackPeakIntervalCount && trackLastBlockPeakL && trackLastBlockPeakR) {
        outL = std::max(peakL, trackLastBlockPeakL[trackIndex].load(std::memory_order_relaxed));
        outR = std::max(peakR, trackLastBlockPeakR[trackIndex].load(std::memory_order_relaxed));
    }

    frame.peakDbL = linearPeakToDb(outL);
    frame.peakDbR = linearPeakToDb(outR);
    frame.peakDb  = linearPeakToDb(std::max(outL, outR));
    if (frame.truePeakDb < frame.peakDb)
        frame.truePeakDb = frame.peakDb;
    return frame;
}

MeterFrame AudioEngine::consumeBusMeterInterval(size_t busIndex) {
    MeterFrame frame;
    if (busIndex < busMeters.size() && busMeters[busIndex] != nullptr)
        (void)busMeters[busIndex]->read(frame);

    float peakL = 0.0f;
    float peakR = 0.0f;
    if (busIndex < busPeakIntervalCount && busPeakIntervalMaxL && busPeakIntervalMaxR) {
        peakL = busPeakIntervalMaxL[busIndex].exchange(0.0f, std::memory_order_relaxed);
        peakR = busPeakIntervalMaxR[busIndex].exchange(0.0f, std::memory_order_relaxed);
    }

    // See consumeClickMeterInterval: impulse latch OR the last rendered
    // block, whichever is louder. Stateless on this side, so it does not
    // matter which publish path calls it or how often.
    float outL = peakL;
    float outR = peakR;
    if (busIndex < busPeakIntervalCount && busLastBlockPeakL && busLastBlockPeakR) {
        outL = std::max(peakL, busLastBlockPeakL[busIndex].load(std::memory_order_relaxed));
        outR = std::max(peakR, busLastBlockPeakR[busIndex].load(std::memory_order_relaxed));
    }

    // What a bar is driven by, measured inside the audio thread every 64
    // samples. Draining the ring here is also what keeps it from wrapping.
    if (busIndex < busEnvelopeRings.size() && busEnvelopeRings[busIndex] != nullptr
        && busIndex < busLastPeak.size()) {
        const MeterEnvelopePoint& p =
            drainEnvelope(*busEnvelopeRings[busIndex], busLastPeak[busIndex]);
        frame.intervalPeakDbL = linearPeakToDb(p.peakL);
        frame.intervalPeakDbR = linearPeakToDb(p.peakR);
    }
    // Interval peaks win for display needles; keep LUFS/truePeak from the
    // latest LoudnessMeter frame for sustained program material.
    frame.peakDbL = linearPeakToDb(outL);
    frame.peakDbR = linearPeakToDb(outR);
    frame.peakDb = linearPeakToDb(std::max(outL, outR));
    if (frame.truePeakDb < frame.peakDb)
        frame.truePeakDb = frame.peakDb;
    return frame;
}

const std::string& AudioEngine::busNameAt(size_t index) const {
    static const std::string kMain = "Main";
    static const std::string kEmpty;
    const Project& proj = loader.project();
    if (index == 0)
        return proj.main.name.empty() ? kMain : proj.main.name;
    const size_t si = index - 1;
    if (si >= proj.sends.size())
        return kEmpty;
    return proj.sends[si].name.empty() ? proj.sends[si].id : proj.sends[si].name;
}

const TrackDef* AudioEngine::trackDefAt(size_t index) const {
    if (!projectLoaded)
        return nullptr;
    const auto& trks = loader.project().tracks;
    if (index < trks.size())
        return &trks[index];
    return nullptr;
}

TrackDef* AudioEngine::trackDefAt(size_t index) {
    return const_cast<TrackDef*>(static_cast<const AudioEngine*>(this)->trackDefAt(index));
}

const TrackDef* AudioEngine::trackDefInSong(size_t songIndex, size_t trackIndex) const {
    (void)songIndex;
    return trackDefAt(trackIndex);
}

TrackDef* AudioEngine::trackDefInSong(size_t songIndex, size_t trackIndex) {
    (void)songIndex;
    return trackDefAt(trackIndex);
}

bool AudioEngine::isBusMuted(size_t busIndex) const {
    const Project& proj = loader.project();
    if (busIndex == 0)
        return proj.main.mute;
    const size_t si = busIndex - 1;
    if (si < proj.sends.size())
        return proj.sends[si].mute;
    return busIndex < busMuted.size() && busMuted[busIndex];
}

bool AudioEngine::isBusSoloed(size_t busIndex) const {
    const Project& proj = loader.project();
    if (busIndex == 0)
        return proj.main.solo;
    const size_t si = busIndex - 1;
    return si < proj.sends.size() && proj.sends[si].solo;
}

bool AudioEngine::isBusSoloSafe(size_t busIndex) const {
    const Project& proj = loader.project();
    if (busIndex == 0)
        return proj.main.soloSafe;
    const size_t si = busIndex - 1;
    return si < proj.sends.size() && proj.sends[si].soloSafe;
}

bool AudioEngine::isClickSoloSafe() const {
    return loader.project().click.soloSafe;
}

double AudioEngine::busGainDb(size_t busIndex) const {
    const Project& proj = loader.project();
    if (busIndex == 0)
        return proj.main.gainDb;
    const size_t si = busIndex - 1;
    if (si >= proj.sends.size())
        return 0.0;
    return proj.sends[si].gainDb;
}

double AudioEngine::currentSongLengthSeconds() const {
    if (currentSampleRate <= 0.0 || currentSongLengthFrames <= 0)
        return 0.0;
    return static_cast<double>(currentSongLengthFrames) / currentSampleRate;
}

double AudioEngine::regionEffectiveDurationSeconds(const Region& r) const {
    if (r.durationSeconds > 0.0)
        return r.durationSeconds;
    // Deliberately NOT cachedPeaksForFile(): that locks peakCacheMutex, and
    // this runs on the audio thread. See peakDurationsByFile in
    // AudioEngineMembers.h for what that cost us.
    const auto durations = std::atomic_load(&peakDurationsByFile);
    if (durations == nullptr)
        return 0.0;
    const auto it = durations->find(r.source.file);
    return it != durations->end() ? it->second : 0.0;
}

void AudioEngine::updateRegionWindow(const Region& r) {
    streaming.updateRegionWindow(r, currentSampleRate);
}

void AudioEngine::resyncStreamingWindowsForCurrentSong() {
    if (!projectLoaded || currentSong >= loader.project().songs.size())
        return;
    const SongDef& song = loader.project().songs[currentSong];
    for (const Region& r : song.regions)
        updateRegionWindow(r);
}

bool AudioEngine::undoTimelineEdit(std::string& appliedLabel) {
    appliedLabel = projectHistory.undoLabel();
    auto restored = projectHistory.undo();
    if (!restored.has_value())
        return false;
    // History stores whole Project values. Keep the callback out until both
    // the new document storage and its graph/event arrays are published.
    ProjectReplacementScope replacement(*this, false);
    loader.project() = std::move(*restored);
    resyncStreamingWindowsForCurrentSong();
    syncTransportCycleFromProject();
    rebuildBussesFromProject();
    markDirty();
    return true;
}

bool AudioEngine::redoTimelineEdit(std::string& appliedLabel) {
    appliedLabel = projectHistory.redoLabel();
    auto restored = projectHistory.redo();
    if (!restored.has_value())
        return false;
    ProjectReplacementScope replacement(*this, false);
    loader.project() = std::move(*restored);
    resyncStreamingWindowsForCurrentSong();
    syncTransportCycleFromProject();
    rebuildBussesFromProject();
    markDirty();
    return true;
}

double AudioEngine::songAuthoredDurationSeconds(const SongDef& song) const {
    double maxEnd = 0.0;
    for (const Region& r : song.regions)
        maxEnd = std::max(maxEnd, r.startSeconds + regionEffectiveDurationSeconds(r));
    return maxEnd;
}

double AudioEngine::globalPlayheadSeconds() const {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1))
        return 0.0;
    const Project& proj = loader.project();
    double offset = 0.0;
    for (size_t i = 0; i < currentSong && i < proj.songs.size(); ++i)
        offset += songAuthoredDurationSeconds(proj.songs[i]);
    return offset + clock.currentSeconds();
}

double AudioEngine::globalBeatsElapsed() const {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1) || currentSong >= loader.project().songs.size())
        return 0.0;
    const Project& proj = loader.project();
    double beats = 0.0;
    for (size_t i = 0; i < currentSong; ++i)
        beats += songAuthoredDurationSeconds(proj.songs[i]) * (proj.songs[i].bpm / 60.0);
    beats += clock.currentSeconds() * (proj.songs[currentSong].bpm / 60.0);
    return beats;
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device) {
    const double newSampleRate = device->getCurrentSampleRate();
    const bool rateChanged = projectLoaded && currentSampleRate > 0.0
                              && std::abs(newSampleRate - currentSampleRate) > 1e-6;
    // Capture before mutating currentSampleRate/clock -- this is the position
    // to resume from once everything below is re-armed at the new rate.
    const double previousPlayheadSeconds = clock.currentSeconds();

    currentSampleRate = newSampleRate;
    currentBlockSize = device->getCurrentBufferSizeSamples();
    // What the device says it will take to actually play what we hand it.
    //
    // JUCE 9's CoreAudio backend already sums the four parts that matter --
    // device latency, the driver's safety offset, the stream's own latency and
    // the IO buffer -- so there is no need to go behind it to the HAL, and
    // asking JUCE keeps this working on the Windows and Linux backends too.
    // Read once here rather than per block: it only changes when the device
    // does, and this is the callback that says so.
    currentOutputLatencySamples.store(
        static_cast<int64_t>(std::max(0, device->getOutputLatencyInSamples())),
        std::memory_order_relaxed);

    // Re-anchor the hardware counter to where the timeline actually is, not
    // to zero.
    //
    // A device restart resets the driver's sample counter, and this used to
    // publish that zero as the engine's hardware position. MasterClock does
    // not treat that as a restart: onAudioCallback() re-anchors straight onto
    // whatever hwSamplePosition says, and audioDeviceStopped() deliberately
    // leaves the clock running -- so a callback arriving before anything else
    // re-anchors would drag the playhead toward the top of the song and kick
    // the PI loop with seconds of error.
    //
    // In practice the two paths that follow usually get there first (the
    // rate-change restage re-anchors explicitly, and a resumed transport
    // re-anchors inside play()), which is why this was a race rather than a
    // reliable fault. Closing it costs one multiply and removes the window
    // entirely -- including for a buffer-size-only restart, where nothing
    // else re-anchors anything at all.
    const int64_t resumeSample = currentSampleRate > 0.0
        ? static_cast<int64_t>(std::llround(previousPlayheadSeconds * currentSampleRate))
        : 0;
    hwSamplePosition.store(resumeSample, std::memory_order_relaxed);
    lastCallbackHostNanos = 0;

    // Ramp back in rather than resuming at full level.
    //
    // Restarting a device is a hole in the output -- CoreAudio cannot change
    // the IO buffer size on a running IOProc, so it stops calling us for as
    // long as the reconfigure takes (~100ms, measured). The hole itself is
    // unavoidable; the CLICK at its edges is not. Coming back at full level
    // on an arbitrary sample is a step discontinuity, which is what makes a
    // buffer-size change audible as a crack rather than as a brief gap, and
    // what shows up on the meters as a spike. prepareForDeviceReconfigure()
    // handles the other edge.
    underrunFadeOutRemaining = 0;
    underrunFadeOutLength = 0;
    outputHeldSilent = false;
    recoveryFadeInLength = kUnderrunFadeSamples;
    recoveryFadeInRemaining = kUnderrunFadeSamples;
    // start() also clears gamma and the integrator, which is exactly right
    // for a device that has just come back: the drift it measured against the
    // old device's clock says nothing about this one.
    if (clock.isRunning())
        clock.start(currentSampleRate, resumeSample);

    for (auto& meter : busLoudnessMeters)
        meter.prepare(currentSampleRate, 2);
    for (auto& band : trackBandMeters)
        band.prepare(currentSampleRate, 2);

    // Start a fresh timing window for this device configuration.
    //
    // The histogram's worst case is its whole point, and a worst case measured
    // against a 512-frame deadline says nothing about a rig now running at
    // 4096 -- carrying it forward would report a problem that belongs to a
    // configuration nobody is using any more.
    callbackTiming.reset();

    ensureScratchSizes();

    // Read-and-clear: whatever set this (audioDeviceStopped(), for either a
    // deliberate reconfigure or a hot-unplug fail-safe recovery) wants
    // playback resumed once this restart -- and any rate-change restage --
    // is fully applied. Handled in the SAME deferred callback as the restage
    // below (not a second, independently-scheduled callAsync) so resume
    // deterministically runs after it, rather than racing it.
    const bool shouldResume = resumeAfterDeviceRestart.exchange(false, std::memory_order_relaxed);

    const int newBlockSize = currentBlockSize;
    if (rateChanged || shouldResume || projectLoaded) {
        juce::MessageManager::callAsync(
            [this, newSampleRate, newBlockSize, previousPlayheadSeconds,
             shouldResume, rateChanged] {
                // A second device restart superseded this queued callback.
                if (std::abs(currentSampleRate - newSampleRate) > 1e-6
                    || currentBlockSize != newBlockSize)
                    return;
                if (rateChanged)
                    handleSampleRateChanged(newSampleRate,
                                            previousPlayheadSeconds,
                                            shouldResume);
                else if (shouldResume)
                    play();
                if (projectLoaded)
                    schedulePluginBankRebuild();
            });
    }
}

void AudioEngine::handleSampleRateChanged(double newSampleRate, double previousPlayheadSeconds, bool wasPlaying) {
    // currentSampleRate may have moved again since this was scheduled (rapid
    // back-to-back device restarts) -- only the callAsync for the latest
    // rate should do the work; older ones are stale no-ops.
    if (std::abs(currentSampleRate - newSampleRate) > 1e-6)
        return;
    if (!projectLoaded || currentSong >= loader.project().songs.size())
        return;

    const Project& proj = loader.project();
    const SongDef& song = proj.songs[currentSong];

    // Re-preps clickGenerator at currentSampleRate using this song's bpm/meter.
    refreshClickState();

    const int64_t newStartSample = static_cast<int64_t>(previousPlayheadSeconds * currentSampleRate);
    // audioDeviceAboutToStart already reset hwSamplePosition to 0 for this
    // restart, and the real IOProc can start calling onAudioCallback() again
    // (audio thread) concurrently with this message-thread cascade, well
    // before playing is set true again -- clock.onAudioCallback() runs
    // regardless of `playing` and would otherwise drift-correct the anchor
    // set below right back toward that stale near-zero hardware counter.
    // Same fix play() already applies for the equivalent Stop->Play gap (see
    // its comment): re-anchor hwSamplePosition to the same logical position
    // BEFORE (re)starting the clock.
    hwSamplePosition.store(newStartSample, std::memory_order_relaxed);
    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);
        clock.start(currentSampleRate, newStartSample);
        if (!wasPlaying)
            clock.stop();
    }

    // Re-stage the current song at the new device rate: StreamingEngine
    // drops and reopens its file pool whenever the requested rate differs
    // from what it has cached (see StreamingEngine::getOrOpenFile), which
    // recomputes every track/region's resample ratio -- covers a song whose
    // stems have different native sample rates from each other too, since
    // each buffer's ratio is computed independently against the new rate.
    const int64_t ringCapacityFrames = static_cast<int64_t>(currentSampleRate * kRingBufferSeconds);
    std::string stageError;
    if (!streaming.stageSong(currentSong, song, ringCapacityFrames, currentSampleRate, stageError,
                             /*primeSeconds=*/0.0, /*primeMaxWait=*/0.0,
                             wasPlaying ? &streamHandoff : nullptr)) {
        streamHandoff.store(false, std::memory_order_release);
        return;
    }
    std::string seekError;
    streaming.seekActiveSongTo(newStartSample, seekError, /*primeMaxWait=*/wasPlaying ? 0.05 : 0.0);

    // currentSongLengthFrames is in device-frame units against whatever rate
    // it was last computed at (selectSongInternal, right after its own
    // stageSong call) -- recompute it the same way now that every buffer has
    // reopened at the new rate, or play()'s "resuming past the end" clamp
    // would compare newStartSample (new-rate frames) against a stale
    // old-rate frame count.
    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);
        int64_t newSongLengthFrames = 0;
        StreamingEngine::ActiveSongHandle activeSong = streaming.acquireActiveSong();
        if (activeSong) {
            for (const std::string& trackId : trackIdByIndex) {
                if (StreamingTrackBuffer* buf = activeSong.track(trackId))
                    newSongLengthFrames = std::max(newSongLengthFrames, buf->totalFrames());
            }
        }
        const auto& songs = loader.project().songs;
        double authoredEnd = 0.0;
        if (currentSong < songs.size()) {
            const auto& sDef = songs[currentSong];
            authoredEnd = sDef.endSeconds;
            double maxContentSec = 0.0;
            for (const auto& r : sDef.regions)
                maxContentSec = std::max(maxContentSec, r.startSeconds + r.durationSeconds);
            const double bpm = sDef.bpm > 0.0 ? sDef.bpm : 120.0;
            for (const auto& mr : sDef.midiRegions) {
                const double mrEndSec = ((mr.startBeats + mr.durationBeats) * 60.0) / bpm;
                maxContentSec = std::max(maxContentSec, mrEndSec);
            }
            for (const auto& sec : sDef.sections)
                maxContentSec = std::max(maxContentSec, sec.startSeconds);
            for (const auto& ev : sDef.events)
                maxContentSec = std::max(maxContentSec, ev.timeSeconds);
            for (const auto& lc : sDef.lightCues)
                maxContentSec = std::max(maxContentSec, lc.startSeconds + lc.durationSeconds);
            if (maxContentSec > 0.0 && currentSampleRate > 0.0)
                newSongLengthFrames = std::max(newSongLengthFrames, static_cast<int64_t>(std::llround(maxContentSec * currentSampleRate)));
        }
        currentSongLengthFrames =
            songLengthFrames(authoredEnd, newSongLengthFrames, currentSampleRate);
    }

    // Resume transport now that the restage is fully applied -- play()
    // itself re-reads clock.currentSamplePosition(), which clock.start()
    // above already set to newStartSample, so this continues from the
    // preserved position rather than wherever it happened to be mid-restage.
    if (wasPlaying)
        play();
}

int AudioEngine::prepareForDeviceReconfigure() {
    // Arm the same fade the underrun path uses, and tell the caller how long
    // to let the audio thread run before it pulls the device out from under
    // it. Called from the message thread for a DELIBERATE reconfigure (buffer
    // size, sample rate, output device) -- a hot-unplug gets no warning and
    // no fade, which is exactly why one sounds worse than the other.
    underrunFadeOutLength = kUnderrunFadeSamples;
    underrunFadeOutRemaining = kUnderrunFadeSamples;
    if (currentSampleRate <= 0.0)
        return 0;
    // The ramp plus one block, so the faded-to-zero samples have actually
    // been handed to the driver before it stops.
    const double rampMs = 1000.0 * kUnderrunFadeSamples / currentSampleRate;
    const double blockMs = 1000.0 * std::max(1, currentBlockSize) / currentSampleRate;
    return static_cast<int>(std::ceil(rampMs + blockMs));
}

void AudioEngine::audioDeviceStopped() {
    // Deliberately does NOT stop MasterClock: this callback fires when the
    // underlying device is torn down (e.g. a hot-unplug), which is exactly
    // the case checkForDeviceLoss() is watching for via the paired
    // AudioDeviceManager change notification -- the timeline should keep
    // advancing through that gap. An explicit user Stop goes through the
    // public stop() method instead, which does stop the clock.
    //
    // Capture whether transport was live BEFORE clearing it -- this is what
    // audioDeviceAboutToStart uses to resume playback once the device (and
    // any rate-change restage) is back up, so a deliberate device
    // reconfiguration (or a hot-unplug recovery) doesn't silently leave a
    // live performer paused.
    resumeAfterDeviceRestart.store(playing.load(std::memory_order_acquire), std::memory_order_relaxed);
    playing.store(false, std::memory_order_release);
}

void AudioEngine::audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                                     int numInputChannels,
                                                     float* const* outputChannelData,
                                                     int numOutputChannels,
                                                     int numSamples,
                                                     const juce::AudioIODeviceCallbackContext& context) {
    audioCallbacksInFlight.fetch_add(1);
    struct CallbackFlight {
        std::atomic<uint32_t>& count;
        ~CallbackFlight() { count.fetch_sub(1); }
    } callbackFlight{audioCallbacksInFlight};

    // Structural edits and relocates may make a bounded early return below
    // the safest choice for this block. Fade the last real sample to zero
    // instead of turning that one missed block into an audible discontinuity;
    // the normal post-render fade path gently restores gain on the next good
    // block. All storage is prepared before the callback.
    const auto declickSilentBlock = [this, outputChannelData,
                                     numOutputChannels, numSamples]() noexcept {
        const int rampSamples = std::min(numSamples, kUnderrunFadeSamples);
        for (int ch = 0; ch < numOutputChannels; ++ch) {
            float* output = outputChannelData != nullptr ? outputChannelData[ch] : nullptr;
            if (output == nullptr)
                continue;
            const float previous = static_cast<size_t>(ch) < lastOutputSample.size()
                ? lastOutputSample[static_cast<size_t>(ch)] : 0.0f;
            for (int sample = 0; sample < rampSamples; ++sample) {
                const float gain = rampSamples <= 1 ? 0.0f
                    : 1.0f - static_cast<float>(sample)
                        / static_cast<float>(rampSamples - 1);
                output[sample] = previous * gain;
            }
            if (numSamples > rampSamples)
                std::fill(output + rampSamples, output + numSamples, 0.0f);
            if (static_cast<size_t>(ch) < lastOutputSample.size())
                lastOutputSample[static_cast<size_t>(ch)] = 0.0f;
        }
        underrunFadeOutRemaining = 0;
        recoveryFadeInLength = kUnderrunFadeSamples;
        recoveryFadeInRemaining = kUnderrunFadeSamples;
        outputHeldSilent = false;
    };

    if (projectTransitioning.load()) {
        declickSilentBlock();
        systemHealth.noteSilentBlock();
        return;
    }

    // Flush-to-zero for the whole callback. Everything downstream of a strip is
    // a recursive filter -- the fader/pan glide, the K-weighting stages, the six
    // band-pass biquads per meter point -- and every one of them decays into
    // denormals the moment its input goes quiet (a muted track, the gap between
    // songs, a send nobody is feeding). Denormal arithmetic traps to microcode
    // on x86 and is slow enough on some cores to turn a comfortable block into a
    // dropout, and it happens exactly when the mix is quiet, which is when
    // nobody expects a glitch. The values involved are below -700 dBFS, so
    // rounding them to zero is inaudible by many orders of magnitude.
    const juce::ScopedNoDenormals noDenormals;

    // Time the WHOLE callback, including every early return.
    //
    // Two clocks, because their gap is the diagnosis: wall time says how long
    // this took, thread CPU time says how much of that we spent actually
    // running. A block that burns its deadline on a core and a block that
    // spends it waiting for one look identical in every other number the app
    // has -- and they need opposite fixes. See
    // engine/telemetry/CallbackTiming.h.
    //
    // An RAII scope rather than a call at the end: this function returns from
    // a dozen places (handoff, missing graph, unprepared renderer), and the
    // interesting callbacks are exactly the ones that bail early.
    struct CallbackTimer {
        CallbackTimingHistogram& into;
        double startWallMs;
        double startCpuMs;
        double deadlineMs;
        bool enabled;
        ~CallbackTimer() {
            if (!enabled)
                return;
            const double endWallMs =
                static_cast<double>(SystemMonotonicClock{}.nowNanos()) / 1.0e6;
            into.record(endWallMs - startWallMs, currentThreadCpuMillis() - startCpuMs,
                        deadlineMs);
        }
    } callbackTimer{callbackTiming,
                    static_cast<double>(SystemMonotonicClock{}.nowNanos()) / 1.0e6,
                    currentThreadCpuMillis(),
                    currentSampleRate > 0.0
                        ? 1000.0 * static_cast<double>(numSamples) / currentSampleRate
                        : 0.0,
                    !gRenderingExactCycleSegment};

    for (int ch = 0; ch < numOutputChannels; ++ch)
        if (outputChannelData[ch] != nullptr)
            std::fill(outputChannelData[ch], outputChannelData[ch] + numSamples, 0.0f);

    // Debug-only manual stall injection -- see simulateUnderrun()'s doc comment.
    const double stallMs = simulatedStallMs.exchange(0.0, std::memory_order_acq_rel);
    if (stallMs > 0.0)
        std::this_thread::sleep_for(std::chrono::duration<double, std::milli>(stallMs));

    // JUCE's CoreAudio backend sets context.hostTimeNs to point directly at
    // AudioTimeStamp::mHostTime -- despite the name, that's raw
    // mach_absolute_time() TICKS, not nanoseconds (see juce_CoreAudio_mac.cpp,
    // `AudioIODeviceCallbackContext context { inNow != nullptr ? &inNow->mHostTime : nullptr }`).
    // Using it unconverted here corrupted MasterClock's elapsed-time math by
    // the timebase ratio (~41.7x observed), which rockets the playhead
    // billions of samples ahead within the first couple of callbacks and
    // immediately trips the song-end-reached check -- i.e. "press Play, it
    // jumps to some timestamp and stops instantly, nothing audible plays".
    const uint64_t baseHostTimeNanos = (context.hostTimeNs != nullptr)
                                            ? SystemMonotonicClock::ticksToNanos(*context.hostTimeNs)
                                            : SystemMonotonicClock{}.nowNanos();
    const uint64_t hostTimeNanos = baseHostTimeNanos + gExactCycleHostOffsetNanos;

    // Stop/seek clears are requested by the control thread, but the active
    // note counters and project track layout are owned by the audio callback.
    // Service them only after a successful non-waiting lock; if a structural
    // edit currently owns it, leave the request pending for the next block.
    if (activeMidiNotesClearRequested.load(std::memory_order_acquire)) {
        std::unique_lock<std::recursive_mutex> clearLock(
            routingMutex, std::try_to_lock);
        if (clearLock.owns_lock()
            && activeMidiNotesClearRequested.exchange(
                false, std::memory_order_acq_rel)) {
            const int64_t effectiveLatency =
                currentOutputLatencySamples.load(std::memory_order_relaxed)
                + currentPluginLatencySamples.load(std::memory_order_relaxed);
            const double outputLatencySec = resostage::outputLatencySeconds(
                effectiveLatency, currentSampleRate);
            clearActiveMidiNotes(heardHostNanos(hostTimeNanos, 0.0,
                                                outputLatencySec));
        }
    }

    // A message-thread seek is intrinsically the wrong primitive for a cycle:
    // it waits for a later UI tick, parks stream reads and requests a global
    // all-notes-off. That is audible as a seam, truncates a held live-MIDI
    // note, and can never be sample-exact. Once the cycle material is resident
    // (the resident worker is prioritised when the locator is enabled), split
    // THIS device block at the exact sample instead. Both children use the
    // usual renderer, so plug-ins, MIDI regions and the click see a genuine
    // [left, right) timeline rather than a visual-only playhead jump.
    const bool mayRenderExactCycle =
        !gRenderingExactCycleSegment
        && numSamples > 0
        && numInputChannels >= 0
        && numOutputChannels >= 0
        && numInputChannels <= static_cast<int>(kMaxSupportedOutputChannels)
        && numOutputChannels <= static_cast<int>(kMaxSupportedOutputChannels)
        && currentSampleRate > 0.0
        && clock.isRunning()
        && playing.load(std::memory_order_acquire)
        && cycleActive.load(std::memory_order_relaxed)
        && !cycleSkip.load(std::memory_order_relaxed)
        && streaming.activeSongFullyResident();
    if (mayRenderExactCycle) {
        double leftSec = cycleLeftSec.load(std::memory_order_relaxed);
        double rightSec = cycleRightSec.load(std::memory_order_relaxed);
        if (rightSec < leftSec)
            std::swap(leftSec, rightSec);
        const int64_t leftSample = static_cast<int64_t>(std::llround(leftSec * currentSampleRate));
        const int64_t rightSample = static_cast<int64_t>(std::llround(rightSec * currentSampleRate));
        const int64_t cycleLength = rightSample - leftSample;
        const int64_t blockStart = hwSamplePosition.load(std::memory_order_relaxed);

        if (cycleLength > 0 && blockStart >= rightSample) {
            // A locator can be enabled or edited while the clock is already
            // past its right edge. Normalise before rendering, preserving the
            // overshoot rather than accumulating a frame of drift per lap.
            const int64_t wrapped = wrapCycleSample(blockStart, leftSample, rightSample);
            std::array<const float*, kMaxSupportedOutputChannels> in{};
            std::array<float*, kMaxSupportedOutputChannels> out{};
            for (int ch = 0; ch < numInputChannels; ++ch)
                in[static_cast<size_t>(ch)] = inputChannelData != nullptr ? inputChannelData[ch] : nullptr;
            for (int ch = 0; ch < numOutputChannels; ++ch)
                out[static_cast<size_t>(ch)] = outputChannelData != nullptr ? outputChannelData[ch] : nullptr;

            hwSamplePosition.store(wrapped, std::memory_order_relaxed);
            clock.start(currentSampleRate, wrapped);
            lastCallbackHostNanos = 0;
            sequencedMidiFlushAtBlockStart = true;
            systemHealth.noteAudioCallback();
            gRenderingExactCycleSegment = true;
            gExactCycleSegmentOrdinal = 0;
            gExactCycleRootSamples = numSamples;
            gExactCycleHostOffsetNanos = 0;
            audioDeviceIOCallbackWithContext(in.data(), numInputChannels, out.data(),
                                             numOutputChannels, numSamples, context);
            gRenderingExactCycleSegment = false;
            gExactCycleRootSamples = 0;
            gExactCycleHostOffsetNanos = 0;
            lastCallbackHostNanos = baseHostTimeNanos;
            return;
        }

        const int64_t blockEnd = blockStart + numSamples;
        if (cycleLength > 0 && blockStart < rightSample && blockEnd > rightSample) {
            const int firstSamples = static_cast<int>(rightSample - blockStart);
            const int secondSamples = numSamples - firstSamples;
            std::array<const float*, kMaxSupportedOutputChannels> firstIn{};
            std::array<const float*, kMaxSupportedOutputChannels> secondIn{};
            std::array<float*, kMaxSupportedOutputChannels> firstOut{};
            std::array<float*, kMaxSupportedOutputChannels> secondOut{};
            for (int ch = 0; ch < numInputChannels; ++ch) {
                const float* input = inputChannelData != nullptr ? inputChannelData[ch] : nullptr;
                firstIn[static_cast<size_t>(ch)] = input;
                secondIn[static_cast<size_t>(ch)] = input != nullptr ? input + firstSamples : nullptr;
            }
            for (int ch = 0; ch < numOutputChannels; ++ch) {
                float* output = outputChannelData != nullptr ? outputChannelData[ch] : nullptr;
                firstOut[static_cast<size_t>(ch)] = output;
                secondOut[static_cast<size_t>(ch)] = output != nullptr ? output + firstSamples : nullptr;
            }

            // First render ends at `rightSample` (exclusive); reset the
            // hardware-domain transport to the left locator and render the
            // remainder immediately into the latter part of the same driver
            // buffer. No stream handoff, async task or silence is involved.
            hwSamplePosition.store(blockStart, std::memory_order_relaxed);
            systemHealth.noteAudioCallback();
            gRenderingExactCycleSegment = true;
            gExactCycleSegmentOrdinal = 0;
            gExactCycleRootSamples = numSamples;
            gExactCycleHostOffsetNanos = 0;
            audioDeviceIOCallbackWithContext(firstIn.data(), numInputChannels, firstOut.data(),
                                             numOutputChannels, firstSamples, context);
            hwSamplePosition.store(leftSample, std::memory_order_relaxed);
            clock.start(currentSampleRate, leftSample);
            lastCallbackHostNanos = 0;
            sequencedMidiFlushAtBlockStart = true;
            gExactCycleSegmentOrdinal = 1;
            gExactCycleHostOffsetNanos = static_cast<uint64_t>(std::llround(
                (static_cast<double>(firstSamples) / currentSampleRate) * 1.0e9));
            audioDeviceIOCallbackWithContext(secondIn.data(), numInputChannels, secondOut.data(),
                                             numOutputChannels, secondSamples, context);
            gRenderingExactCycleSegment = false;
            gExactCycleRootSamples = 0;
            gExactCycleHostOffsetNanos = 0;
            lastCallbackHostNanos = baseHostTimeNanos;
            return;
        }
    }

    // Sample-accurate render playhead for THIS block. Driven by the free-run
    // hardware counter (incremented once per callback while the transport
    // clock is running), NOT by MasterClock's wall-clock free-run projection.
    // Using the wall-clock value here used to let WAV reads and the built-in
    // click diverge under PI-loop gamma corrections / host-time jitter --
    // the click is pure math on playheadSample while stems come from disk at
    // the same index, so they must share a single, sample-locked position.
    // MasterClock still tracks wall-clock for UI/MIDI fail-safe telemetry.
    int64_t renderPlayheadSample = clock.currentSamplePosition();
    const bool clockRunning = clock.isRunning();
    if (clockRunning) {
        // Only advance the free-run hardware counter while the transport
        // clock is running. Free-running across Stop / the gapless song-end
        // hold raced a concurrent message-thread store(0)+start(0) and
        // re-anchored song B's playhead to a multi-million-sample value.
        const int64_t hwPos = hwSamplePosition.fetch_add(numSamples, std::memory_order_relaxed);
        clock.onAudioCallback(hostTimeNanos, hwPos);
        renderPlayheadSample = hwPos;
    }

    if (!gRenderingExactCycleSegment)
        systemHealth.noteAudioCallback();
    // Underrun heuristic: gap between consecutive callbacks more than 2.5x the
    // expected block duration (or an explicit simulateUnderrun stall).
    // Skip while the transport clock is stopped -- gapless handoff deliberately
    // parks the clock for a few blocks and must not look like a dropout.
    bool underrunThisCallback = false;
    const bool measureCallbackGap =
        !gRenderingExactCycleSegment || gExactCycleSegmentOrdinal == 0;
    if (measureCallbackGap && clockRunning && lastCallbackHostNanos != 0
        && currentSampleRate > 0.0 && numSamples > 0) {
        const int deadlineSamples = gRenderingExactCycleSegment
            ? gExactCycleRootSamples : numSamples;
        const double expectedNs =
            (static_cast<double>(deadlineSamples) / currentSampleRate) * 1.0e9;
        const double gapNs = static_cast<double>(hostTimeNanos - lastCallbackHostNanos);
        if (gapNs > expectedNs * 2.5 || stallMs > 0.0) {
            systemHealth.noteUnderrun();
            underrunThisCallback = true;
            underrunFadeOutLength = kUnderrunFadeSamples;
            underrunFadeOutRemaining = kUnderrunFadeSamples;
        }
    }
    // After an underrun gap, start a short fade-in so recovery isn't a click.
    if (measureCallbackGap) {
        if (lastCallbackWasUnderrun && !underrunThisCallback) {
            outputHeldSilent = false;
            recoveryFadeInLength = kUnderrunFadeSamples;
            recoveryFadeInRemaining = kUnderrunFadeSamples;
        }
        lastCallbackWasUnderrun = underrunThisCallback;
        if (clockRunning)
            lastCallbackHostNanos = hostTimeNanos;
    }

    // Telemetry prefers the sample-accurate render position while playing so
    // the UI playhead tracks the actual audio, not a wall-clock estimate.
    // Does the callback's host timestamp share an epoch with the clock every
    // scheduler in the app reads?
    //
    // Everything time-critical assumes it does: MIDI packets are handed to
    // CoreMIDI stamped with it, and DMX and HTTP triggers are held against it
    // until due. If the two ever drift apart -- a different backend, a
    // platform where JUCE hands back a different quantity under the same name
    // -- cues would fire at an arbitrary moment with nothing to point at. One
    // relaxed store per callback buys a number that says so out loud. It reads
    // about -0.1 ms here.
    hostTimeSkewNanos.store(static_cast<int64_t>(hostTimeNanos)
                                - static_cast<int64_t>(SystemMonotonicClock{}.nowNanos()),
                            std::memory_order_relaxed);

    const int64_t telemetrySamples = clockRunning ? renderPlayheadSample : clock.currentSamplePosition();
    const double telemetrySeconds = (currentSampleRate > 0.0)
                                        ? static_cast<double>(telemetrySamples) / currentSampleRate
                                        : clock.currentSeconds();
    transportTelemetry.playheadSamples.store(telemetrySamples, std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(telemetrySeconds, std::memory_order_relaxed);
    transportTelemetry.sampleRate.store(clock.sampleRate(), std::memory_order_relaxed);
    transportTelemetry.driftFactor.store(clock.driftFactor(), std::memory_order_relaxed);
    transportTelemetry.running.store(playing.load(std::memory_order_relaxed), std::memory_order_relaxed);

    if (flushPauseTailRequested.exchange(false, std::memory_order_acq_rel)) {
        pauseTailRemainingSamples = 0;
        pauseTailSilenceBlocks = 0;
    }

    const auto pluginPub =
        std::atomic_load_explicit(&activePluginBank, std::memory_order_acquire);
    const bool bankHasPlugins = pluginPub != nullptr
        && pluginPub->projectEpoch == projectEpoch.load(std::memory_order_acquire)
        && pluginPub->bank != nullptr && pluginPub->bank->hasPlugins();

    const bool isPlaying = playing.load(std::memory_order_acquire);
    if (isPlaying) {
        wasPlayingLastCallback = true;
        pauseTailRemainingSamples = 0;
        pauseTailSilenceBlocks = 0;
    } else if (wasPlayingLastCallback) {
        wasPlayingLastCallback = false;
        // Transport just paused: arm the pause tail so active reverb/delay
        // buffers can decay naturally through the MixGraph rather than cutting
        // off abruptly.
        const double tailSec = bankHasPlugins
            ? std::clamp(pluginPub->bank->tailSeconds(), 4.0, 15.0)
            : 4.0;
        pauseTailRemainingSamples = (currentSampleRate > 0.0)
            ? static_cast<int64_t>(std::llround(tailSec * currentSampleRate))
            : static_cast<int64_t>(48000 * 4);
        pauseTailSilenceBlocks = 0;
    }

    const bool isRenderingTail = !isPlaying && (pauseTailRemainingSamples > 0
        || bankHasPlugins
        || hardAllSoundOffRequested.load(std::memory_order_acquire));
    const bool hasLiveMonitoring = (activeInputMonitoringCount.load(std::memory_order_relaxed) > 0 ||
                                    activeRecordArmCount.load(std::memory_order_relaxed) > 0 ||
                                    focusedMidiMonitorActive.load(std::memory_order_relaxed));

    if (!isPlaying && !isRenderingTail && !hasLiveMonitoring) {
        // Declick tail: the first silent callback right after transport stops
        // ramps the last real output sample on each channel down to zero
        // instead of a hard cut -- see kStopDeclickSamples' doc comment.
        if (stopDeclickRemaining > 0) {
            const int declickSamples = std::min(numSamples, stopDeclickRemaining);
            for (int ch = 0; ch < numOutputChannels; ++ch) {
                if (outputChannelData[ch] == nullptr)
                    continue;
                const float start = (static_cast<size_t>(ch) < lastOutputSample.size())
                                        ? lastOutputSample[static_cast<size_t>(ch)]
                                        : 0.0f;
                for (int i = 0; i < declickSamples; ++i) {
                    const int remaining = stopDeclickRemaining - i;
                    const float g = static_cast<float>(remaining)
                                     / static_cast<float>(kStopDeclickSamples);
                    outputChannelData[ch][i] = start * g;
                }
            }
            stopDeclickRemaining -= declickSamples;
        }

        // See metersSilencedSinceStop's doc comment: without this, meters
        // hold their last playing-state value forever instead of dropping to
        // silence once transport stops.
        if (!metersSilencedSinceStop) {
            const MeterFrame silent{};
            for (auto& m : trackMeters)
                if (m != nullptr)
                    m->write(silent);
            for (auto& band : trackBandMeters)
                band.reset();
            for (size_t i = 0; i < busMeters.size(); ++i) {
                if (i < busLoudnessMeters.size())
                    busLoudnessMeters[i].reset();
                if (busMeters[i] != nullptr)
                    busMeters[i]->write(silent);
            }
            clickMeterFrame.write(silent);

            // The envelope trajectory needs the same treatment, and it has to
            // happen HERE rather than in resetMetersSilent().
            //
            // A drain that finds nothing holds its last value -- that is what
            // lets a needle survive the polls that land between callbacks at a
            // big buffer. Once the transport stops, though, nothing is
            // published ever again, so "hold" becomes "freeze": the needle
            // parks at whatever was playing when Stop was pressed.
            //
            // resetMetersSilent() does clear the rings, but it runs on the
            // message thread and cannot win the race against a block already
            // in flight -- that block's points land after the clear, the next
            // poll drains them, and the frozen value comes straight back.
            // Which is why it froze only SOMETIMES.
            //
            // Pushing the silence from the audio thread closes it: there is
            // one audio thread, so the last-block points and this zero are
            // strictly ordered, and the drain takes the last point.
            // Disown anything still queued before saying silence, or the
            // drain that follows takes the loudest of a late block and this
            // zero -- and picks the late block.
            for (auto& ring : busEnvelopeRings) {
                if (ring != nullptr) {
                    ring->discardQueued();
                    ring->push(MeterEnvelopePoint{});
                }
            }
            clickEnvelopeRing.discardQueued();
            clickEnvelopeRing.push(MeterEnvelopePoint{});

            metersSilencedSinceStop = true;
        }
        // Keep this live even while stopped. The underrun check above
        // already skips itself while !clockRunning, so it wouldn't fire
        // *now* either way -- but if left stale from before Stop/Pause,
        // the gap computed on the very first callback after Play resumes
        // would span the *entire pause*, tripping a false underrun the
        // Publish current transport with project BPM, time signature, and playhead
        // even while stopped so hosted plug-ins (and their open UI editors) receive
        // the project's tempo and time signature.
        const auto stoppedPluginBank =
            std::atomic_load_explicit(&activePluginBank,
                                      std::memory_order_relaxed);
        if (stoppedPluginBank != nullptr
            && stoppedPluginBank->projectEpoch == projectEpoch.load(std::memory_order_acquire)
            && stoppedPluginBank->bank != nullptr) {
            PluginTransportState pluginTransport;
            pluginTransport.sample = renderPlayheadSample;
            pluginTransport.sampleRate = currentSampleRate;
            pluginTransport.playing = false;
            pluginTransport.hostTimeNanos = hostTimeNanos;
            const Project& proj = loader.project();
            if (currentSong < proj.songs.size()) {
                const auto& transportSong = proj.songs[currentSong];
                pluginTransport.bpm = transportSong.bpm;
                pluginTransport.numerator = transportSong.timeSignature.numerator;
                pluginTransport.denominator = transportSong.timeSignature.denominator;
            }
            stoppedPluginBank->bank->publishTransport(pluginTransport);
        }

        lastCallbackHostNanos = hostTimeNanos;
        return;
    }
    metersSilencedSinceStop = false;

    // Every `return` from here on leaves the output buffers as the zeroes they
    // were filled with at the top -- i.e. it emits a whole block of silence
    // into a playing show. The driver was serviced on time, so none of this
    // shows up as an underrun; it is only audible, as a crackle. Counting them
    // is the difference between "the health panel says 0 underruns" and
    // knowing the outputs actually went quiet 40 times while a fader moved.
    const auto bailSilently = [this, &declickSilentBlock]() noexcept {
        declickSilentBlock();
        systemHealth.noteSilentBlock();
    };

    // Gapless / restage handoff: keep outs silent and do not touch rings
    // until the message thread has reset the playhead to match the new song.
    if (streamHandoff.load(std::memory_order_acquire)) {
        bailSilently();
        return;
    }

    // The whole mix for this block runs against ONE graph, held alive by this
    // shared_ptr for as long as the callback needs it. The message thread may
    // republish meanwhile; that only swaps what the NEXT block acquires, so a
    // knob move can never tear a half-rendered block.
    const std::shared_ptr<const MixGraph> snap = routing.acquireForRender();
    if (snap == nullptr) {
        bailSilently();
        return;
    }
    const MixGraph& graph = *snap;

    // One bank snapshot for this whole block. Compatibility is a pair of
    // scalar checks prepared off-thread: no string lookup, map walk, lock, or
    // allocation is introduced into the callback.
    const auto pluginPublication =
        std::atomic_load_explicit(&activePluginBank,
                                  std::memory_order_acquire);
    MixProcessorView pluginProcessors;
    PluginProcessorBank* compatiblePluginBank = nullptr;
    int64_t pluginLatencyForBlock = 0;
    const bool processorLayoutMatches = pluginPublication != nullptr
        && pluginPublication->processorLayoutKey == graph.processorLayoutKey;
    const bool routingLayoutMatches = pluginPublication != nullptr
        && pluginPublication->routingLayoutKey == graph.routingLayoutKey;
    if (pluginPublication != nullptr
        && pluginPublication->projectEpoch == graph.projectEpoch
        // A newly edited chain is built off-thread. Keep the previous chain
        // alive until its replacement is published, but only when the strip
        // ordered processor-strip layout still matches exactly. Project and
        // strip-layout changes remain fail-closed; a route-only change may
        // retain an identical processor table but never its stale PDC plan.
        && (processorLayoutMatches || routingLayoutMatches)
        && std::abs(pluginPublication->sampleRate - currentSampleRate) < 1e-6
        && numSamples <= pluginPublication->maximumBlockSize
        && pluginPublication->bank != nullptr) {
        const PluginDelayBank* compatibleDelayBank =
            routingLayoutMatches
                ? pluginPublication->delayBank.get() : nullptr;
        pluginProcessors = pluginPublication->bank->processorView(
            compatibleDelayBank);
        compatiblePluginBank = pluginPublication->bank.get();
        pluginLatencyForBlock = compatibleDelayBank != nullptr
            ? compatibleDelayBank->latencySamples()
            : pluginPublication->bank->latencySamples();
    }

    std::unique_lock<std::recursive_mutex> routeLock(routingMutex, std::try_to_lock);
    if (!routeLock.owns_lock()) {
        bailSilently();
        return;
    }
    if (projectTransitioning.load(std::memory_order_acquire)
        || graph.projectEpoch != projectEpoch.load(std::memory_order_acquire)) {
        bailSilently();
        return;
    }

    StreamingEngine::ActiveSongHandle activeSong;
    if (isPlaying) {
        activeSong = streaming.acquireActiveSong();
    }
    const Project& proj = loader.project();

    if (isPlaying && !activeSong && currentSong < proj.songs.size()) {
        bailSilently();
        return;
    }

    const int64_t playheadSample = renderPlayheadSample;

    if (compatiblePluginBank != nullptr) {
        if (compatiblePluginBank->consumeAllNotesOff()) {
            compatiblePluginBank->injectAllNotesOff();
        }
    }

    // A second press of the dedicated Stop button is an explicit panic.
    // Ordinary Stop/seek use Note-Off so release tails remain musical; this
    // path intentionally kills voices and resets controllers on every MIDI
    // channel, including devices whose note counters were cleared by the
    // first Stop. Keep all vendor interaction in the existing callback bank.
    if (hardAllSoundOffRequested.exchange(false, std::memory_order_acq_rel)) {
        if (compatiblePluginBank != nullptr)
            compatiblePluginBank->injectAllSoundOff();
        const double latencySec = resostage::outputLatencySeconds(
            currentOutputLatencySamples.load(std::memory_order_relaxed)
                + pluginLatencyForBlock,
            currentSampleRate);
        const uint64_t targetTime = heardHostNanos(hostTimeNanos, 0.0, latencySec);
        for (uint8_t channel = 0; channel < 16; ++channel) {
            MidiCommand command;
            command.kind = MidiCommandKind::ControlChange;
            command.channel = channel;
            command.data2 = 0;
            command.targetHostTimeNanos = targetTime;
            command.data1 = 120; // All Sound Off
            midiDispatcher.enqueue(command);
            command.data1 = 121; // Reset All Controllers
            midiDispatcher.enqueue(command);

            MidiCommand pitchReset;
            pitchReset.kind = MidiCommandKind::Raw;
            pitchReset.status = static_cast<uint8_t>(0xE0u | channel);
            pitchReset.dataLength = 2;
            pitchReset.data1 = 0;
            pitchReset.data2 = 64; // 14-bit pitch wheel centre
            pitchReset.targetHostTimeNanos = targetTime;
            midiDispatcher.enqueue(pitchReset);
        }
    }

    if (sequencedMidiFlushAtBlockStart) {
        // Release only notes emitted by MIDI regions. A blanket all-notes-off
        // here used to terminate live notes held on other focused/monitored
        // synths at every lap. These targeted offs also prevent a region note
        // whose authored end lies beyond the right locator from accumulating
        // one stuck voice (and one lit preview key) per cycle.
        const double latencySec = resostage::outputLatencySeconds(
            currentOutputLatencySamples.load(std::memory_order_relaxed)
                + pluginLatencyForBlock,
            currentSampleRate);
        for (size_t strip = 0;
             strip < kMaxActiveMidiTracks && strip < trackIdByIndex.size();
             ++strip) {
            const TrackDef* track = trackDefAt(strip);
            const bool external = track != nullptr
                && (track->kind == TrackKind::ExternalMIDI
                    || track->kind == TrackKind::MIDI);
            for (int channel = 0; channel < 16; ++channel) {
                for (int pitch = 0; pitch < 128; ++pitch) {
                    auto& count = sequencedMidiNoteCounts[strip]
                        [static_cast<size_t>(channel)][static_cast<size_t>(pitch)];
                    while (count != 0) {
                        if (compatiblePluginBank != nullptr
                            && compatiblePluginBank->stripHasInstrument(strip)) {
                            compatiblePluginBank->addStripMidiEvent(
                                strip, juce::MidiMessage::noteOff(
                                    channel + 1, pitch), 0);
                        }
                        if (external) {
                            MidiCommand cmd;
                            cmd.kind = MidiCommandKind::NoteOff;
                            cmd.channel = static_cast<uint8_t>(channel);
                            cmd.data1 = static_cast<uint8_t>(pitch);
                            cmd.data2 = 0;
                            cmd.targetHostTimeNanos = heardHostNanos(
                                hostTimeNanos, 0.0, latencySec);
                            midiDispatcher.enqueue(cmd);
                        }
                        updateActiveMidiNote(strip, pitch, false);
                        --count;
                    }
                }
            }
        }
        if (currentSong < proj.songs.size()) {
            const auto& events = proj.songs[currentSong].events;
            const double cycleLeft = cycleLeftSec.load(std::memory_order_relaxed);
            const size_t count = std::min(events.size(), eventFiredFlags.size());
            for (size_t i = 0; i < count; ++i) {
                if (!events[i].triggerOnLoad)
                    eventFiredFlags[i] = events[i].timeSeconds < cycleLeft ? 1 : 0;
            }
        }
        sequencedMidiFlushAtBlockStart = false;
    }

    if (pluginProcessors.strips != nullptr) {
        PluginTransportState pluginTransport;
        pluginTransport.sample = playheadSample;
        pluginTransport.sampleRate = currentSampleRate;
        pluginTransport.playing = isPlaying;
        pluginTransport.hostTimeNanos = hostTimeNanos;
        if (currentSong < proj.songs.size()) {
            const auto& transportSong = proj.songs[currentSong];
            pluginTransport.bpm = transportSong.bpm;
            pluginTransport.numerator = transportSong.timeSignature.numerator;
            pluginTransport.denominator = transportSong.timeSignature.denominator;
        }
        pluginTransport.looping =
            cycleActive.load(std::memory_order_relaxed)
            && !cycleSkip.load(std::memory_order_relaxed);
        if (pluginTransport.looping) {
            double loopStart = cycleLeftSec.load(std::memory_order_relaxed);
            double loopEnd = cycleRightSec.load(std::memory_order_relaxed);
            if (loopEnd < loopStart)
                std::swap(loopStart, loopEnd);
            pluginTransport.loopStartSample = static_cast<int64_t>(
                std::llround(loopStart * currentSampleRate));
            pluginTransport.loopEndSample = static_cast<int64_t>(
                std::llround(loopEnd * currentSampleRate));
        }
        pluginTransport.recording = isRecordingState.load(std::memory_order_relaxed);
        compatiblePluginBank->publishTransport(pluginTransport);
    }

    // Drain the fixed-capacity MPMC queue. MIDI may be published concurrently
    // by the hardware callback and WebServer/Electron control path; drain at
    // most one full queue per audio block so sustained producers stay bounded.
    const bool isRec = isRecordingState.load(std::memory_order_acquire);
    const int64_t recordCaptureStart = recordStartSamplePos.load(std::memory_order_relaxed);
    const bool autoPunch = autoPunchEnabledState.load(std::memory_order_relaxed);
    const int64_t punchStart = autoPunchStartSample.load(std::memory_order_relaxed);
    const int64_t punchEnd = autoPunchEndSample.load(std::memory_order_relaxed);
    const TransportMonitorPhase monitorPhase = resolveTransportMonitorPhase(
        isPlaying, isRec, autoPunch, playheadSample, playheadSample + numSamples,
        punchStart, punchEnd);
    const bool captureWindowOpen = playheadSample + numSamples > recordCaptureStart
        && (!autoPunch || playheadSample < punchEnd);
    const bool midiCaptureActive = isRec && captureWindowOpen;
    const int64_t midiCaptureSample = std::max(playheadSample, recordCaptureStart);

    for (size_t i = 0; i < kMidiQueueCapacity; ++i) {
        QueuedMidiPacket pkt;
        if (!midiInputQueue.tryPop(pkt)) break;
        if (pkt.length > 0) {
            const juce::MidiMessage msg(pkt.data, pkt.length);
            const int msgChannel = msg.getChannel();

            int liveMidiFocus = focusedTrackIndex.load(std::memory_order_relaxed);
            if (liveMidiFocus < 0 || liveMidiFocus >= static_cast<int>(trackIdByIndex.size())) {
                liveMidiFocus = -1;
            } else {
                const TrackDef* focused = trackDefAt(static_cast<size_t>(liveMidiFocus));
                if (focused == nullptr || !isMidiInputTrack(focused->kind))
                    liveMidiFocus = -1;
            }
            if (liveMidiFocus < 0) {
                for (size_t candidate = 0; candidate < trackIdByIndex.size(); ++candidate) {
                    const TrackDef* candidateDef = trackDefAt(candidate);
                    if (candidateDef != nullptr && isMidiInputTrack(candidateDef->kind)) {
                        liveMidiFocus = static_cast<int>(candidate);
                        break;
                    }
                }
            }

            bool forwardedToExternalMidi = false;
            for (size_t t = 0; t < trackIdByIndex.size() && t < trackScratch.size(); ++t) {
                const TrackDef* tDef = trackDefAt(t);
                if (tDef == nullptr) continue;
                const bool isArmed = tDef->recordArmed;
                const bool acceptsMidiInput = isMidiInputTrack(tDef->kind);
                const bool isMonitored = acceptsMidiInput && tDef->inputMonitoring;
                const bool liveNoteOn = msg.isNoteOn() && msg.getVelocity() > 0;
                const bool liveNoteOff = msg.isNoteOff()
                    || (msg.isNoteOn() && msg.getVelocity() == 0);
                const int livePitch = liveNoteOn || liveNoteOff
                    ? msg.getNoteNumber() : -1;
                const size_t liveChannel = static_cast<size_t>(
                    std::clamp(msgChannel - 1, 0, 15));
                const bool ownsLiveNote = t < kMaxActiveMidiTracks
                    && acceptsMidiInput && liveNoteOff
                    && livePitch >= 0 && livePitch < 128
                    && liveMidiNoteCounts[t][liveChannel]
                        [static_cast<size_t>(livePitch)] != 0;

                bool shouldDeliver = false;
                if (pkt.targetTrackIndex >= 0) {
                    shouldDeliver = (static_cast<int>(t) == pkt.targetTrackIndex);
                } else {
                    // Logic-style live MIDI: the focused instrument always
                    // auditions, while every explicitly armed or monitored
                    // MIDI-capable track receives the same untargeted input.
                    shouldDeliver = acceptsMidiInput
                        && (isArmed || isMonitored
                            || static_cast<int>(t) == liveMidiFocus);
                }
                // A note-off belongs to the strip that received its note-on,
                // even if focused/armed/monitor state changed in between.
                shouldDeliver = shouldDeliver || ownsLiveNote;
                if (!shouldDeliver) continue;

                if (ownsLiveNote || tDef->midiInputChannel == 0
                    || tDef->midiInputChannel == msgChannel) {
                    if (t < kMaxActiveMidiTracks && acceptsMidiInput
                        && msg.isNoteOnOrOff()) {
                        const size_t pitch = static_cast<size_t>(msg.getNoteNumber());
                        auto& count = liveMidiNoteCounts[t][liveChannel][pitch];
                        if (liveNoteOn) {
                            if (count < std::numeric_limits<uint8_t>::max()) ++count;
                            updateActiveMidiNote(t, static_cast<int>(pitch), true);
                        } else if (liveNoteOff && count != 0) {
                            --count;
                            updateActiveMidiNote(t, static_cast<int>(pitch), false);
                        }
                    }
                    if (compatiblePluginBank != nullptr) {
                        compatiblePluginBank->addStripMidiEvent(static_cast<uint32_t>(t), msg, 0);
                    }

                    // External MIDI tracks are a live thru destination as
                    // well as a sequenced destination. All tracks currently
                    // share the configured hardware MIDI output, so send a
                    // given incoming packet only once even if several
                    // monitored external tracks accept it.
                    const bool externalMidiTrack = tDef->kind == TrackKind::ExternalMIDI
                        || tDef->kind == TrackKind::MIDI;
                    const int messageBytes = msg.getRawDataSize();
                    if (externalMidiTrack && !forwardedToExternalMidi
                        && messageBytes >= 1 && messageBytes <= 3) {
                        MidiCommand command;
                        command.kind = MidiCommandKind::Raw;
                        command.status = msg.getRawData()[0];
                        command.channel = command.status < 0xf0
                            ? static_cast<uint8_t>(command.status & 0x0f) : 0;
                        command.dataLength = static_cast<uint8_t>(messageBytes - 1);
                        if (messageBytes > 1) command.data1 = msg.getRawData()[1];
                        if (messageBytes > 2) command.data2 = msg.getRawData()[2];
                        const double latencySeconds = resostage::outputLatencySeconds(
                            currentOutputLatencySamples.load(std::memory_order_relaxed)
                                + pluginLatencyForBlock,
                            currentSampleRate);
                        command.targetHostTimeNanos = heardHostNanos(
                            hostTimeNanos, 0.0, latencySeconds);
                        midiDispatcher.enqueue(command);
                        forwardedToExternalMidi = true;
                        if (msg.isNoteOn() && msg.getVelocity() > 0
                            && msgChannel > 0 && msgChannel <= 16) {
                            activeExternalMidiChannelMask |= static_cast<uint16_t>(
                                1u << static_cast<unsigned>(msgChannel - 1));
                        }
                    }

                    if (midiCaptureActive && isArmed) {
                        if (msg.isController()
                            && msg.getControllerNumber() == 64) {
                            for (auto& session : activeMidiRecordSessions) {
                                if (session.trackId != tDef->id
                                    || session.recordedEventCount >= TrackMidiRecordSession::kMaxSessionRecordedEvents)
                                    continue;
                                auto& event = session.recordedEvents[session.recordedEventCount++];
                                event.sample = midiCaptureSample;
                                event.status = static_cast<uint8_t>(msg.getRawData()[0]);
                                event.data1 = 64;
                                event.data2 = static_cast<uint8_t>(msg.getControllerValue());
                                event.dataLength = 2;
                                break;
                            }
                        }
                        const bool isNoteOnMsg = msg.isNoteOn() && msg.getVelocity() > 0;
                        const bool isNoteOffMsg = msg.isNoteOff() || (msg.isNoteOn() && msg.getVelocity() == 0);
                        if (isNoteOnMsg) {
                            const int pitch = msg.getNoteNumber();
                            const float vel = static_cast<float>(msg.getVelocity()) / 127.0f;
                            for (auto& session : activeMidiRecordSessions) {
                                if (session.trackId == tDef->id) {
                                    auto& note = session.activeNotes[static_cast<size_t>(pitch)];
                                    if (note.active && session.recordedNoteCount < TrackMidiRecordSession::kMaxSessionRecordedNotes) {
                                        MidiNote completed;
                                        completed.id = note.id;
                                        completed.pitch = static_cast<uint8_t>(pitch);
                                        completed.velocity = note.velocity;
                                        const double noteStartSec = static_cast<double>(note.startSample) / currentSampleRate;
                                        const double durSec = static_cast<double>(midiCaptureSample - note.startSample) / currentSampleRate;
                                        const double bpm = (currentSong < proj.songs.size()) ? proj.songs[currentSong].bpm : 120.0;
                                        completed.startBeats = (noteStartSec * bpm) / 60.0;
                                        completed.durationBeats = std::max(0.05, (durSec * bpm) / 60.0);
                                        session.recordedNotes[session.recordedNoteCount++] = completed;
                                    }
                                    note.pitch = static_cast<uint8_t>(pitch);
                                    note.id = session.nextNoteId++;
                                    note.velocity = vel;
                                    note.startSample = midiCaptureSample;
                                    note.channel = msgChannel;
                                    note.active = true;
                                    break;
                                }
                            }
                        } else if (isNoteOffMsg) {
                            const int pitch = msg.getNoteNumber();
                            for (auto& session : activeMidiRecordSessions) {
                                if (session.trackId == tDef->id) {
                                    auto& note = session.activeNotes[static_cast<size_t>(pitch)];
                                    if (note.active && session.recordedNoteCount < TrackMidiRecordSession::kMaxSessionRecordedNotes) {
                                        MidiNote completed;
                                        completed.id = note.id;
                                        completed.pitch = static_cast<uint8_t>(pitch);
                                        completed.velocity = note.velocity;
                                        completed.releaseVelocity = static_cast<float>(msg.getVelocity()) / 127.0f;
                                        const double noteStartSec = static_cast<double>(note.startSample) / currentSampleRate;
                                        const double durSec = static_cast<double>(midiCaptureSample - note.startSample) / currentSampleRate;
                                        const double bpm = (currentSong < proj.songs.size()) ? proj.songs[currentSong].bpm : 120.0;
                                        completed.startBeats = (noteStartSec * bpm) / 60.0;
                                        completed.durationBeats = std::max(0.05, (durSec * bpm) / 60.0);
                                        session.recordedNotes[session.recordedNoteCount++] = completed;
                                        note.active = false;
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (midiCaptureActive && !activeMidiRecordSessions.empty()) {
        const double previewBpm = currentSong < proj.songs.size()
            ? proj.songs[currentSong].bpm
            : 120.0;
        publishLiveMidiPreview(previewBpm, playheadSample + numSamples);
    }

    if (isPlaying && currentSong < proj.songs.size()) {
        const SongDef& song = proj.songs[currentSong];

        const double blockStartSeconds = static_cast<double>(playheadSample) / currentSampleRate;
        const double blockEndSeconds = static_cast<double>(playheadSample + numSamples) / currentSampleRate;
        fireDueEvents(
            song, blockStartSeconds, blockEndSeconds, hostTimeNanos,
            currentOutputLatencySamples.load(std::memory_order_relaxed)
                + pluginLatencyForBlock,
            compatiblePluginBank,
            numSamples);

        const auto tempoMap = std::atomic_load_explicit(&activeTempoMap, std::memory_order_acquire);
        const double outputLatencySec =
            resostage::outputLatencySeconds(
                currentOutputLatencySamples.load(std::memory_order_relaxed) + pluginLatencyForBlock,
                currentSampleRate);

        dispatchMidiRegionsForBlock(
            song, playheadSample, numSamples, currentSampleRate,
            &graph,
            compatiblePluginBank,
            tempoMap.get(),
            hostTimeNanos,
            outputLatencySec);

        dispatchAutomationForBlock(
            song, playheadSample, numSamples, currentSampleRate,
            &graph,
            compatiblePluginBank,
            tempoMap.get(),
            hostTimeNanos,
            outputLatencySec);

        prewarmPluginsLookahead(
            song, playheadSample, currentSampleRate,
            &graph,
            compatiblePluginBank,
            tempoMap.get());

        // Cycle / skip-cycle (Logic-style locators, song-local). Applied on the
        // realtime path so loop authority is the engine -- not whichever SPA
        // tab happens to be open. Seek itself is message-thread (stream reseek
        // is not RT-safe); we only arm a pending target here.
        if (playing.load(std::memory_order_relaxed)
            && cycleActive.load(std::memory_order_relaxed)
            && pendingCycleSeekSec.load(std::memory_order_relaxed) < 0.0) {
            double lo = cycleLeftSec.load(std::memory_order_relaxed);
            double hi = cycleRightSec.load(std::memory_order_relaxed);
            if (hi < lo)
                std::swap(lo, hi);
            if (hi - lo >= 0.05) {
                const bool skip = cycleSkip.load(std::memory_order_relaxed);
                if (skip) {
                    // Jump over [lo, hi): when the block enters the zone, land on hi.
                    if (blockStartSeconds < hi && blockEndSeconds > lo
                        && blockStartSeconds < hi - 1e-9) {
                        // Prefer jump when already inside, or when crossing lo from below.
                        if (blockStartSeconds >= lo || blockEndSeconds > lo) {
                            const uint64_t epoch = cycleEpoch.load(std::memory_order_relaxed);
                            pendingCycleSeekSec.store(hi, std::memory_order_release);
                            juce::MessageManager::callAsync([this, epoch]() {
                                if (cycleEpoch.load(std::memory_order_acquire) != epoch)
                                    return; // zone changed / disabled since arm
                                double sec = 0.0;
                                if (!consumeCycleSeek(sec))
                                    return;
                                std::string err;
                                (void)seekToSeconds(sec, err);
                            });
                        }
                    }
                } else if (blockStartSeconds < hi && blockEndSeconds > hi) {
                    // Loop: crossing the right locator → jump to left.
                    const uint64_t epoch = cycleEpoch.load(std::memory_order_relaxed);
                    pendingCycleSeekSec.store(lo, std::memory_order_release);
                    juce::MessageManager::callAsync([this, epoch]() {
                        if (cycleEpoch.load(std::memory_order_acquire) != epoch)
                            return; // zone changed / disabled since arm
                        double sec = 0.0;
                        if (!consumeCycleSeek(sec))
                            return;
                        std::string err;
                        (void)seekToSeconds(sec, err);
                    });
                }
            }
        }

        // Arm as soon as the fade window (kSongEndFadeSamples before the real
        // end) first overlaps this block -- NOT once we're already past the
        // end. StreamingTrackBuffer::read() only starts returning silence
        // once the ring truly runs dry, which can happen mid-block; arming
        // reactively (checking playheadSample >= currentSongLengthFrames)
        // means the block that actually contains the real hard cutoff (real
        // audio for the first `got` samples, then abrupt zero for the rest,
        // since trackScratch is .clear()-ed before every read()) has already
        // gone by, fully unramped, before we ever notice -- that abrupt
        // in-block step is the crackle, and by the time we react the ramp
        // only has already-silent audio left to multiply, doing nothing.
        // Starting the ramp `kSongEndFadeSamples` early guarantees gain has
        // decayed to ~0 by the time the real cutoff sample arrives, so the
        // step lands on already-near-silent audio and is inaudible.
        //
        // When cycle loops and the right locator sits at (or past) the authored
        // end, prefer looping over song-end stop/advance. Mid-song cycles never
        // reach the end while looping (seek fires first); if the playhead is
        // already past the right locator, song-end must still work.
        const double cycleHi = cycleRightSec.load(std::memory_order_relaxed);
        const double cycleLo = cycleLeftSec.load(std::memory_order_relaxed);
        const bool cycleLoopBlocksSongEnd =
            cycleActive.load(std::memory_order_relaxed)
            && !cycleSkip.load(std::memory_order_relaxed)
            && (cycleHi - cycleLo) >= 0.05;
        const int64_t fadeArmSample = currentSongLengthFrames - kSongEndFadeSamples;
        const bool isRecActive = isRecordingState.load(std::memory_order_relaxed);
        if (!isRecActive && !cycleLoopBlocksSongEnd
            && currentSongLengthFrames > 0 && playheadSample + numSamples >= fadeArmSample) {
            if (pendingSongEndAction == SongEndAction::None) {
                if (underrunFadeOutRemaining <= 0) {
                    underrunFadeOutLength = kSongEndFadeSamples;
                    underrunFadeOutRemaining = kSongEndFadeSamples;
                }
                pendingSongEndAction = (song.onEnded == SongEnd::Next
                                         && currentSong + 1 < proj.songs.size())
                                            ? SongEndAction::GaplessAdvance
                                            : SongEndAction::StopTransport;
                pendingSongEndTargetSong = currentSong + 1;
            }
        }
        // Deliberately do NOT clear pendingSongEndAction when playhead is
        // briefly before fadeArmSample: that used to self-heal mid-handoff
        // and drop a GaplessAdvance. Fresh songs reset it in selectSongInternal.
    }

    // Pass 1: pull this block's audio from each track's stream exactly once
    // (a track may feed multiple busses, but must only be read from its ring
    // buffer once per block -- see StreamingTrackBuffer's class comment).
    // trackScratch is always sized under routingMutex (which we hold). Defensive
    // size check still guards a future mismatch if block size grows mid-run.
    //
    // Region windowing: streams are region-keyed (see StreamingEngine::stageSong).
    // We map the song playhead into the source file via
    //   fileFrame = playhead - regionStart + sourceOffset
    // and force silence outside [start, start+duration). Without this the
    // file kept playing after the clip's visual end, then hit EOF and
    // flashed meters. Fades + region gain are applied sample-accurately here.
    // (Mute/solo for bus routing lives in Pass 2 via snap->routes; strip
    // meters below always show post-fader/pan regardless of mute/solo.)
    const int focusedAudioInputTrack = focusedTrackIndex.load(std::memory_order_relaxed);
    for (size_t t = 0; t < trackIdByIndex.size(); ++t) {
        if (t >= trackScratch.size())
            break;
        juce::AudioBuffer<float>& scratch = trackScratch[t];
        if (scratch.getNumChannels() < 1 || scratch.getNumSamples() < numSamples)
            continue;
        scratch.clear();

        const TrackDef* tDef = trackDefAt(t);
        const bool isArmed = tDef != nullptr && tDef->recordArmed;
        const bool isAudio = tDef != nullptr && tDef->kind == TrackKind::Audio;
        const bool hasConfiguredInput = tDef != nullptr
            && !tDef->inputSource.empty() && tDef->inputSource != "none";
        // The focused audio track is the implicit monitor target when it has
        // an assigned input. Explicit I remains independent and can pin any
        // additional tracks without focus changes clearing those subscriptions.
        const bool isFocusMonitored = isAudio && hasConfiguredInput
            && static_cast<int>(t) == focusedAudioInputTrack;
        const bool isMonitored = isAudio && (tDef->inputMonitoring || isFocusMonitored);
        const MonitorSource monitorSource = isAudio
            ? computeEffectiveMonitorSource(
                monitorPhase, isArmed, isMonitored,
                autoInputMonitoringState.load(std::memory_order_relaxed),
                monitorBackendState.load(std::memory_order_relaxed))
            : MonitorSource::Timeline;
        const bool useInput = monitorSource == MonitorSource::Input
            || monitorSource == MonitorSource::TimelinePlusInput;
        const bool useTimeline = monitorSource == MonitorSource::Timeline
            || monitorSource == MonitorSource::TimelinePlusInput;
        const int64_t captureBegin = autoPunch
            ? std::max<int64_t>(std::max(playheadSample, recordCaptureStart), punchStart)
            : std::max(playheadSample, recordCaptureStart);
        const int64_t captureEnd = autoPunch
            ? std::min<int64_t>(playheadSample + numSamples, punchEnd)
            : playheadSample + numSamples;
        const int captureOffset = static_cast<int>(
            std::clamp<int64_t>(captureBegin - playheadSample, 0, numSamples));
        const int captureLength = static_cast<int>(
            std::clamp<int64_t>(captureEnd - captureBegin, 0, numSamples - captureOffset));
        const bool captureInput = isAudio && isRec && isArmed && captureLength > 0;

        if ((useInput || captureInput) && inputChannelData != nullptr
            && numInputChannels > 0 && tDef != nullptr) {
                int chL = 0, chR = (tDef->channels == 1 ? -1 : 1);
                audio_engine_detail::parseInputRouting(tDef->inputSource, tDef->channels, chL, chR);
                if (chR < 0) {
                    if (chL >= 0 && chL < numInputChannels && inputChannelData[chL] != nullptr) {
                        scratch.copyFrom(0, 0, inputChannelData[chL], numSamples);
                        if (scratch.getNumChannels() > 1) {
                            scratch.copyFrom(1, 0, inputChannelData[chL], numSamples);
                        }
                    }
                } else {
                    const bool haveLeft = chL >= 0 && chL < numInputChannels
                        && inputChannelData[chL] != nullptr;
                    const bool haveRight = chR >= 0 && chR < numInputChannels
                        && inputChannelData[chR] != nullptr;
                    if (haveLeft) {
                        scratch.copyFrom(0, 0, inputChannelData[chL], numSamples);
                    }
                    if (haveRight && scratch.getNumChannels() > 1) {
                        scratch.copyFrom(1, 0, inputChannelData[chR], numSamples);
                    }
                    // A stereo track can keep a stereo input assignment (1+2)
                    // even when the selected device only exposes input 1. In
                    // that case preserve the available mono signal in both
                    // sides instead of silently producing left-only audio.
                    if (scratch.getNumChannels() > 1 && haveLeft != haveRight) {
                        if (haveLeft)
                            scratch.copyFrom(1, 0, inputChannelData[chL], numSamples);
                        else
                            scratch.copyFrom(0, 0, inputChannelData[chR], numSamples);
                    }
                }
            if (captureInput && t < trackToAudioRecordSession.size()) {
                const int sessIdx = trackToAudioRecordSession[t];
                if (sessIdx >= 0) {
                    const float* pushPtrs[2] = {
                        scratch.getReadPointer(0, captureOffset),
                        scratch.getNumChannels() > 1
                            ? scratch.getReadPointer(1, captureOffset)
                            : scratch.getReadPointer(0, captureOffset)
                    };
                    audioRecordWorker.pushFrames(
                        static_cast<size_t>(sessIdx), pushPtrs, captureLength);
                }
            }
            if (!useInput)
                scratch.clear();
        }

        if (!useTimeline) {
            continue;
        }

        if (!isPlaying)
            continue;

        const std::string& trackId = trackIdByIndex[t];
        // EVERY region sounding in this block, not just the first.
        //
        // A track can have two regions overlapping, and when it does both
        // have to play: their fade-out and fade-in sum, and that sum IS the
        // crossfade. This used to stop at the first match, so an overlap
        // silently dropped one side -- the fades the timeline drew over a
        // join could never be heard, no matter what the UI wrote.
        //
        // Fixed cap, no allocation: this is the audio thread. Two is a
        // crossfade; anything past kMaxRegionsPerBlock is a pile-up the user
        // has to sort out in the editor.
        static constexpr int kMaxRegionsPerBlock = 8;
        const Region* sounding[kMaxRegionsPerBlock];
        int soundingCount = 0;
        const Region* fallback = nullptr;
        if (currentSong < proj.songs.size()) {
            const SongDef& song = proj.songs[currentSong];
            const double blockT0 = static_cast<double>(playheadSample) / currentSampleRate;
            const double blockT1 = static_cast<double>(playheadSample + numSamples) / currentSampleRate;
            for (const Region& r : song.regions) {
                if (r.trackId != trackId)
                    continue;
                if (fallback == nullptr)
                    fallback = &r;
                const double dur = regionEffectiveDurationSeconds(r);
                const double end = r.startSeconds + dur;
                if (blockT1 > r.startSeconds && blockT0 < end
                    && soundingCount < kMaxRegionsPerBlock) {
                    sounding[soundingCount++] = &r;
                }
            }
        }
        // Nothing under the playhead: still render the fallback so a staged
        // track clears its scratch exactly the way it always did (the window
        // check below turns it into silence).
        if (soundingCount == 0 && fallback != nullptr)
            sounding[soundingCount++] = fallback;
        if (soundingCount == 0)
            sounding[soundingCount++] = nullptr;

        // Folds a side-buffered region into the track's scratch. Both are
        // two channels wide and cleared before use, so summing both is right
        // whether the source was mono or stereo.
        auto sumIntoScratch = [&]() {
            const int chans =
                std::min(scratch.getNumChannels(), regionMixScratch.getNumChannels());
            for (int ch = 0; ch < chans; ++ch)
                scratch.addFrom(ch, 0, regionMixScratch, ch, 0, numSamples);
        };

      for (int regionSlot = 0; regionSlot < soundingCount; ++regionSlot) {
        const Region* reg = sounding[regionSlot];
        // The first region owns the track's scratch; the rest render into a
        // side buffer and are summed in at the end of the iteration.
        const bool additive = monitorSource == MonitorSource::TimelinePlusInput
            || regionSlot > 0;
        juce::AudioBuffer<float>& dst = additive ? regionMixScratch : scratch;
        if (additive) {
            if (regionMixScratch.getNumChannels() < 1
                || regionMixScratch.getNumSamples() < numSamples)
                break;
            regionMixScratch.clear();
        }

        StreamingTrackBuffer* buf = nullptr;
        if (reg != nullptr)
            buf = activeSong.region(reg->id);
        if (buf == nullptr)
            buf = activeSong.track(trackId);
        if (buf == nullptr)
            continue;

        const int trackChannels = std::min(2, buf->numChannels());
        float* ptrs[2] = {dst.getWritePointer(0), trackChannels > 1 ? dst.getWritePointer(1) : dst.getWritePointer(0)};
        if (ptrs[0] == nullptr)
            continue;

        const double sr = std::max(1.0, currentSampleRate);
        const int64_t regStart = reg != nullptr
            ? static_cast<int64_t>(std::llround(reg->startSeconds * sr)) : 0;
        const double regDurSec = reg != nullptr ? regionEffectiveDurationSeconds(*reg) : 0.0;
        const int64_t regLen = reg != nullptr
            ? std::max<int64_t>(0, static_cast<int64_t>(std::llround(regDurSec * sr))) : 0;
        const int64_t regEnd = regStart + regLen;
        const int64_t srcOff = reg != nullptr
            ? static_cast<int64_t>(std::llround(reg->source.offsetSeconds * sr)) : 0;
        const int64_t fadeInN = reg != nullptr
            ? static_cast<int64_t>(std::llround(std::max(0.0, reg->fade.inSeconds) * sr)) : 0;
        const int64_t fadeOutN = reg != nullptr
            ? static_cast<int64_t>(std::llround(std::max(0.0, reg->fade.outSeconds) * sr)) : 0;
        const float regGain = reg != nullptr ? dbToGain(reg->gainDb) : 1.0f;
        const double fadeInCurve = reg != nullptr ? reg->fade.inCurve : 0.0;
        const double fadeOutCurve = reg != nullptr ? reg->fade.outCurve : 0.0;
        const bool loop = reg != nullptr && reg->loop.enabled;
        // Available source frames from sourceOffset to end of file.
        const int64_t totalSrc = buf->totalFrames();
        const int64_t sourceAvail = std::max<int64_t>(0, totalSrc - srcOff);
        const double regLoopLen = (reg != nullptr && reg->loop.lengthSeconds > 0.0)
            ? reg->loop.lengthSeconds
            : 0.0;
        const int64_t loopLenN = regLoopLen > 0.0
            ? static_cast<int64_t>(std::llround(regLoopLen * sr))
            : sourceAvail;
        const int64_t loopCycle = std::max<int64_t>(1, std::min(sourceAvail, loopLenN));

        // ── Speed / reverse ─────────────────────────────────────────────
        //
        // Both need to read the source out of order, which the streaming ring
        // cannot do: it decodes strictly forwards and only holds a window
        // around the playhead. The resident (fully in-RAM) copy can, so these
        // are served from there and skipped otherwise -- a region that has not
        // finished loading plays straight rather than wrong, and picks the
        // treatment up on a later block once it has.
        const double playSpeed = reg != nullptr ? reg->playback.speed : 1.0;
        const double wantSemis = reg != nullptr ? reg->playback.semitones : 0.0;
        const bool wantReverse = reg != nullptr && reg->playback.reverse;
        const bool wantVarispeed = std::abs(playSpeed - 1.0) > 1.0e-9;
        const bool wantTranspose = std::abs(wantSemis) > 1.0e-6;
        const bool randomAccess = buf->isResident();
        const bool shaped = randomAccess && (wantReverse || wantVarispeed);

        const bool fullyOutside = reg != nullptr
            && (playheadSample + numSamples <= regStart || playheadSample >= regEnd);

        // Where this region reads from, for either path. Pure arithmetic, so
        // it lives in engine/audio/RegionSourceMap.h and is tested against
        // known values rather than by ear -- see test_region_source_map.cpp.
        RegionSourceWindow window;
        window.sourceOffset = srcOff;
        window.sourceAvail = sourceAvail;
        window.regionLength = regLen;
        window.loopCycle = loopCycle;
        window.speed = playSpeed;
        window.reverse = wantReverse;
        window.loop = loop;

        if (!fullyOutside && shaped) {
            // Polyphase windowed sinc, over the resident window directly.
            //
            // Two things happen here that both used to be worse. The kernel is
            // a band-limited interpolator instead of a two-point average, so
            // speeding a region up no longer dulls its top end and folds
            // images back as a metallic edge (see audio/SincInterpolator.h).
            // And the window is read as a plain array: the old path called
            // buf->read() twice per OUTPUT SAMPLE, and every one of those took
            // an atomic shared_ptr load to find the same window again.
            //
            // The view owns its snapshot for the block, so the data cannot be
            // freed under this thread while the loop runs.
            const auto view = buf->residentView();
            const int64_t into0Shaped = playheadSample - regStart;
            const SincTable& kernel = sincTables.forSpeed(std::abs(playSpeed));
            const int64_t viewStart = view.start();
            const int64_t viewLen = view.length();
            const int viewChans = view.channels();

            if (view && viewLen > 0 && kernel.isBuilt()
                && static_cast<int>(shapedKernelBase.size()) >= numSamples) {
                // Resolve every position ONCE for the block, not once per
                // channel. Where in the source we are -- and therefore which
                // kernel row to use -- does not depend on which channel is
                // being read, so a stereo region was doing the fmod, the
                // floor and the phase lookup twice for every sample to reach
                // the same two answers. What is left below is pure
                // multiply-accumulate, which is also the shape a compiler can
                // vectorise.
                for (size_t i = 0; i < static_cast<size_t>(numSamples); ++i) {
                    shapedKernelWeights[i] = nullptr;
                    const double sp = shapedSourceFrame(window, into0Shaped + static_cast<int>(i));
                    if (sp < 0.0)
                        continue; // scratch is already cleared to silence
                    // Positions are absolute source frames; the window may
                    // begin partway into the file.
                    const double local = sp - static_cast<double>(viewStart);
                    const float* weights = nullptr;
                    int64_t base = 0;
                    if (sincLookup(kernel, local, weights, base)) {
                        shapedKernelWeights[i] = weights;
                        shapedKernelBase[i] = base;
                    }
                }

                for (int ch = 0; ch < trackChannels; ++ch) {
                    float* out = ptrs[ch];
                    if (out == nullptr)
                        continue;
                    // Mono source feeding a stereo track: both sides read the
                    // one channel there is, same as the block-read path.
                    const float* src = view.channel(ch < viewChans ? ch : 0);
                    if (src == nullptr)
                        continue;
                    for (size_t i = 0; i < static_cast<size_t>(numSamples); ++i) {
                        const float* weights = shapedKernelWeights[i];
                        if (weights == nullptr)
                            continue;
                        // A loop reads across its own seam rather than into
                        // the silence past the window, which would click once
                        // per cycle.
                        out[i] = loop ? sincSampleAtLooped(weights, src, viewLen,
                                                           shapedKernelBase[i])
                                      : sincSampleAt(weights, src, viewLen,
                                                     shapedKernelBase[i]);
                    }
                }
            }
        } else if (!fullyOutside) {
            // Map song timeline → source file frames for this region.
            const int64_t into0 = playheadSample - regStart; // may be negative before start
            const auto mapFilePos = [&window](int64_t intoRegion) -> int64_t {
                return straightSourceFrame(window, intoRegion);
            };

            const int64_t filePosAtStart = mapFilePos(into0);
            // Fast path: contiguous non-wrapping read for the whole block.
            const bool wrapInBlock = loop && loopCycle > 0
                && into0 >= 0
                && (into0 / loopCycle) != ((into0 + numSamples - 1) / loopCycle);

            if (!wrapInBlock && filePosAtStart >= 0) {
                buf->read(ptrs, numSamples, filePosAtStart);
            } else if (!wrapInBlock && filePosAtStart < 0 && into0 + numSamples > 0) {
                // Leading silence before region start.
                const int lead = static_cast<int>(std::min<int64_t>(numSamples, -into0));
                const int tail = numSamples - lead;
                if (tail > 0) {
                    float* tailPtrs[2] = {
                        ptrs[0] != nullptr ? ptrs[0] + lead : nullptr,
                        trackChannels > 1 && ptrs[1] != nullptr ? ptrs[1] + lead
                                                               : (ptrs[0] != nullptr ? ptrs[0] + lead : nullptr)};
                    const int64_t fp = mapFilePos(0);
                    if (fp >= 0)
                        buf->read(tailPtrs, tail, fp);
                }
            } else if (wrapInBlock || loop) {
                // Contiguous segments of file frames (one seek per wrap).
                int i = 0;
                while (i < numSamples) {
                    const int64_t fp0 = mapFilePos(into0 + i);
                    if (fp0 < 0) {
                        ++i;
                        continue;
                    }
                    int j = i + 1;
                    while (j < numSamples) {
                        const int64_t fpj = mapFilePos(into0 + j);
                        if (fpj != fp0 + (j - i))
                            break;
                        ++j;
                    }
                    float* segPtrs[2] = {
                        ptrs[0] != nullptr ? ptrs[0] + i : nullptr,
                        trackChannels > 1 && ptrs[1] != nullptr ? ptrs[1] + i
                                                               : (ptrs[0] != nullptr ? ptrs[0] + i : nullptr)};
                    buf->read(segPtrs, j - i, fp0);
                    i = j;
                }
            }

            // Window + fades + region gain (sample-accurate at edges).
            // Non-loop past sourceAvail → silence even if still inside clip.
            if (reg != nullptr) {
                // Interior fast path: the whole block sits inside the clip,
                // past the fade-in, before the fade-out, with source behind
                // every sample -- so the sample-accurate loop below would
                // compute the same constant `regGain` numSamples times. That
                // is the state a region is in for all but a few blocks of its
                // life, and skipping it entirely when the gain is unity is
                // what keeps a 24-track song from paying a per-sample branch
                // ladder per track per block for nothing.
                const int64_t into0Abs = playheadSample - regStart;
                const int64_t intoEnd = into0Abs + numSamples; // exclusive
                const bool blockInsideClip =
                    regLen > 0 && into0Abs >= 0 && playheadSample + numSamples <= regEnd;
                const bool sourceUnderWholeBlock =
                    loop ? (sourceAvail > 0) : (intoEnd <= sourceAvail);
                const bool clearOfFades =
                    (fadeInN <= 0 || into0Abs >= fadeInN)
                    && (fadeOutN <= 0 || (intoEnd - 1) < regLen - fadeOutN);

                // ...and nothing else left to do to this block. Transposition
                // runs after this branch, so taking the shortcut with a
                // transposed region skipped the vocoder for every interior
                // block -- which is nearly all of them, so transpose did
                // nothing at all unless the region ALSO had speed or reverse
                // on it (those take the other branch, which has no shortcut).
                if (blockInsideClip && sourceUnderWholeBlock && clearOfFades
                    && !wantTranspose) {
                    if (regGain != 1.0f) {
                        for (int ch = 0; ch < trackChannels; ++ch) {
                            float* p = ptrs[ch];
                            if (p == nullptr)
                                continue;
                            for (int i = 0; i < numSamples; ++i)
                                p[i] *= regGain;
                        }
                    }
                    if (additive)
                        sumIntoScratch();
                    continue; // next region
                }

                for (int i = 0; i < numSamples; ++i) {
                    const int64_t absS = playheadSample + i;
                    float g = 0.0f;
                    if (absS >= regStart && absS < regEnd && regLen > 0) {
                        const int64_t into = absS - regStart;
                        const bool hasSource = loop
                            ? (sourceAvail > 0)
                            : (into >= 0 && into < sourceAvail);
                        if (hasSource) {
                            g = regGain;
                            // Both curves reach EXACTLY zero on the region's
                            // outermost sample.
                            //
                            // They used to be offset by one: the fade-in's
                            // first sample was at 1/N of the way up rather
                            // than at silence, and the fade-out's last sample
                            // was at 1/N rather than at zero -- so a region
                            // stepped from silence to a real value on its
                            // first sample and from a real value to silence
                            // after its last. On a long fade that step is
                            // small, but it is a discontinuity, and a
                            // discontinuity is a click no matter how short
                            // the fade is. It is loudest at the fade-out,
                            // where the step lands on the transition into
                            // nothing -- the spike you could hear at the end
                            // of an ordinary fade.
                            if (fadeInN > 0 && into < fadeInN) {
                                const float fadeT = static_cast<float>(into) / static_cast<float>(fadeInN);
                                g *= shapedFadeGain(fadeT, fadeInCurve);
                            }
                            if (fadeOutN > 0 && into >= regLen - fadeOutN) {
                                const float remain = static_cast<float>(regLen - 1 - into);
                                const float fadeT = remain / static_cast<float>(fadeOutN);
                                g *= shapedFadeGain(fadeT, fadeOutCurve);
                            }
                        }
                    }
                    for (int ch = 0; ch < trackChannels; ++ch) {
                        float* p = ptrs[ch];
                        if (p != nullptr)
                            p[i] *= g;
                    }
                }
            }
        }
        // else: leave scratch cleared (silence) -- do not pull from the stream
        // past the clip end (that was the meter-flash path).

        // ── Transposition ───────────────────────────────────────────────
        //
        // Applied last, on top of whatever the paths above produced: the
        // vocoder neither knows nor needs to know about loops, reverse, speed
        // or fades. Input and output counts are equal, so this transposes
        // without changing duration and needs no ring buffer.
        //
        // A phase vocoder is sequential and has no notion of seeking. The
        // slot therefore tracks where its input cursor should be, and a jump
        // (a seek, a loop wrap, the first block of a region) is simply fed
        // through -- the vocoder smears for a few milliseconds and recovers.
        // Resetting instead would be cleaner and is not allowed here: reset()
        // can allocate, and this is the audio thread.
        if (reg != nullptr && wantTranspose && !fullyOutside
            && pitchInScratch.getNumSamples() >= numSamples
            && pitchOutScratch.getNumSamples() >= numSamples) {
            PitchSlot* slot = nullptr;
            for (auto& candidate : pitchSlots) {
                if (candidate.regionId == reg->id) {
                    slot = &candidate;
                    break;
                }
            }
            if (slot == nullptr) {
                for (auto& candidate : pitchSlots) {
                    if (candidate.regionId.empty()) {
                        slot = &candidate;
                        // Assigning a std::string CAN allocate. Capacity is
                        // reserved once in ensureScratchSizes so the common
                        // case (a UUID, 36 chars) reuses the buffer.
                        slot->regionId = reg->id;
                        slot->nextInputSample = INT64_MIN;
                        break;
                    }
                }
            }
            if (slot != nullptr) {
                if (std::abs(slot->semitones - wantSemis) > 1.0e-9) {
                    slot->semitones = wantSemis;
                    slot->stretch.setTransposeSemitones(
                        static_cast<float>(wantSemis));
                    // Hold the formants where they were while the pitch moves.
                    //
                    // Without this, transposing shifts the whole spectrum --
                    // including the resonances that make a voice sound like a
                    // particular person and a snare sound like a particular
                    // drum. Two semitones up and a vocal is noticeably
                    // "smaller"; a fifth up and it is a cartoon. Compensating
                    // is what makes a transposed stem usable in a show rather
                    // than an effect.
                    //
                    // A factor of 1 with compensation on means "do not move
                    // the formants at all", which is the setting for
                    // transposing an existing recording. It costs three extra
                    // spectrum steps per block, and only on regions that are
                    // actually transposed.
                    slot->stretch.setFormantFactor(1.0f, /*compensatePitch=*/true);
                }
                const int64_t into = playheadSample - regStart;
                // Copy the block out, then push it back through transposed.
                for (int ch = 0; ch < 2; ++ch) {
                    const float* from = ch < trackChannels ? ptrs[ch] : ptrs[0];
                    float* into2 = pitchInScratch.getWritePointer(ch);
                    if (from != nullptr && into2 != nullptr)
                        std::copy_n(from, numSamples, into2);
                }
                float* inPtrs[2] = {pitchInScratch.getWritePointer(0),
                                    pitchInScratch.getWritePointer(1)};
                float* outPtrs[2] = {pitchOutScratch.getWritePointer(0),
                                     pitchOutScratch.getWritePointer(1)};
                slot->stretch.process(inPtrs, numSamples, outPtrs, numSamples);
                slot->nextInputSample = into + numSamples;
                slot->everUsed = true;
                systemHealth.notePitchBlock();
                for (int ch = 0; ch < trackChannels; ++ch) {
                    float* back = ptrs[ch];
                    const float* shifted = outPtrs[ch];
                    if (back != nullptr && shifted != nullptr)
                        std::copy_n(shifted, numSamples, back);
                }
            }
        }

        if (additive)
            sumIntoScratch();
      }
    }

    // ── Mix ─────────────────────────────────────────────────────────────────
    // Everything from here to the physical outputs is the MixGraph published
    // by publishRoutingSnapshot(): tracks, the metronome, the sends and the
    // master are all just strips, and MixRenderer runs the identical four
    // steps on each of them (see engine/audio/MixRenderer.h). This file no
    // longer knows what a fader, a pan law or a solo group is.
    if (!mixRenderer.canRender(graph, numSamples)) {
        bailSilently();
        return;
    }

    mixRenderer.beginBlock(graph, numSamples);

    // Hand each track's decoded block to its strip. Strip index == track
    // index by construction: buildMixGraph() lays the project's tracks out
    // first, in project order, exactly like trackIdByIndex.
    for (size_t t = 0; t < trackIdByIndex.size() && t < trackScratch.size(); ++t) {
        const juce::AudioBuffer<float>& scratch = trackScratch[t];
        if (scratch.getNumChannels() < 1 || scratch.getNumSamples() < numSamples)
            continue;
        float* dstL = mixRenderer.sourceChannel(static_cast<uint32_t>(t), 0);
        float* dstR = mixRenderer.sourceChannel(static_cast<uint32_t>(t), 1);
        if (dstL == nullptr || dstR == nullptr)
            continue;
        const float* srcL = scratch.getReadPointer(0);
        if (srcL == nullptr)
            continue;
        // A mono file feeds both sides; the strip's own channel count decides
        // whether that then gets folded, not the file's.
        const float* srcR =
            scratch.getNumChannels() > 1 ? scratch.getReadPointer(1) : srcL;
        if (srcR == nullptr)
            srcR = srcL;
        std::copy_n(srcL, numSamples, dstL);
        std::copy_n(srcR, numSamples, dstR);
    }

    // Built-in click: sample-locked to the song playhead so strong (bar 1) /
    // weak beats follow the current song's BPM + time signature. The project
    // preference gates generation, not strip mute/routing; recording count-in
    // temporarily overrides it and stops exactly at the capture boundary.
    if (clickStripIndex != MixGraph::kNoStrip) {
        float* dstL = mixRenderer.sourceChannel(clickStripIndex, 0);
        float* dstR = mixRenderer.sourceChannel(clickStripIndex, 1);
        if (dstL != nullptr && dstR != nullptr) {
            const int clickSamples = std::min(
                numSamples, static_cast<int>(clickScratch.size()));
            const bool countInActive =
                isRecordingState.load(std::memory_order_relaxed)
                && playheadSample < recordStartSamplePos.load(
                    std::memory_order_relaxed);
            const int countInSamples = countInActive
                ? static_cast<int>(std::clamp<int64_t>(
                    recordStartSamplePos.load(std::memory_order_relaxed)
                        - playheadSample,
                    0, clickSamples))
                : 0;
            const int generatedSamples = !isPlaying
                ? 0
                : proj.click.enabled ? clickSamples : countInSamples;
            if (generatedSamples > 0) {
                clickGenerator.render(clickScratch.data(), generatedSamples,
                                     playheadSample);
                if (generatedSamples < clickSamples) {
                    std::fill(clickScratch.begin() + generatedSamples,
                              clickScratch.begin() + clickSamples, 0.0f);
                }
            } else {
                std::fill_n(clickScratch.data(), clickSamples, 0.0f);
            }
            std::copy_n(clickScratch.data(), clickSamples, dstL);
            std::copy_n(clickScratch.data(), clickSamples, dstR);
            if (clickSamples < numSamples) {
                std::fill_n(dstL + clickSamples, numSamples - clickSamples, 0.0f);
                std::fill_n(dstR + clickSamples, numSamples - clickSamples, 0.0f);
            }
        }
    }

    mixRenderer.process(graph, numSamples, pluginProcessors);

    // During micro-fades / holds the physical outs are ramped, but the meters
    // read the UN-faded mix and would flash a full-scale peak (a pegged master
    // with no audible click). Skip metering while ramping so the UI tracks
    // what you actually hear.
    const bool meteringMuted = (underrunFadeOutRemaining > 0 || recoveryFadeInRemaining > 0
                                || outputHeldSilent);

    // ── Meters ──────────────────────────────────────────────────────────────
    // Every needle reads the same place: the strip's own post-fader/post-pan
    // signal. So gain, pan and any sends mixed in all show, and mute or
    // someone else's solo never do -- those happen after this tap.
    const auto publishStripMeter = [&](uint32_t strip, SeqLock<MeterFrame>* slot,
                                       LoudnessMeter* loudness, BandEnergyMeter* bands,
                                       std::atomic<float>* intervalL,
                                       std::atomic<float>* intervalR,
                                       std::atomic<float>* lastBlockL = nullptr,
                                       std::atomic<float>* lastBlockR = nullptr,
                                       MeterEnvelopeRing<kMeterRingPoints>* ring = nullptr) {
        if (slot == nullptr)
            return;
        if (meteringMuted) {
            slot->write(MeterFrame{});
            if (intervalL != nullptr) intervalL->store(0.0f, std::memory_order_relaxed);
            if (intervalR != nullptr) intervalR->store(0.0f, std::memory_order_relaxed);
            if (lastBlockL != nullptr) lastBlockL->store(0.0f, std::memory_order_relaxed);
            if (lastBlockR != nullptr) lastBlockR->store(0.0f, std::memory_order_relaxed);
            // A drain with nothing in it HOLDS the last value, so muting has to
            // say silence rather than stop talking -- one zero point is enough,
            // and it goes through the ring like any other so the reader needs
            // no special case.
            if (ring != nullptr) {
                ring->discardQueued();
                ring->push(MeterEnvelopePoint{});
            }
            return;
        }
        const StripLevels& level = mixRenderer.levels(strip);
        const float* postL = mixRenderer.postChannel(strip, 0);
        const float* postR = mixRenderer.postChannel(strip, 1);

        // An output lane is a mono strip whose fader and pan are constants the
        // graph never touches, so MixRenderer leaves its right row a
        // bit-identical copy of its left. Handing the meters the SAME pointer
        // twice is how they know to filter it once instead of twice (see
        // LoudnessMeter::processBlock). On a many-out rig the lanes are most of
        // the meter pool, so this halves most of it for identical readings.
        if (strip < graph.strips.size()
            && graph.strips[strip].kind == StripKind::OutputLane)
            postR = postL;

        MeterFrame frame;
        if (loudness != nullptr && postL != nullptr && postR != nullptr) {
            const float* channels[2] = {postL, postR};
            loudness->processBlock(channels, numSamples);
            frame = loudness->currentFrame();
        }
        frame.peakDbL = linearPeakToDb(level.peakL);
        frame.peakDbR = linearPeakToDb(level.peakR);
        frame.peakDb = linearPeakToDb(std::max(level.peakL, level.peakR));
        frame.truePeakDb = frame.peakDb;

        // Band-energy analysis for the light engine's GEQ/Blurz reads the same
        // post-fader signal, so the columns follow what is on the strip. The
        // fader is a scalar on every band, so the spectrum *shape* is
        // unaffected -- exactly what the visual needs.
        if (bands != nullptr && postL != nullptr && postR != nullptr) {
            const float* channels[2] = {postL, postR};
            bands->processBlock(channels, numSamples);
            bands->currentLevels(frame.bandLevel);
        }

        slot->write(frame);

        // Interval max: a ~30 ms click is often gone before the next 30 Hz UI
        // poll reads the SeqLock, so peaks are also latched atomically.
        if (intervalL != nullptr) atomicMaxFloat(*intervalL, level.peakL);
        if (intervalR != nullptr) atomicMaxFloat(*intervalR, level.peakR);
        // ...and the block's own peak, kept (not cleared by readers) so a poll
        // landing between callbacks still has a real measurement to report.
        if (lastBlockL != nullptr) lastBlockL->store(level.peakL, std::memory_order_relaxed);
        if (lastBlockR != nullptr) lastBlockR->store(level.peakR, std::memory_order_relaxed);

        // Sub-block peaks, handed over in a ring the publisher drains whenever
        // it likes. One number per block cannot describe 85ms of audio, and a
        // poll landing between callbacks would have nothing at all to report.
        if (ring != nullptr && postL != nullptr) {
            const float* chans[2] = {postL, postR != nullptr ? postR : postL};
            measureSubBlockPeaks(chans, postR != nullptr ? 2 : 1, numSamples,
                                 [ring](const MeterEnvelopePoint& p) { ring->push(p); });
        }
    };

    for (size_t t = 0; t < trackIdByIndex.size() && t < trackMeters.size(); ++t) {
        publishStripMeter(static_cast<uint32_t>(t), trackMeters[t].get(), nullptr,
                          t < trackBandMeters.size() ? &trackBandMeters[t] : nullptr,
                          trackPeakIntervalMaxL && t < trackPeakIntervalCount
                              ? &trackPeakIntervalMaxL[t] : nullptr,
                          trackPeakIntervalMaxR && t < trackPeakIntervalCount
                              ? &trackPeakIntervalMaxR[t] : nullptr,
                          trackLastBlockPeakL && t < trackPeakIntervalCount
                              ? &trackLastBlockPeakL[t] : nullptr,
                          trackLastBlockPeakR && t < trackPeakIntervalCount
                              ? &trackLastBlockPeakR[t] : nullptr);
    }

    if (clickStripIndex != MixGraph::kNoStrip) {
        publishStripMeter(clickStripIndex, &clickMeterFrame, nullptr, nullptr,
                          &clickPeakIntervalMaxL, &clickPeakIntervalMaxR,
                          &clickLastBlockPeakL, &clickLastBlockPeakR,
                          &clickEnvelopeRing);
    }

    // Bus rows keep their own flat index (0 = Main, 1.. = Sends, then the
    // Direct Output lanes) because that is what the mixer API addresses;
    // each row carries the strip it was derived from.
    for (size_t b = 0; b < busses.size() && b < busMeters.size(); ++b) {
        const uint32_t strip = busses[b].stripIndex;
        if (strip == MixGraph::kNoStrip)
            continue;
        publishStripMeter(strip, busMeters[b].get(),
                          b < busLoudnessMeters.size() ? &busLoudnessMeters[b] : nullptr,
                          nullptr,
                          busPeakIntervalMaxL && b < busPeakIntervalCount
                              ? &busPeakIntervalMaxL[b] : nullptr,
                          busPeakIntervalMaxR && b < busPeakIntervalCount
                              ? &busPeakIntervalMaxR[b] : nullptr,
                          busLastBlockPeakL && b < busPeakIntervalCount
                              ? &busLastBlockPeakL[b] : nullptr,
                          busLastBlockPeakR && b < busPeakIntervalCount
                              ? &busLastBlockPeakR[b] : nullptr,
                          b < busEnvelopeRings.size() ? busEnvelopeRings[b].get() : nullptr);
    }

    // Only now, after the latches above have this block's peaks in them.
    //
    // Bumped at the TOP of the callback this raced the meters it is meant to
    // vouch for: a poll landing between the bump and the writes saw "fresh
    // data" over an interval latch that had just been cleared and not yet
    // refilled, and reported silence. At 4096 frames the callback is long
    // enough that the window was wide open.
    // ── Physical output ─────────────────────────────────────────────────────
    // Output lanes are the single terminal writer per device channel, summing
    // with += so Main and an aux sharing outs 1/2 stack instead of one
    // clobbering the other.
    mixRenderer.writeToOutputs(graph, outputChannelData, numOutputChannels, numSamples);

    if (isRenderingTail) {
        bool anyAudible = false;
        for (uint32_t s = 0; s < graph.strips.size(); ++s) {
            if (graph.strips[s].kind == StripKind::OutputLane) {
                const auto& lvl = mixRenderer.levels(s);
                if (lvl.peakL > 1e-4f || lvl.peakR > 1e-4f) {
                    anyAudible = true;
                    break;
                }
            }
        }
        if (anyAudible) {
            pauseTailSilenceBlocks = 0;
        } else {
            ++pauseTailSilenceBlocks;
            if (pauseTailSilenceBlocks > 200) {
                pauseTailRemainingSamples = 0;
            }
        }
        if (pauseTailRemainingSamples > 0)
            pauseTailRemainingSamples -= numSamples;

        if (pauseTailRemainingSamples <= 0 && !anyAudible && !bankHasPlugins) {
            stopDeclickRemaining = kStopDeclickSamples;
            metersSilencedSinceStop = false;
        }
    }

    // Spec micro-fade on the summed physical outputs:
    //   - linear fade-out on underrun / song-end (length = whatever armed it)
    //   - linear fade-in on recovery / new song start (PREFERRED over hold,
    //     so selectSongInternal can leave outputHeldSilent set while arming
    //     the ramp and the audio thread never sees a full-gain step)
    //   - HOLD at silence after song-end fade reaches 0 until fade-in arms
    //     (without this, g snaps back to 1.0 mid-block -- the crack)
    if (underrunFadeOutRemaining > 0 || recoveryFadeInRemaining > 0 || outputHeldSilent) {
        const float fadeOutLen = static_cast<float>(
            underrunFadeOutLength > 0 ? underrunFadeOutLength : kSongEndFadeSamples);
        const float fadeInLen = static_cast<float>(
            recoveryFadeInLength > 0 ? recoveryFadeInLength : kSongEndFadeSamples);
        for (int i = 0; i < numSamples; ++i) {
            float g = 1.0f;
            if (underrunFadeOutRemaining > 0) {
                g = static_cast<float>(underrunFadeOutRemaining) / fadeOutLen;
                --underrunFadeOutRemaining;
                if (underrunFadeOutRemaining == 0
                    && pendingSongEndAction != SongEndAction::None) {
                    // Song-end ramp finished: stay silent across the rest of
                    // this block, the remaining real audio until true EOF,
                    // and the message-thread gap before the next song is
                    // staged. Cleared / overridden by fade-in in selectSongInternal.
                    outputHeldSilent = true;
                }
            } else if (recoveryFadeInRemaining > 0) {
                const int done = recoveryFadeInLength - recoveryFadeInRemaining;
                g = static_cast<float>(done + 1) / fadeInLen;
                --recoveryFadeInRemaining;
                if (recoveryFadeInRemaining == 0)
                    outputHeldSilent = false;
            } else if (outputHeldSilent) {
                g = 0.0f;
            }
            for (int ch = 0; ch < numOutputChannels; ++ch)
                if (outputChannelData[ch] != nullptr)
                    outputChannelData[ch][i] *= g;
        }
    }

    // Commit phase: only once the song-end fade-out ramp has fully applied AND
    // the playhead has actually reached the song's real end do we perform the
    // transition. Requiring both (not just the ramp counter reaching 0) means
    // a song shorter than the fade window can't trigger the transition before
    // its own real audio has finished playing.
    if (isPlaying && !isRecordingState.load(std::memory_order_relaxed) && pendingSongEndAction != SongEndAction::None && underrunFadeOutRemaining == 0
        && playheadSample >= currentSongLengthFrames) {
        if (pendingSongEndAction == SongEndAction::GaplessAdvance) {
            const size_t nextIdx = pendingSongEndTargetSong;
            pendingSongEndAction = SongEndAction::None;
            // Prefer in-callback promote of the warm precache: no 30 Hz timer
            // wait, no multi-file re-open -- just shared_ptr swap + playhead 0.
            // Falls back to message-thread switchToSongGapless if precache miss.
            streamHandoff.store(true, std::memory_order_release);
            if (!tryGaplessPromoteOnAudioThread(nextIdx)) {
                // Warm miss: message-thread stage. Keep handoff silent until
                // done — callAsync immediately (don't wait 30 Hz timer).
                clock.stop();
                pendingGaplessSong.store(static_cast<int>(nextIdx), std::memory_order_release);
                autoAdvancePending.store(true, std::memory_order_release);
                juce::MessageManager::callAsync([this, nextIdx]() {
                    if (pendingGaplessSong.load(std::memory_order_acquire) < 0)
                        return;
                    size_t idx = nextIdx;
                    if (!consumeGaplessAdvance(idx))
                        idx = nextIdx;
                    std::string err;
                    (void)switchToSongGapless(idx, err);
                    warmNeighbourSongs();
                });
            }
        } else {
            midiDispatcher.stopClock();
            playing.store(false, std::memory_order_release);
            clock.stop();
            pendingSongEndAction = SongEndAction::None;
        }
    }

    // If the right locator landed exactly on the device-block end there was
    // no second segment to render above. Canonicalise the transport now so
    // the next callback starts at the left locator and the stored position
    // cannot accumulate even a single sample over thousands of iterations.
    if (isPlaying
        && cycleActive.load(std::memory_order_relaxed)
        && !cycleSkip.load(std::memory_order_relaxed)
        && streaming.activeSongFullyResident()) {
        double leftSec = cycleLeftSec.load(std::memory_order_relaxed);
        double rightSec = cycleRightSec.load(std::memory_order_relaxed);
        if (rightSec < leftSec)
            std::swap(leftSec, rightSec);
        const int64_t leftSample = static_cast<int64_t>(std::llround(leftSec * currentSampleRate));
        const int64_t rightSample = static_cast<int64_t>(std::llround(rightSec * currentSampleRate));
        const int64_t cycleLength = rightSample - leftSample;
        const int64_t nextSample = hwSamplePosition.load(std::memory_order_relaxed);
        if (cycleLength > 0 && nextSample >= rightSample) {
            const int64_t wrapped = wrapCycleSample(nextSample, leftSample, rightSample);
            hwSamplePosition.store(wrapped, std::memory_order_relaxed);
            clock.start(currentSampleRate, wrapped);
            sequencedMidiFlushAtBlockStart = true;
        }
    }

    // Remember each physical channel's final sample so a Stop/Pause that
    // lands on the very next callback has something real to declick from
    // (see kStopDeclickSamples' doc comment) instead of ramping from silence
    // (which would just BE silence -- no click to avoid, but also no smooth
    // fade of whatever was actually still sounding).
    if (static_cast<int>(lastOutputSample.size()) < numOutputChannels)
        lastOutputSample.resize(static_cast<size_t>(numOutputChannels), 0.0f);
    for (int ch = 0; ch < numOutputChannels; ++ch)
        if (outputChannelData[ch] != nullptr && numSamples > 0)
            lastOutputSample[static_cast<size_t>(ch)] = outputChannelData[ch][numSamples - 1];
}

void AudioEngine::enqueueIncomingMidi(const uint8_t* data, int length, int targetTrackIndex) {
    if (data == nullptr || length <= 0 || length > 4)
        return;
    QueuedMidiPacket pkt;
    for (int i = 0; i < length; ++i)
        pkt.data[i] = data[i];
    pkt.length = static_cast<uint8_t>(length);
    pkt.targetTrackIndex = static_cast<int16_t>(targetTrackIndex);
    (void)midiInputQueue.tryPush(pkt);
}

void AudioEngine::setPluginParameter(size_t stripIndex, size_t slotIndex, int paramIndex, float value) {
    auto pub = std::atomic_load_explicit(&activePluginBank, std::memory_order_acquire);
    if (pub != nullptr && pub->bank != nullptr) {
        pub->bank->setPluginParameter(stripIndex, slotIndex, paramIndex, value);
    }
}

bool AudioEngine::setPluginParameterBySlotId(const std::string& slotId, int paramIndex, float value) {
    auto pub = std::atomic_load_explicit(&activePluginBank, std::memory_order_acquire);
    if (pub != nullptr && pub->bank != nullptr) {
        return pub->bank->setPluginParameterBySlotId(slotId, paramIndex, value);
    }
    return false;
}

} // namespace resostage
