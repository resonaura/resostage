// Project load / save / new / dirty-autosave for AudioEngine.
// Archive open, draft packages, sync and async save paths.
// Kept in its own translation unit so AudioEngine.cpp doesn't balloon.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"

#include "audio/PeakCache.h"

#include <filesystem>
#include <string>
#include <utility>
#include <vector>


namespace resostage {

using audio_engine_detail::kRingBufferSeconds;
using audio_engine_detail::streamingIoThreadStart;
using audio_engine_detail::streamingIoThreadStop;
using audio_engine_detail::makeDraftArchivePath;
using audio_engine_detail::purgeStaleDrafts;

bool AudioEngine::loadProject(const std::string& path, std::string& error) {
    stop();
    // Background peak builds also read `loader` -- must finish before we
    // start mutating it directly below (streaming.stop() only halts the
    // streaming I/O thread, not these).
    joinPendingPeakBuilds();
    streaming.stop();
    purgeStaleSavePackages();

    if (!loader.open(path, error))
        return false;

    projectHistory.clear(); // a freshly loaded document has no history of its own
    currentSong = static_cast<size_t>(-1);
    trackIdByIndex.clear();
    trackScratch.clear();
    // Drop every gain/pan glide: the strip layout is about to change, so
    // gliding from the old coefficients would be an artefact, not a de-click.
    mixRenderer.resetSmoothing();
    trackMeters.clear();
    trackBandMeters.clear();
    projectLoaded = true;
    // Only meaningful once projectLoaded is set: publishRoutingSnapshot()
    // deliberately no-ops before that, so the first graph has to be published
    // from here rather than earlier in the load.
    publishRoutingSnapshot();
    // A user-chosen / loaded archive is never a draft -- without this, a
    // prior newProject()'s usingDraftArchive=true leaked across Load and
    // made plain Save always open the file picker (hasRealSaveLocation
    // requires !isDraftProject()).
    usingDraftArchive = false;
    midiClockEverStarted = false; // a new project's MIDI clock hasn't started yet -- next play() sends 0xFA, not 0xFB
    clearPeakOverviewCache(); // different archive -- same file path could mean different audio

    // stop() above only freezes the playhead at wherever it was (so a normal
    // Stop/Play resumes in place) -- selectSong() is what actually zeroes it
    // back out when staging a song. If the loaded project has at least one
    // song, ensureSongSelected()/goToSong(0) does that momentarily after this
    // returns. If it has none, nothing else ever will, and the old project's
    // stale position keeps reporting as this one's -- e.g. Player's timeline
    // showing a playhead seconds into a song that no longer exists.
    if (loader.project().songs.empty()) {
        clock.start(currentSampleRate, 0);
        clock.stop();
    }

    streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
    clearDirty();
    // Background-open every song into the warm LRU so the first hopscotch
    // after load isn't a cold stage. Does not require stageEpoch match —
    // only aborts if the project is replaced (warmGeneration).
    {
        const uint64_t warmGen = streaming.warmGeneration();
        const int64_t ringCap = static_cast<int64_t>(currentSampleRate * kRingBufferSeconds);
        const double sr = currentSampleRate;
        const size_t songCount = loader.project().songs.size();
        for (size_t i = 0; i < songCount; ++i) {
            juce::MessageManager::callAsync([this, i, ringCap, sr, warmGen] {
                if (!projectLoaded)
                    return;
                if (streaming.warmGeneration() != warmGen)
                    return;
                const Project& p = loader.project();
                if (i >= p.songs.size())
                    return;
                if (streaming.hasPrecacheFor(i))
                    return;
                if (currentSong == i)
                    return; // already active
                streaming.precacheSong(i, p.songs[i], ringCap, sr,
                                       /*epoch=*/0, /*requireEpochMatch=*/false);
            });
        }
    }
    // Notify LightEngine (and re-apply the Art-Net target) for the newly
    // loaded project.
    notifyLightEngineProjectChanged();
    clock.setSongIndex(0);
    return true;
}

void AudioEngine::newProject(const std::string& name) {
    stop();
    // Same reasoning as loadProject() above -- a brand new project always
    // starts with zero songs, so nothing downstream will reset this.
    clock.start(currentSampleRate, 0);
    clock.stop();
    joinPendingPeakBuilds();
    streaming.stop();

    loader.newProject(name);
    usingDraftArchive = false;
    clearPeakOverviewCache();
    projectHistory.clear(); // a freshly created document has no history of its own

    // Auto-create a draft archive immediately so WAV/song-folder imports
    // work right away. Best-effort: if this fails (disk full, permissions),
    // fall back to no archive at all -- imports will then prompt the user
    // to Save As manually instead (see BuilderPanel::ensureProjectSaved).
    std::string draftPath, draftError;
    if (makeDraftArchivePath(draftPath, draftError) && loader.saveAs(draftPath, draftError)
        && loader.open(draftPath, draftError)) {
        usingDraftArchive = true;
    }

    projectLoaded = true;
    publishRoutingSnapshot();
    midiClockEverStarted = false;

    if (!loader.project().songs.empty()) {
        std::string err;
        selectSong(0, err);
    } else {
        currentSong = static_cast<size_t>(-1);
        trackIdByIndex.clear();
        trackScratch.clear();
        trackMeters.clear();
    trackBandMeters.clear();
    }

    streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
    clearDirty();
    // Notify LightEngine (and re-apply the Art-Net target) for the new
    // (empty) project.
    notifyLightEngineProjectChanged();
    clock.setSongIndex(0);
}


void AudioEngine::markDirty() {
    unsavedChanges.store(true, std::memory_order_release);
    if (!projectLoaded)
        return;
    // Mid-show: don't thrash the same SSD as stem refill. Flush on stop.
    if (playing.load(std::memory_order_acquire)) {
        autosaveDeferred.store(true, std::memory_order_release);
        return;
    }
    std::string err;
    loader.saveAutosave(err);
    autosaveDeferred.store(false, std::memory_order_release);
}

void AudioEngine::flushDeferredAutosave() {
    if (!autosaveDeferred.exchange(false, std::memory_order_acq_rel))
        return;
    if (!projectLoaded || !unsavedChanges.load(std::memory_order_acquire))
        return;
    std::string err;
    loader.saveAutosave(err);
}

bool AudioEngine::saveProject(const std::string& path, std::string& error) {
    if (!projectLoaded) {
        error = "No project loaded";
        return false;
    }

    {
        const juce::String stem = juce::File(path).getFileNameWithoutExtension();
        if (stem.isNotEmpty())
            loader.project().name = stem.toStdString();
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    const bool overwriteOpen = (path == loader.archivePath());
    const bool promotingDraft = usingDraftArchive && !overwriteOpen;
    const bool switchingToNewPath = !overwriteOpen && !promotingDraft;
    const std::string oldDraftPath = usingDraftArchive ? loader.archivePath() : std::string();
    Project snapshot = loader.project();
    std::string sourcePath = loader.archivePath();
    const bool isContainer = loader.isDirectoryContainer();
    const bool playThroughOk =
        isContainer && !promotingDraft && overwriteOpen && wasPlaying;

    namespace fs = std::filesystem;
    auto replacePath = [](const std::string& from, const std::string& to, std::string& err) -> bool {
        std::error_code ec;
        fs::remove_all(to, ec);
        fs::rename(from, to, ec);
        if (ec) {
            err = "Failed to replace archive: " + ec.message();
            return false;
        }
        return true;
    };

    // ── Play-through overwrite (directory package, same path, while playing) ──
    if (playThroughOk) {
        const std::string tempOut = path + ".saving";
        if (!loader.saveAsWithExtras(tempOut, pendingPeakCacheExtras, error, &snapshot))
            return false;
        const std::string aside = path + ".play-old";
        std::error_code ec;
        fs::remove_all(aside, ec);
        fs::rename(path, aside, ec);
        if (ec) {
            fs::remove_all(tempOut, ec);
            error = "Failed to park live package: " + ec.message();
            return false;
        }
        fs::rename(tempOut, path, ec);
        if (ec) {
            std::error_code ec2;
            fs::rename(aside, path, ec2);
            fs::remove_all(tempOut, ec2);
            error = "Failed to install saved package: " + ec.message();
            return false;
        }
        fs::remove_all(aside, ec);
        if (ec)
            staleSavePackages.push_back(aside);
        usingDraftArchive = false;
        clearDirty();
        clearAutosave();
        return true;
    }

    // ── Classic path: stop / write / reopen / restage ──
    stop();
    joinPendingPeakBuilds();
    streaming.stop();
    purgeStaleSavePackages();

    if (overwriteOpen || promotingDraft) {
        const std::string tempOut = path + ".new";
        if (!loader.saveAsWithExtras(tempOut, pendingPeakCacheExtras, error, &snapshot))
            return false;

        loader.close();
        if (!replacePath(tempOut, path, error)) {
            (void)loader.open(sourcePath, error);
            projectLoaded = loader.isOpen();
            if (projectLoaded)
                streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
            return false;
        }
        if (!loader.open(path, error)) {
            projectLoaded = false;
            return false;
        }
        if (promotingDraft) {
            usingDraftArchive = false;
            if (!oldDraftPath.empty() && oldDraftPath != path) {
                std::error_code ec;
                fs::remove_all(oldDraftPath, ec);
            }
        }
    } else if (switchingToNewPath) {
        if (!loader.saveAsWithExtras(path, pendingPeakCacheExtras, error, &snapshot))
            return false;
        loader.close();
        if (!loader.open(path, error)) {
            projectLoaded = false;
            return false;
        }
        usingDraftArchive = false;
        if (!oldDraftPath.empty() && oldDraftPath != path) {
            std::error_code ec;
            fs::remove_all(oldDraftPath, ec);
        }
    } else {
        if (!loader.saveAsWithExtras(path, pendingPeakCacheExtras, error, &snapshot))
            return false;

        if (!loader.isOpen()) {
            if (!loader.open(path, error)) {
                projectLoaded = false;
                return false;
            }
        }
    }

    projectLoaded = true;
    publishRoutingSnapshot();
    streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);

    currentSong = static_cast<size_t>(-1);
    trackIdByIndex.clear();
    trackScratch.clear();
    // Drop every gain/pan glide: the strip layout is about to change, so
    // gliding from the old coefficients would be an artefact, not a de-click.
    mixRenderer.resetSmoothing();
    trackMeters.clear();
    trackBandMeters.clear();

    const auto& projTracks = loader.project().tracks;
    if (!projTracks.empty()) {
        for (const auto& t : projTracks)
            trackIdByIndex.push_back(t.id);
        trackScratch.assign(trackIdByIndex.size(), juce::AudioBuffer<float>());
        ensureTrackMeters(trackIdByIndex.size());
        ensureScratchSizes();
        publishRoutingSnapshot();
    }

    if (songToRestore != static_cast<size_t>(-1)
        && songToRestore < loader.project().songs.size()) {
        std::string selectError;
        if (!selectSong(songToRestore, selectError)) {
            error = "Saved, but failed to restage song: " + selectError;
            return false;
        }
        if (wasPlaying)
            play();
    }
    clearDirty();
    clearAutosave();
    return true;
}

void AudioEngine::purgeStaleSavePackages() {
    namespace fs = std::filesystem;
    for (const auto& p : staleSavePackages) {
        std::error_code ec;
        fs::remove_all(p, ec);
    }
    staleSavePackages.clear();
}

void AudioEngine::saveProjectAsync(const std::string& path,
                                   std::function<void(bool success, std::string error)> onComplete) {
    if (!projectLoaded) {
        if (onComplete)
            onComplete(false, "No project loaded");
        return;
    }
    if (busySaving.exchange(true) || busyImporting.load(std::memory_order_acquire)) {
        busySaving.store(false);
        if (onComplete)
            onComplete(false, "Already busy");
        return;
    }
    if (saveThread.joinable())
        saveThread.join();

    // Update display name on the live project before snapshotting.
    {
        const juce::String stem = juce::File(path).getFileNameWithoutExtension();
        if (stem.isNotEmpty())
            loader.project().name = stem.toStdString();
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    const bool promotingDraft = usingDraftArchive && path != loader.archivePath();
    const std::string oldDraftPath = usingDraftArchive ? loader.archivePath() : std::string();
    const std::string sourcePath = loader.archivePath();
    const bool isContainer = loader.isDirectoryContainer();
    // Same-path overwrite of a directory package can swap under live FILE*
    // cursors (they keep reading the old inodes). Save-As / draft promote /
    // legacy ZIP still need a restage.
    const bool playThroughOk = isContainer && !promotingDraft && path == sourcePath && wasPlaying;
    Project snapshot = loader.project();
    auto extras = pendingPeakCacheExtras;
    const std::string tempOut = path + ".saving";

    // Heavy archive write off the message thread. Directory packages copy via
    // the filesystem (no shared zip handle). saveAsWithExtras no longer mutates
    // openArchivePath, so streaming keeps the correct live path the whole time.
    saveThread = std::thread([this, path, tempOut, snapshot, extras, sourcePath, promotingDraft,
                              oldDraftPath, songToRestore, wasPlaying, playThroughOk, isContainer,
                              onComplete]() mutable {
        std::string error;
        // Legacy ZIP shares mz_zip with streaming — serialize against IO.
        bool wrote = false;
        if (isContainer) {
            wrote = loader.saveAsWithExtras(tempOut, extras, error, &snapshot);
        } else {
            streaming.withProjectLoaderLock([&] {
                wrote = loader.saveAsWithExtras(tempOut, extras, error, &snapshot);
            });
        }

        juce::MessageManager::callAsync([this, wrote, error, path, tempOut, sourcePath, promotingDraft,
                                         oldDraftPath, songToRestore, wasPlaying, playThroughOk,
                                         onComplete]() {
            namespace fs = std::filesystem;
            auto finish = [&](bool ok, const std::string& err) {
                busySaving.store(false, std::memory_order_release);
                if (onComplete)
                    onComplete(ok, err);
            };

            if (!wrote) {
                std::error_code ec;
                fs::remove_all(tempOut, ec);
                finish(false, error.empty() ? "Save failed" : error);
                return;
            }

            std::error_code ec;

            if (playThroughOk) {
                // ── Titanic save: keep playing across the package swap ──
                // 1) rename live package aside (open FILE* keep old inodes)
                // 2) rename temp into place
                // 3) leave streaming alone; defer delete of the aside dir
                const std::string aside = path + ".play-old";
                fs::remove_all(aside, ec); // previous interrupted save
                fs::rename(path, aside, ec);
                if (ec) {
                    fs::remove_all(tempOut, ec);
                    finish(false, "Failed to park live package: " + ec.message());
                    return;
                }
                fs::rename(tempOut, path, ec);
                if (ec) {
                    // Roll back so openArchivePath still matches on-disk.
                    std::error_code ec2;
                    fs::rename(aside, path, ec2);
                    fs::remove_all(tempOut, ec2);
                    finish(false, "Failed to install saved package: " + ec.message());
                    return;
                }
                // Open stem FILE* still hold the old inodes after rename —
                // unlinking the aside tree is safe (POSIX); free disk ASAP.
                fs::remove_all(aside, ec);
                if (ec)
                    staleSavePackages.push_back(aside);
                // openArchivePath already equals `path`.
                usingDraftArchive = false;
                clearDirty();
                clearAutosave();
                finish(true, {});
                return;
            }

            // ── Classic path: stop streaming, replace, reopen, restage ──
            const bool keepPlaying = wasPlaying;
            stop();
            streaming.stop();
            joinPendingPeakBuilds();
            purgeStaleSavePackages(); // safe: no open stem FDs into old packages

            loader.close();
            fs::remove_all(path, ec);
            fs::rename(tempOut, path, ec);
            if (ec) {
                std::string recoverErr;
                (void)loader.open(sourcePath, recoverErr);
                projectLoaded = loader.isOpen();
                if (projectLoaded)
                    streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
                finish(false, "Failed to replace archive: " + ec.message());
                return;
            }

            std::string openErr;
            if (!loader.open(path, openErr)) {
                projectLoaded = false;
                finish(false, openErr);
                return;
            }
            usingDraftArchive = false;
            if (promotingDraft && !oldDraftPath.empty() && oldDraftPath != path) {
                fs::remove_all(oldDraftPath, ec);
            }

            projectLoaded = true;
            publishRoutingSnapshot();
            streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);

            currentSong = static_cast<size_t>(-1);
            trackIdByIndex.clear();
            trackScratch.clear();
            // Drop every gain/pan glide: the strip layout is about to change, so
            // gliding from the old coefficients would be an artefact, not a de-click.
            mixRenderer.resetSmoothing();
            trackMeters.clear();
    trackBandMeters.clear();
            const auto& projTracks = loader.project().tracks;
            if (!projTracks.empty()) {
                for (const auto& t : projTracks)
                    trackIdByIndex.push_back(t.id);
                trackScratch.assign(trackIdByIndex.size(), juce::AudioBuffer<float>());
                ensureTrackMeters(trackIdByIndex.size());
                ensureScratchSizes();
                publishRoutingSnapshot();
            }

            if (songToRestore != static_cast<size_t>(-1)
                && songToRestore < loader.project().songs.size()) {
                std::string selectError;
                if (selectSong(songToRestore, selectError) && keepPlaying)
                    play();
            }
            clearDirty();
            clearAutosave();
            finish(true, {});
        });
    });
}

} // namespace resostage
