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
#include "RoutingMath.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <thread>

namespace resostage {

using audio_engine_detail::dbToGain;
using audio_engine_detail::shapedFadeGain;
using audio_engine_detail::kRingBufferSeconds;
using audio_engine_detail::purgeStaleDrafts;

AudioEngine::AudioEngine() {
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
} // namespace

MeterFrame AudioEngine::consumeClickMeterInterval() {
    // Take the max peak rendered since the previous UI poll, then clear.
    const float peakL = clickPeakIntervalMaxL.exchange(0.0f, std::memory_order_relaxed);
    const float peakR = clickPeakIntervalMaxR.exchange(0.0f, std::memory_order_relaxed);

    // Echo last interval once: publish N carries real peak, publish N+1 still
    // carries it if this interval was silent. WS client that only samples the
    // later frame still sees the tick. Next silent interval clears delivery.
    const float outL = std::max(peakL, clickPeakDeliveryL);
    const float outR = std::max(peakR, clickPeakDeliveryR);
    clickPeakDeliveryL = peakL;
    clickPeakDeliveryR = peakR;

    MeterFrame frame;
    frame.peakDbL = linearPeakToDb(outL);
    frame.peakDbR = linearPeakToDb(outR);
    frame.peakDb = linearPeakToDb(std::max(outL, outR));
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

    float deliveryL = 0.0f;
    float deliveryR = 0.0f;
    if (busIndex < busPeakDeliveryL.size()) {
        deliveryL = busPeakDeliveryL[busIndex];
        deliveryR = busPeakDeliveryR[busIndex];
        busPeakDeliveryL[busIndex] = peakL;
        busPeakDeliveryR[busIndex] = peakR;
    }

    const float outL = std::max(peakL, deliveryL);
    const float outR = std::max(peakR, deliveryR);
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
    static const std::string kEmpty;
    const auto& buses = loader.project().busses;
    if (index >= buses.size())
        return kEmpty;
    return buses[index].name.empty() ? buses[index].id : buses[index].name;
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
    const auto& buses = loader.project().busses;
    if (busIndex < buses.size())
        return buses[busIndex].mute;
    return busIndex < busMuted.size() && busMuted[busIndex];
}

bool AudioEngine::isBusSoloed(size_t busIndex) const {
    const auto& buses = loader.project().busses;
    return busIndex < buses.size() && buses[busIndex].solo;
}

double AudioEngine::busGainDb(size_t busIndex) const {
    const auto& buses = loader.project().busses;
    if (busIndex >= buses.size())
        return 0.0;
    return buses[busIndex].gainDb;
}

double AudioEngine::currentSongLengthSeconds() const {
    if (currentSampleRate <= 0.0 || currentSongLengthFrames <= 0)
        return 0.0;
    return static_cast<double>(currentSongLengthFrames) / currentSampleRate;
}

double AudioEngine::regionEffectiveDurationSeconds(const Region& r) const {
    if (r.durationSeconds > 0.0)
        return r.durationSeconds;
    const PeakOverview* pk = cachedPeaksForFile(r.file);
    return pk != nullptr ? pk->durationSeconds : 0.0;
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
    loader.project() = std::move(*restored);
    resyncStreamingWindowsForCurrentSong();
    syncTransportCycleFromProject();
    markDirty();
    return true;
}

bool AudioEngine::redoTimelineEdit(std::string& appliedLabel) {
    appliedLabel = projectHistory.redoLabel();
    auto restored = projectHistory.redo();
    if (!restored.has_value())
        return false;
    loader.project() = std::move(*restored);
    resyncStreamingWindowsForCurrentSong();
    syncTransportCycleFromProject();
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
    hwSamplePosition.store(0, std::memory_order_relaxed);
    lastCallbackHostNanos = 0;

    for (auto& meter : busLoudnessMeters)
        meter.prepare(currentSampleRate, 2);
    for (auto& band : trackBandMeters)
        band.prepare(currentSampleRate, 2);

    ensureScratchSizes();

    // Read-and-clear: whatever set this (audioDeviceStopped(), for either a
    // deliberate reconfigure or a hot-unplug fail-safe recovery) wants
    // playback resumed once this restart -- and any rate-change restage --
    // is fully applied. Handled in the SAME deferred callback as the restage
    // below (not a second, independently-scheduled callAsync) so resume
    // deterministically runs after it, rather than racing it.
    const bool shouldResume = resumeAfterDeviceRestart.exchange(false, std::memory_order_relaxed);

    if (rateChanged) {
        juce::MessageManager::callAsync([this, newSampleRate, previousPlayheadSeconds, shouldResume] {
            handleSampleRateChanged(newSampleRate, previousPlayheadSeconds, shouldResume);
        });
    } else if (shouldResume) {
        juce::MessageManager::callAsync([this] { play(); });
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
        currentSongLengthFrames = newSongLengthFrames;
    }

    // Resume transport now that the restage is fully applied -- play()
    // itself re-reads clock.currentSamplePosition(), which clock.start()
    // above already set to newStartSample, so this continues from the
    // preserved position rather than wherever it happened to be mid-restage.
    if (wasPlaying)
        play();
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

void AudioEngine::audioDeviceIOCallbackWithContext(const float* const* /*inputChannelData*/,
                                                     int /*numInputChannels*/,
                                                     float* const* outputChannelData,
                                                     int numOutputChannels,
                                                     int numSamples,
                                                     const juce::AudioIODeviceCallbackContext& context) {
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
    const uint64_t hostTimeNanos = (context.hostTimeNs != nullptr)
                                        ? SystemMonotonicClock::ticksToNanos(*context.hostTimeNs)
                                        : SystemMonotonicClock{}.nowNanos();
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

    systemHealth.noteAudioCallback();
    // Underrun heuristic: gap between consecutive callbacks more than 2.5x the
    // expected block duration (or an explicit simulateUnderrun stall).
    // Skip while the transport clock is stopped -- gapless handoff deliberately
    // parks the clock for a few blocks and must not look like a dropout.
    bool underrunThisCallback = false;
    if (clockRunning && lastCallbackHostNanos != 0 && currentSampleRate > 0.0 && numSamples > 0) {
        const double expectedNs = (static_cast<double>(numSamples) / currentSampleRate) * 1.0e9;
        const double gapNs = static_cast<double>(hostTimeNanos - lastCallbackHostNanos);
        if (gapNs > expectedNs * 2.5 || stallMs > 0.0) {
            systemHealth.noteUnderrun();
            underrunThisCallback = true;
            underrunFadeOutLength = kUnderrunFadeSamples;
            underrunFadeOutRemaining = kUnderrunFadeSamples;
        }
    }
    // After an underrun gap, start a short fade-in so recovery isn't a click.
    if (lastCallbackWasUnderrun && !underrunThisCallback) {
        outputHeldSilent = false;
        recoveryFadeInLength = kUnderrunFadeSamples;
        recoveryFadeInRemaining = kUnderrunFadeSamples;
    }
    lastCallbackWasUnderrun = underrunThisCallback;
    if (clockRunning)
        lastCallbackHostNanos = hostTimeNanos;

    // Telemetry prefers the sample-accurate render position while playing so
    // the UI playhead tracks the actual audio, not a wall-clock estimate.
    const int64_t telemetrySamples = clockRunning ? renderPlayheadSample : clock.currentSamplePosition();
    const double telemetrySeconds = (currentSampleRate > 0.0)
                                        ? static_cast<double>(telemetrySamples) / currentSampleRate
                                        : clock.currentSeconds();
    transportTelemetry.playheadSamples.store(telemetrySamples, std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(telemetrySeconds, std::memory_order_relaxed);
    transportTelemetry.sampleRate.store(clock.sampleRate(), std::memory_order_relaxed);
    transportTelemetry.driftFactor.store(clock.driftFactor(), std::memory_order_relaxed);
    transportTelemetry.running.store(playing.load(std::memory_order_relaxed), std::memory_order_relaxed);

    if (!playing.load(std::memory_order_acquire)) {
        // Declick tail: the first silent callback right after a Stop/Pause
        // ramps the last real output sample on each channel down to zero
        // instead of a hard cut -- see kStopDeclickSamples' doc comment.
        if (wasPlayingLastCallback) {
            stopDeclickRemaining = kStopDeclickSamples;
            if (static_cast<int>(lastOutputSample.size()) < numOutputChannels)
                lastOutputSample.resize(static_cast<size_t>(numOutputChannels), 0.0f);
        }
        wasPlayingLastCallback = false;

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
            metersSilencedSinceStop = true;
        }
        // Keep this live even while stopped. The underrun check above
        // already skips itself while !clockRunning, so it wouldn't fire
        // *now* either way -- but if left stale from before Stop/Pause,
        // the gap computed on the very first callback after Play resumes
        // would span the *entire pause*, tripping a false underrun the
        // instant transport restarts. A genuine dropout is still caught
        // (the gap is measured from here, not from further back).
        lastCallbackHostNanos = hostTimeNanos;
        return;
    }
    metersSilencedSinceStop = false;
    wasPlayingLastCallback = true;

    // Gapless / restage handoff: keep outs silent and do not touch rings
    // until the message thread has reset the playhead to match the new song.
    if (streamHandoff.load(std::memory_order_acquire))
        return;

    const std::shared_ptr<const RoutingSnapshot> snap = routing.acquireForRender();
    if (snap == nullptr || busses.empty())
        return;

    std::unique_lock<std::recursive_mutex> routeLock(routingMutex, std::try_to_lock);
    if (!routeLock.owns_lock())
        return;


    StreamingEngine::ActiveSongHandle activeSong = streaming.acquireActiveSong();

    if (!activeSong)
        return;

    const int64_t playheadSample = renderPlayheadSample;

    const Project& proj = loader.project();
    if (currentSong < proj.songs.size()) {
        const SongDef& song = proj.songs[currentSong];

        const double blockStartSeconds = static_cast<double>(playheadSample) / currentSampleRate;
        const double blockEndSeconds = static_cast<double>(playheadSample + numSamples) / currentSampleRate;
        fireDueEvents(song, blockStartSeconds, blockEndSeconds, hostTimeNanos);

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
                } else if (blockStartSeconds < hi && blockEndSeconds >= hi) {
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
        const double songLenSec = currentSampleRate > 0.0
            ? static_cast<double>(currentSongLengthFrames) / currentSampleRate
            : 0.0;
        const double cycleHi = cycleRightSec.load(std::memory_order_relaxed);
        const double cycleLo = cycleLeftSec.load(std::memory_order_relaxed);
        const bool cycleLoopBlocksSongEnd =
            cycleActive.load(std::memory_order_relaxed)
            && !cycleSkip.load(std::memory_order_relaxed)
            && (cycleHi - cycleLo) >= 0.05
            && cycleHi >= songLenSec - 0.02;
        const int64_t fadeArmSample = currentSongLengthFrames - kSongEndFadeSamples;
        if (!cycleLoopBlocksSongEnd
            && currentSongLengthFrames > 0 && playheadSample + numSamples >= fadeArmSample) {
            if (pendingSongEndAction == SongEndAction::None) {
                if (underrunFadeOutRemaining <= 0) {
                    underrunFadeOutLength = kSongEndFadeSamples;
                    underrunFadeOutRemaining = kSongEndFadeSamples;
                }
                pendingSongEndAction = (song.playbackMode == PlaybackMode::AutoplayNext
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
    for (size_t t = 0; t < trackIdByIndex.size(); ++t) {
        if (t >= trackScratch.size())
            break;
        juce::AudioBuffer<float>& scratch = trackScratch[t];
        if (scratch.getNumChannels() < 1 || scratch.getNumSamples() < numSamples)
            continue;
        scratch.clear();

        const std::string& trackId = trackIdByIndex[t];
        const Region* reg = nullptr;
        if (currentSong < proj.songs.size()) {
            const SongDef& song = proj.songs[currentSong];
            const double blockT0 = static_cast<double>(playheadSample) / currentSampleRate;
            const double blockT1 = static_cast<double>(playheadSample + numSamples) / currentSampleRate;
            const Region* fallback = nullptr;
            for (const Region& r : song.regions) {
                if (r.trackId != trackId)
                    continue;
                if (fallback == nullptr)
                    fallback = &r;
                const double dur = regionEffectiveDurationSeconds(r);
                const double end = r.startSeconds + dur;
                if (blockT1 > r.startSeconds && blockT0 < end) {
                    reg = &r;
                    break;
                }
            }
            if (reg == nullptr)
                reg = fallback;
        }

        StreamingTrackBuffer* buf = nullptr;
        if (reg != nullptr)
            buf = activeSong.region(reg->id);
        if (buf == nullptr)
            buf = activeSong.track(trackId);
        if (buf == nullptr)
            continue;

        const int trackChannels = std::min(2, buf->numChannels());
        float* ptrs[2] = {scratch.getWritePointer(0), trackChannels > 1 ? scratch.getWritePointer(1) : scratch.getWritePointer(0)};
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
            ? static_cast<int64_t>(std::llround(reg->sourceOffsetSeconds * sr)) : 0;
        const int64_t fadeInN = reg != nullptr
            ? static_cast<int64_t>(std::llround(std::max(0.0, reg->fadeInSeconds) * sr)) : 0;
        const int64_t fadeOutN = reg != nullptr
            ? static_cast<int64_t>(std::llround(std::max(0.0, reg->fadeOutSeconds) * sr)) : 0;
        const float regGain = reg != nullptr ? dbToGain(reg->gainDb) : 1.0f;
        const double fadeInCurve = reg != nullptr ? reg->fadeInCurve : 0.0;
        const double fadeOutCurve = reg != nullptr ? reg->fadeOutCurve : 0.0;
        const bool loop = reg != nullptr && reg->loop;
        // Available source frames from sourceOffset to end of file.
        const int64_t totalSrc = buf->totalFrames();
        const int64_t sourceAvail = std::max<int64_t>(0, totalSrc - srcOff);
        const double regLoopLen = (reg != nullptr && reg->loopLengthSeconds > 0.0)
            ? reg->loopLengthSeconds
            : 0.0;
        const int64_t loopLenN = regLoopLen > 0.0
            ? static_cast<int64_t>(std::llround(regLoopLen * sr))
            : sourceAvail;
        const int64_t loopCycle = std::max<int64_t>(1, std::min(sourceAvail, loopLenN));

        const bool fullyOutside = reg != nullptr
            && (playheadSample + numSamples <= regStart || playheadSample >= regEnd);

        if (!fullyOutside) {
            // Map song timeline → source file frames for this region.
            const int64_t into0 = playheadSample - regStart; // may be negative before start
            auto mapFilePos = [&](int64_t intoRegion) -> int64_t {
                if (intoRegion < 0)
                    return -1;
                if (sourceAvail <= 0)
                    return -1;
                if (loop) {
                    if (loopCycle <= 0) return -1;
                    int64_t m = intoRegion % loopCycle;
                    if (m < 0) m += loopCycle;
                    return srcOff + m;
                }
                if (intoRegion >= sourceAvail)
                    return -1;
                return srcOff + intoRegion;
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
                            if (fadeInN > 0 && into < fadeInN) {
                                const float fadeT = static_cast<float>(into + 1) / static_cast<float>(fadeInN);
                                g *= shapedFadeGain(fadeT, fadeInCurve);
                            }
                            if (fadeOutN > 0 && into >= regLen - fadeOutN) {
                                const float remain = static_cast<float>(regLen - into);
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

        // Strip peak meter: post track fader + pan (+ mono), NEVER derived from
        // send routing. A Sends Only track with zero sends still has signal in
        // the strip and must show it; send knobs only affect destinations.
        if (t < trackMeters.size() && trackMeters[t] != nullptr) {
            // Same floor/ceiling as Metering.cpp::linearToDb -- a single
            // non-finite or absurd sample must not peg the strip at +400 dB.
            auto toDb = [](float p) -> float {
                if (!(p > 1.0e-9f) || !std::isfinite(p))
                    return -144.0f;
                constexpr float kMaxLinear = 32.0f;
                const float c = std::min(p, kMaxLinear);
                return 20.0f * std::log10(c);
            };
            auto finiteSample = [](float s) -> float {
                return std::isfinite(s) ? s : 0.0f;
            };

            float gL = 1.0f;
            float gR = 1.0f;
            bool forceMono = trackChannels < 2;
            if (t < proj.tracks.size()) {
                const TrackDef& td = proj.tracks[t];
                // Strip meters always show post-fader/pan signal, even when
                // the track is muted or dimmed by another solo. Mute/solo
                // only affect bus routing (Pass 2 below), not strip needles.
                const float g = dbToGain(td.gainDb);
                const float pan = static_cast<float>(std::clamp(td.pan, -1.0, 1.0));
                gL = g * (1.0f - std::max(0.0f, pan));
                gR = g * (1.0f + std::min(0.0f, pan));
                forceMono = forceMono || td.mono;
            }

            const float* sL = scratch.getReadPointer(0);
            const float* sR =
                trackChannels > 1 ? scratch.getReadPointer(1) : sL;
            float peakL = 0.0f;
            float peakR = 0.0f;
            for (int i = 0; i < numSamples; ++i) {
                const float l = finiteSample(sL != nullptr ? sL[i] : 0.0f);
                const float r = finiteSample(sR != nullptr ? sR[i] : l);
                if (forceMono) {
                    const float m = 0.5f * (l + r);
                    peakL = std::max(peakL, std::abs(m * gL));
                    peakR = std::max(peakR, std::abs(m * gR));
                } else {
                    peakL = std::max(peakL, std::abs(l * gL));
                    peakR = std::max(peakR, std::abs(r * gR));
                }
            }
            // Mono strip: same post-fader mono peak on both bars when pan
            // is centre; with pan, L/R already reflect balance.
            if (forceMono && std::abs(gL - gR) < 1.0e-6f) {
                const float p = std::max(peakL, peakR);
                peakL = peakR = p;
            }
            MeterFrame frame;
            frame.peakDb = toDb(std::max(peakL, peakR));
            frame.peakDbL = toDb(peakL);
            frame.peakDbR = toDb(peakR);
            frame.truePeakDb = frame.peakDb;
            // Band-energy analysis for the light engine's GEQ/Blurz: same
            // post-fader signal the peaks see, so the columns follow what's
            // on the strip (including muted channels). The uniform fader
            // gain is a scalar on every band, so the spectrum *shape* is
            // unaffected -- exactly what the visual needs.
            if (t < trackBandMeters.size()) {
                const float* bandCh[2] = {sL != nullptr ? sL : sR, sR};
                trackBandMeters[t].processBlock(bandCh, numSamples);
                trackBandMeters[t].currentLevels(frame.bandLevel);
            }
            trackMeters[t]->write(frame);
        }
    }

    busScratch.clear();
    const int scratchChannels = busScratch.getNumChannels();

    // Pass 2: tracks -> bus scratch buffers.
    for (const TrackRoute& route : snap->routes) {
        if (route.mute || route.trackIndex >= trackIdByIndex.size() || route.busIndex >= busses.size())
            continue;

        StreamingTrackBuffer* buf = activeSong.track(trackIdByIndex[route.trackIndex]);
        if (buf == nullptr)
            continue;

        if (route.trackIndex >= trackScratch.size())
            continue;
        const juce::AudioBuffer<float>& trackBuf = trackScratch[route.trackIndex];
        if (trackBuf.getNumChannels() < 1 || trackBuf.getNumSamples() < numSamples)
            continue;
        const int trackChannels = std::min(2, buf->numChannels());
        // Prefer live LoadedBus channel count; never treat a bus as 0-ch
        // (that skipped the mix and silenced sends on shared Ext. Outs).
        int busChannels = std::min(2, busses[route.busIndex].channelCount);
        if (busChannels < 1)
            busChannels = 2;
        const int scratchOffset = static_cast<int>(route.busIndex) * 2;
        if (scratchOffset + busChannels > scratchChannels)
            continue;

        const float* srcL = trackBuf.getReadPointer(0);
        if (srcL == nullptr)
            continue;
        const float* srcR = trackChannels > 1 ? trackBuf.getReadPointer(1) : srcL;
        if (srcR == nullptr)
            srcR = srcL;

        const float g = route.gainLinear * route.sendGainLinear;
        // Balance-style pan targets (L/R attenuation).
        const float targetGL = g * (1.0f - std::max(0.0f, route.pan));
        const float targetGR = g * (1.0f + std::min(0.0f, route.pan));
        // Force-mono track flag or mono file → sum L+R, then pan into bus.
        const float targetMono =
            (route.forceMono || trackChannels < 2) ? 1.0f : 0.0f;

        const size_t smoothIdx =
            static_cast<size_t>(route.trackIndex) * kSmoothBusSlots
            + static_cast<size_t>(route.busIndex % kSmoothBusSlots);
        if (smoothIdx >= trackGainSmooth.size())
            trackGainSmooth.resize(smoothIdx + 1);
        TrackGainSmooth& sm = trackGainSmooth[smoothIdx];
        if (!sm.inited) {
            sm.gL = targetGL;
            sm.gR = targetGR;
            sm.monoMix = targetMono;
            sm.inited = true;
        }

        // ~10 ms exponential dezipper (avoids pan/gain/mono hard jumps → clicks).
        const float sr = static_cast<float>(std::max(1.0, currentSampleRate));
        const float a = 1.0f - std::exp(-1.0f / (0.010f * sr));

        for (int i = 0; i < numSamples; ++i) {
            sm.gL += a * (targetGL - sm.gL);
            sm.gR += a * (targetGR - sm.gR);
            sm.monoMix += a * (targetMono - sm.monoMix);

            const float lIn = srcL[i];
            const float rIn = srcR[i];
            const float mid = 0.5f * (lIn + rIn);
            // Crossfade stereo ↔ mono sum so the mono toggle doesn't click.
            const float preL = lIn + sm.monoMix * (mid - lIn);
            const float preR = rIn + sm.monoMix * (mid - rIn);

            if (busChannels >= 2) {
                busScratch.addSample(scratchOffset + 0, i, preL * sm.gL);
                busScratch.addSample(scratchOffset + 1, i, preR * sm.gR);
            } else {
                // Mono lane: honor which source channel(s) feed it. A stereo
                // track routed to a PAIR of mono lanes places L in lane A and R
                // in lane B (sourceChannel 0/1) to preserve the image; a track
                // directly on one mono lane sums L+R (-1).
                const routing_math::Placed p = routing_math::placeIntoBus(
                    false, route.sourceChannel, preL, preR, sm.gL, sm.gR);
                busScratch.addSample(scratchOffset + 0, i, p.ch0);
                if (p.ch1 != 0.0f)
                    busScratch.addSample(scratchOffset + 1, i, p.ch1);
            }
        }
    }

    // During micro-fades / holds the physical outs are ramped, but meters used
    // to read the UN-faded busScratch and flash a full-scale peak (visible as
    // a pegged master meter with no audible click). Skip metering while
    // ramping so the UI tracks what you actually hear.
    const bool meteringMuted = (underrunFadeOutRemaining > 0 || recoveryFadeInRemaining > 0
                                || outputHeldSilent);

    // Built-in click: sample-locked to song playhead so strong (bar 1) /
    // weak beats follow the current song's BPM + time-signature numerator.
    // Empty clickTargetBusIndices = Sends Only -- still audible via sends.
    // Physical outs of those busses sum with `+=`, so master + aux + click
    // sharing the same Ext. Out channel all stack correctly.
    //
    // Always RENDER for the strip meter (post gain/pan), even when the
    // metronome is muted (isClickEnabled == false). Bus/send mix only when
    // enabled -- same strip-vs-bus rule as muted tracks above.
    {
        if (clickScratch.size() < static_cast<size_t>(numSamples))
            clickScratch.resize(static_cast<size_t>(numSamples), 0.0f);
        // playheadSample == 0 → beat 0 → accented downbeat under current meter.
        clickGenerator.render(clickScratch.data(), numSamples, playheadSample);

        // Balance pan on the mono click (same law as track pan), unless
        // clickMono forces L=R.
        const float targetGL = clickMono
            ? clickGainLinear
            : clickGainLinear * (1.0f - std::max(0.0f, clickPan));
        const float targetGR = clickMono
            ? clickGainLinear
            : clickGainLinear * (1.0f + std::min(0.0f, clickPan));
        if (!clickSmoothInited) {
            clickSmoothGL = targetGL;
            clickSmoothGR = targetGR;
            clickSmoothInited = true;
        }
        const float sr = static_cast<float>(std::max(1.0, currentSampleRate));
        const float a = 1.0f - std::exp(-1.0f / (0.010f * sr));
        // Advance dezippers even when muted so re-enabling doesn't jump.
        for (int i = 0; i < numSamples; ++i) {
            clickSmoothGL += a * (targetGL - clickSmoothGL);
            clickSmoothGR += a * (targetGR - clickSmoothGR);
        }

        // Bus mix only when the metronome is on.
        if (isClickEnabled) {
            for (const int clickTarget : clickTargetBusIndices) {
                if (clickTarget < 0 || static_cast<size_t>(clickTarget) >= busses.size())
                    continue;
                const int scratchOffset = static_cast<int>(clickTarget) * 2;
                if (scratchOffset + 2 <= scratchChannels) {
                    for (int i = 0; i < numSamples; ++i) {
                        const float s = clickScratch[static_cast<size_t>(i)];
                        busScratch.addSample(
                            scratchOffset + 0, i, s * clickSmoothGL);
                        busScratch.addSample(
                            scratchOffset + 1, i, s * clickSmoothGR);
                    }
                }
            }

            // Send buses (aux monitor mixes) — send gain × pan balance.
            if (clickSendSmooth.size() < clickSendBusIndices.size())
                clickSendSmooth.resize(clickSendBusIndices.size());
            for (size_t si = 0; si < clickSendBusIndices.size(); ++si) {
                const int sendBusIdx = clickSendBusIndices[si];
                if (static_cast<size_t>(sendBusIdx) >= busses.size())
                    continue;
                const int scratchOffset = sendBusIdx * 2;
                if (scratchOffset + 2 > scratchChannels)
                    continue;
                const float sendGain = clickSendGainLinears[si];
                float sendTargetGL = 0.0f, sendTargetGR = 0.0f;
                // Include the metronome's own level so the send reacts to the
                // click volume knob, not just the configures send gain.
                routing_math::clickSendTargets(
                    clickMono, clickGainLinear, sendGain, clickPan,
                    sendTargetGL, sendTargetGR);

                ClickSendSmooth& sm = clickSendSmooth[si];
                if (!sm.inited) {
                    sm.gL = sendTargetGL;
                    sm.gR = sendTargetGR;
                    sm.inited = true;
                }

                for (int i = 0; i < numSamples; ++i) {
                    sm.gL += a * (sendTargetGL - sm.gL);
                    sm.gR += a * (sendTargetGR - sm.gR);
                    const float s = clickScratch[static_cast<size_t>(i)];
                    busScratch.addSample(scratchOffset + 0, i, s * sm.gL);
                    busScratch.addSample(scratchOffset + 1, i, s * sm.gR);
                }
            }
        }

        // Click strip meter: always post gain+pan, even when muted.
        if (!meteringMuted) {
            float peakL = 0.0f;
            float peakR = 0.0f;
            for (int i = 0; i < numSamples; ++i) {
                const float s =
                    std::abs(clickScratch[static_cast<size_t>(i)]);
                peakL = std::max(peakL, s * clickSmoothGL);
                peakR = std::max(peakR, s * clickSmoothGR);
            }
            atomicMaxFloat(clickPeakIntervalMaxL, peakL);
            atomicMaxFloat(clickPeakIntervalMaxR, peakR);
            MeterFrame frame;
            frame.peakDb = linearPeakToDb(std::max(peakL, peakR));
            frame.peakDbL = linearPeakToDb(peakL);
            frame.peakDbR = linearPeakToDb(peakR);
            frame.truePeakDb = frame.peakDb;
            clickMeterFrame.write(frame);
        } else {
            clickPeakIntervalMaxL.store(0.0f, std::memory_order_relaxed);
            clickPeakIntervalMaxR.store(0.0f, std::memory_order_relaxed);
            clickMeterFrame.write(MeterFrame{});
        }
    }

    // Pass 3: bus scratch buffers -> metering + physical outputs.
    //
    // Multiple busses may share the same Ext. Out pair (master + aux send on
    // Out 1/2 is the common case). Every non-muted source bus ALWAYS folds
    // into the matching mono Direct Output lane(s) with += -- never replaces --
    // and the lane is the single terminal writer to physical. Mono busses
    // (channelCount == 1) still hit BOTH lanes of the pair starting at
    // startChannel so a mono master/track doesn't disappear from one side.

    // physical channel -> the mono Direct Output lane's bus index (or -1).
    std::vector<int> laneBusIndexFor(
        numOutputChannels > 0 ? static_cast<size_t>(numOutputChannels) : 0, -1);
    for (const BusOutput& o : snap->outputs) {
        if (!o.singleChannel)
            continue;
        if (o.startChannel >= 0 && o.startChannel < numOutputChannels)
            laneBusIndexFor[static_cast<size_t>(o.startChannel)] = static_cast<int>(o.busIndex);
    }

    for (const BusOutput& out : snap->outputs) {
        if (out.busIndex >= busses.size())
            continue;
        const int scratchOffset = static_cast<int>(out.busIndex) * 2;
        // Never treat a bus as 0-channel (would skip the physical write entirely
        // and silence a send that shares the master's Ext. Out).
        const int channels = std::max(1, std::min(2, out.channelCount));
        if (scratchOffset + std::max(channels, 1) > scratchChannels)
            continue;

        const float busGain = (out.mute || !std::isfinite(out.gainLinear)) ? 0.0f : out.gainLinear;
        // Balance pan (same law as track pan): attenuate L or R.
        const float pan = std::isfinite(out.pan) ? out.pan : 0.0f;
        const float gL = busGain * (1.0f - std::max(0.0f, pan));
        const float gR = busGain * (1.0f + std::min(0.0f, pan));

        if (!meteringMuted && out.busIndex < busLoudnessMeters.size()) {
            const float* pL = busScratch.getReadPointer(scratchOffset);
            const float* pR = channels > 1 ? busScratch.getReadPointer(scratchOffset + 1)
                                         : pL;
            if (pR == nullptr) pR = pL;

            constexpr int kMaxMeterBuf = 2048;
            float meterBufL[kMaxMeterBuf];
            float meterBufR[kMaxMeterBuf];
            const int sampleCount = std::min(numSamples, kMaxMeterBuf);
            float peakL = 0.0f;
            float peakR = 0.0f;

            for (int i = 0; i < sampleCount; ++i) {
                const float sampleL = (pL != nullptr && std::isfinite(pL[i])) ? pL[i] * gL : 0.0f;
                const float sampleR = (pR != nullptr && std::isfinite(pR[i])) ? pR[i] * gR : sampleL;
                meterBufL[i] = sampleL;
                meterBufR[i] = sampleR;
                peakL = std::max(peakL, std::abs(sampleL));
                peakR = std::max(peakR, std::abs(sampleR));
            }

            const float* meterChannels[2] = { meterBufL, meterBufR };
            busLoudnessMeters[out.busIndex].processBlock(meterChannels, sampleCount);
            if (out.busIndex < busMeters.size() && busMeters[out.busIndex] != nullptr)
                busMeters[out.busIndex]->write(busLoudnessMeters[out.busIndex].currentFrame());

            // Interval max of post-mix bus peaks (includes metronome mixed
            // into this bus above). A ~30ms click is often gone before the
            // next 30 Hz UI poll reads the SeqLock -- same class of bug the
            // dedicated click strip fixed with clickPeakIntervalMax*.
            if (out.busIndex < busPeakIntervalCount && busPeakIntervalMaxL
                && busPeakIntervalMaxR) {
                atomicMaxFloat(busPeakIntervalMaxL[out.busIndex], peakL);
                atomicMaxFloat(busPeakIntervalMaxR[out.busIndex], peakR);
            }
        } else if (meteringMuted && out.busIndex < busMeters.size() && busMeters[out.busIndex] != nullptr) {
            busMeters[out.busIndex]->write(MeterFrame{});
        }

        if (out.mute)
            continue;
        if (out.singleChannel) {
            // Mono Direct Output lane: carries the accumulated mix of every
            // source folded into it (main/aux/sends + lane sends) and is the
            // terminal writer to its ONE physical channel.
            const float* src = busScratch.getReadPointer(scratchOffset + 0);
            if (src == nullptr)
                continue;
            const int physicalCh = out.startChannel;
            if (physicalCh < 0 || physicalCh >= numOutputChannels
                || outputChannelData[physicalCh] == nullptr)
                continue;
            float* dst = outputChannelData[physicalCh];
            const float g = busGain;
            for (int i = 0; i < numSamples; ++i)
                dst[i] += src[i] * g;
            continue;
        }

        // Project bus (main / aux / send) physical egress: fold the bus into
        // the matching mono Direct Output lane(s) -- the lane is the real
        // terminal writer and its meter shows the actual channel content.
        // An inactive lane (unavailable output) is simply absent, so that
        // slice drops to silence without touching the mapping.
        {
            const int start = out.startChannel;
            if (channels == 1) {
                // MONO project / aux bush: plasma to exactly ONE physical
                // channel (its start). The legacy "mono hits both speakers"
                // pair-doubling overlapped adjacent sends and made a mono
                // click / send louder in one ear (see egressChannels()).
                int ch0 = 0, chDummy = 0;
                routing_math::egressChannels(1, start, ch0, chDummy);
                if (ch0 < 0 || ch0 >= numOutputChannels)
                    continue;
                const int laneBusIndex = laneBusIndexFor[static_cast<size_t>(ch0)];
                if (laneBusIndex < 0)
                    continue;
                const float* src = busScratch.getReadPointer(scratchOffset + 0);
                if (src == nullptr)
                    continue;
                const int laneOff = laneBusIndex * 2;
                if (laneOff + 1 > scratchChannels)
                    continue;
                float* dst = busScratch.getWritePointer(laneOff + 0);
                for (int i = 0; i < numSamples; ++i)
                    dst[i] += src[i] * gL;
            } else {
                // Stereo: L -> lane(start), R -> lane(start+1).
                const float* srcL = busScratch.getReadPointer(scratchOffset + 0);
                if (srcL == nullptr)
                    continue;
                const float* srcR = busScratch.getReadPointer(scratchOffset + 1);
                if (srcR == nullptr)
                    srcR = srcL;
                const float* srcs[2] = { srcL, srcR };
                const float gains[2] = { gL, gR };
                for (int c = 0; c < 2; ++c) {
                    if (start + c < 0 || start + c >= numOutputChannels)
                        continue;
                    const int laneBusIndex =
                        laneBusIndexFor[static_cast<size_t>(start + c)];
                    if (laneBusIndex < 0)
                        continue;
                    const int laneOff = laneBusIndex * 2;
                    if (laneOff + 1 > scratchChannels)
                        continue;
                    float* dst = busScratch.getWritePointer(laneOff + 0);
                    const float* src = srcs[c];
                    const float g = gains[c];
                    for (int i = 0; i < numSamples; ++i)
                        dst[i] += src[i] * g;
                }
            }
        }
    }

    // Main (FOH) master meter = the physical output composite. Every bus
    // whose destination is Main (the "same outs as Main" send routing) folds
    // into the same Direct Output lanes with `+=`, so Main's own splice
    // would miss sends/aux/click stacked on top of it. Read the summed lane
    // content after the fold so the master needle shows what actually leaves.
    {
        const auto mainIt = busIndexById.find("main");
        if (!meteringMuted && mainIt != busIndexById.end()) {
            const size_t mainIdx = mainIt->second;
            if (mainIdx < busses.size() && mainIdx < busMeters.size()
                && busMeters[mainIdx] != nullptr) {
                int mainStart = -1;
                int mainChannels = 0;
                for (const BusOutput& o : snap->outputs) {
                    if (o.busIndex != mainIdx || o.singleChannel)
                        continue;
                    mainStart = o.startChannel;
                    mainChannels = o.channelCount;
                    break;
                }
                if (mainStart >= 0 && mainChannels > 0) {
                    constexpr int kMaxMeterBuf = 2048;
                    float meterBufL[kMaxMeterBuf];
                    float meterBufR[kMaxMeterBuf];
                    const int sampleCount = std::min(numSamples, kMaxMeterBuf);
                    for (int i = 0; i < sampleCount; ++i) {
                        meterBufL[i] = 0.0f;
                        meterBufR[i] = 0.0f;
                    }
                    float peakL = 0.0f;
                    float peakR = 0.0f;
                    const int chCount = std::min(2, mainChannels);
                    for (int c = 0; c < chCount; ++c) {
                        const int phys = mainStart + c;
                        if (phys < 0 || phys >= numOutputChannels)
                            continue;
                        const int laneBus =
                            laneBusIndexFor[static_cast<size_t>(phys)];
                        if (laneBus < 0)
                            continue;
                        const int laneOff = laneBus * 2;
                        const float* src = busScratch.getReadPointer(laneOff);
                        if (src == nullptr)
                            continue;
                        float* dst = c == 0 ? meterBufL : meterBufR;
                        float& peakRef = c == 0 ? peakL : peakR;
                        for (int i = 0; i < sampleCount; ++i) {
                            const float v = src[i];
                            dst[i] = v;
                            if (std::abs(v) > peakRef)
                                peakRef = std::abs(v);
                        }
                    }
                    // Mono main: mirror the single lane into L and R.
                    if (mainChannels == 1) {
                        for (int i = 0; i < sampleCount; ++i)
                            meterBufR[i] = meterBufL[i];
                        peakR = peakL;
                    }
                    const float* meterChannels[2] = { meterBufL, meterBufR };
                    if (mainIdx < busLoudnessMeters.size())
                        busLoudnessMeters[mainIdx].processBlock(
                            meterChannels, sampleCount);
                    busMeters[mainIdx]->write(
                        busLoudnessMeters[mainIdx].currentFrame());
                    if (mainIdx < busPeakIntervalCount && busPeakIntervalMaxL
                        && busPeakIntervalMaxR) {
                        atomicMaxFloat(busPeakIntervalMaxL[mainIdx], peakL);
                        atomicMaxFloat(busPeakIntervalMaxR[mainIdx], peakR);
                    }
                }
            }
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
    if (pendingSongEndAction != SongEndAction::None && underrunFadeOutRemaining == 0
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


} // namespace resostage
