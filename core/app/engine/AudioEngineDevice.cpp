// Audio device setup, hot-plug recovery, and sample-rate re-staging.
// Kept outside AudioEngine.cpp so the real-time render callback remains the
// central focus there. The callback and device lifecycle still share the same
// AudioEngine state and retain their existing thread ownership.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"

#include <algorithm>
#include <cmath>

namespace resostage {

using audio_engine_detail::kRingBufferSeconds;

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

} // namespace resostage
