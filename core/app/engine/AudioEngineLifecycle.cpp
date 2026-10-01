// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

// AudioEngine construction and teardown order.
// Keep worker startup and shutdown sequencing together, separate from the
// realtime callback implementation and message-thread meter snapshots.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"

namespace resostage {

using audio_engine_detail::purgeStaleDrafts;

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

} // namespace resostage
