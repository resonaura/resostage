// Project load / save / new / dirty-autosave for AudioEngine.
// Archive open, draft packages, sync and async save paths.
// Kept in its own translation unit so AudioEngine.cpp doesn't balloon.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"

#include "audio/peaks/PeakCache.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <cstdio>
#include <string>
#include <thread>
#include <utility>
#include <vector>


#if JUCE_WINDOWS
#include <windows.h>
#endif

namespace resostage {

namespace {

using PluginStateReferences = std::vector<std::pair<std::string, std::string>>;

PluginSlot* findPluginSlot(Project& project, const std::string& slotId) {
    const auto findIn = [&slotId](std::vector<PluginSlot>& slots) -> PluginSlot* {
        const auto it = std::find_if(slots.begin(), slots.end(),
            [&slotId](const PluginSlot& slot) { return slot.id == slotId; });
        return it == slots.end() ? nullptr : &*it;
    };
    if (auto* slot = findIn(project.main.plugins)) return slot;
    if (auto* slot = findIn(project.click.plugins)) return slot;
    for (auto& track : project.tracks)
        if (auto* slot = findIn(track.plugins)) return slot;
    for (auto& send : project.sends)
        if (auto* slot = findIn(send.plugins)) return slot;
    return nullptr;
}

std::string pluginStateResourceFor(const PluginSlot& slot) {
    // Slot IDs are UUIDv7 today. Keep the fallback path portable for older
    // projects that may contain punctuation not accepted in Windows names.
    std::string filename = slot.id;
    bool sanitized = false;
    for (char& c : filename) {
        const auto uc = static_cast<unsigned char>(c);
        if (!std::isalnum(uc) && c != '-' && c != '_') {
            c = '_';
            sanitized = true;
        }
    }
    if (filename.empty())
        filename = "unnamed";
    if (sanitized) {
        uint64_t hash = 1469598103934665603ull;
        for (const char raw : slot.id) {
            const auto c = static_cast<unsigned char>(raw);
            hash ^= c;
            hash *= 1099511628211ull;
        }
        filename += "_" + std::to_string(hash);
    }
    return "Plugins/" + filename + ".state";
}

PluginStateReferences appendPluginStateFiles(
    Project& project, std::vector<ProjectLoader::ExtraFile>& extras,
    PluginProcessorBank::StateSnapshot&& state) {
    for (const auto& warning : state.warnings)
        std::fprintf(stderr, "[PluginState] %s\n", warning.c_str());

    PluginStateReferences references;
    references.reserve(state.blobs.size());
    for (auto& blob : state.blobs) {
        auto* slot = findPluginSlot(project, blob.slotId);
        if (slot == nullptr)
            continue;
        const std::string resource = pluginStateResourceFor(*slot);
        slot->stateResource = resource;
        extras.push_back({resource, std::move(blob.data)});
        references.emplace_back(blob.slotId, resource);
    }
    return references;
}

void applyPluginStateReferences(Project& project,
                                const PluginStateReferences& references) {
    for (const auto& [slotId, resource] : references)
        if (auto* slot = findPluginSlot(project, slotId))
            slot->stateResource = resource;
}

PluginProcessorBank::StateSnapshot capturePluginStatesOffThread(
    const std::shared_ptr<PluginProcessorBank>& bank) {
    PluginProcessorBank::StateSnapshot state;
    if (bank == nullptr)
        return state;
    std::thread worker([&state, bank] { state = bank->snapshotStates(); });
    worker.join();
    return state;
}

} // namespace

static void forceClearAttributes(const std::filesystem::path& p) {
#if JUCE_WINDOWS
    namespace fs = std::filesystem;
    std::error_code ec;
    if (p.empty() || !fs::exists(p, ec))
        return;
    if (fs::is_directory(p, ec)) {
        for (const auto& entry : fs::recursive_directory_iterator(p, fs::directory_options::skip_permission_denied, ec)) {
            const std::wstring w = entry.path().wstring();
            DWORD attrs = ::GetFileAttributesW(w.c_str());
            if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_HIDDEN))) {
                ::SetFileAttributesW(w.c_str(), attrs & ~(FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_HIDDEN));
            }
        }
    }
    const std::wstring w = p.wstring();
    DWORD attrs = ::GetFileAttributesW(w.c_str());
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_HIDDEN))) {
        ::SetFileAttributesW(w.c_str(), attrs & ~(FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_HIDDEN));
    }
#else
    (void)p;
#endif
}

static void forceRemoveAll(const std::filesystem::path& p, std::error_code& ec) {
    namespace fs = std::filesystem;
    ec.clear();
    if (p.empty() || !fs::exists(p, ec))
        return;
    forceClearAttributes(p);
    fs::remove_all(p, ec);
}

static bool replacePathHelper(const std::string& from, const std::string& to, [[maybe_unused]] std::string& err, std::vector<std::string>* stalePackages = nullptr) {
    namespace fs = std::filesystem;
    std::error_code ec;

    // Case 1: Target directory does not exist yet (e.g. initial Save As to brand new path)
    if (!fs::exists(to, ec)) {
        forceClearAttributes(from);
        fs::rename(from, to, ec);
        if (!ec)
            return true;
        // If rename failed, copy files into target
        ec.clear();
        for (const auto& entry : fs::recursive_directory_iterator(from, fs::directory_options::skip_permission_denied, ec)) {
            if (entry.is_regular_file(ec)) {
                fs::path rel = fs::relative(entry.path(), from, ec);
                fs::path targetFile = fs::path(to) / rel;
                fs::create_directories(targetFile.parent_path(), ec);
                forceClearAttributes(targetFile);
                fs::copy_file(entry.path(), targetFile, fs::copy_options::overwrite_existing, ec);
            }
        }
        forceRemoveAll(from, ec);
        return true;
    }

    // Case 2: Target directory exists (overwriting existing project)
    // Try fast atomic directory swap via .old
    const std::string aside = to + ".old";
    forceRemoveAll(aside, ec);
    forceClearAttributes(to);

    std::error_code renameEc;
    fs::rename(to, aside, renameEc);
    if (!renameEc) {
        forceClearAttributes(from);
        fs::rename(from, to, renameEc);
        if (!renameEc) {
            forceRemoveAll(aside, ec);
            if (ec && stalePackages)
                stalePackages->push_back(aside);
            return true;
        }
        // Rollback rename if from -> to failed
        std::error_code rollEc;
        forceClearAttributes(aside);
        fs::rename(aside, to, rollEc);
    }

    // Fallback: directory rename was blocked by OS / Explorer / Defender locks.
    // Sync files in-place from `from` into `to` (overwriting files in `to`).
    std::error_code copyEc;
    for (const auto& entry : fs::recursive_directory_iterator(from, fs::directory_options::skip_permission_denied, copyEc)) {
        if (entry.is_regular_file(copyEc)) {
            fs::path rel = fs::relative(entry.path(), from, copyEc);
            fs::path targetFile = fs::path(to) / rel;
            fs::create_directories(targetFile.parent_path(), copyEc);
            forceClearAttributes(targetFile);
            fs::copy_file(entry.path(), targetFile, fs::copy_options::overwrite_existing, copyEc);
        }
    }

    // Clean up temporary `from` (.saving) package
    forceRemoveAll(from, ec);
    // Clean up `aside` (.old) package if left over
    if (fs::exists(aside, ec)) {
        forceRemoveAll(aside, ec);
        if (ec && stalePackages)
            stalePackages->push_back(aside);
    }

    return true;
}

using audio_engine_detail::kRingBufferSeconds;
using audio_engine_detail::streamingIoThreadStart;
using audio_engine_detail::streamingIoThreadStop;
using audio_engine_detail::residentIoYield;
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

    streaming.start(&loader,
                    streamingIoThreadStart,
                    streamingIoThreadStop, demoteBackgroundWorkerPriority,
                    residentIoYield);
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
                if (currentSong == i && static_cast<bool>(streaming.acquireActiveSong()))
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

    streaming.start(&loader,
                    streamingIoThreadStart,
                    streamingIoThreadStop, demoteBackgroundWorkerPriority,
                    residentIoYield);

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
    auto capturedPluginState = capturePluginStatesOffThread(
        activePluginProcessorBank());
    Project snapshot = loader.project();
    auto saveExtras = pendingPeakCacheExtras;
    const auto pluginStateReferences = appendPluginStateFiles(
        snapshot, saveExtras, std::move(capturedPluginState));
    std::string sourcePath = loader.archivePath();
    [[maybe_unused]] const bool isContainer = loader.isDirectoryContainer();
#if JUCE_WINDOWS
    const bool playThroughOk = false;
#else
    const bool playThroughOk =
        isContainer && !promotingDraft && overwriteOpen && wasPlaying;
#endif

    namespace fs = std::filesystem;
    auto replacePath = [this](const std::string& from, const std::string& to, std::string& err) -> bool {
        return replacePathHelper(from, to, err, &staleSavePackages);
    };

    // ── Play-through overwrite (directory package, same path, while playing) ──
    if (playThroughOk) {
        const std::string tempOut = path + ".saving";
        if (!loader.saveAsWithExtras(tempOut, saveExtras, error, &snapshot))
            return false;
        const std::string aside = path + ".play-old";
        std::error_code ec;
        forceRemoveAll(aside, ec);
        forceClearAttributes(path);
        fs::rename(path, aside, ec);
        if (ec) {
            forceRemoveAll(tempOut, ec);
            error = "Failed to park live package: " + ec.message();
            return false;
        }
        forceClearAttributes(tempOut);
        fs::rename(tempOut, path, ec);
        if (ec) {
            std::error_code ec2;
            forceClearAttributes(aside);
            fs::rename(aside, path, ec2);
            forceRemoveAll(tempOut, ec2);
            error = "Failed to install saved package: " + ec.message();
            return false;
        }
        forceRemoveAll(aside, ec);
        if (ec)
            staleSavePackages.push_back(aside);
        applyPluginStateReferences(loader.project(), pluginStateReferences);
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
        if (!loader.saveAsWithExtras(tempOut, saveExtras, error, &snapshot))
            return false;

        loader.close();
        if (!replacePath(tempOut, path, error)) {
            (void)loader.open(sourcePath, error);
            projectLoaded = loader.isOpen();
            if (projectLoaded)
                streaming.start(&loader,
                    streamingIoThreadStart,
                    streamingIoThreadStop, demoteBackgroundWorkerPriority,
                    residentIoYield);
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
                forceRemoveAll(oldDraftPath, ec);
            }
        }
    } else if (switchingToNewPath) {
        if (!loader.saveAsWithExtras(path, saveExtras, error, &snapshot))
            return false;
        loader.close();
        if (!loader.open(path, error)) {
            projectLoaded = false;
            return false;
        }
        usingDraftArchive = false;
        if (!oldDraftPath.empty() && oldDraftPath != path) {
            std::error_code ec;
            forceRemoveAll(oldDraftPath, ec);
        }
    } else {
        if (!loader.saveAsWithExtras(path, saveExtras, error, &snapshot))
            return false;

        if (!loader.isOpen()) {
            if (!loader.open(path, error)) {
                projectLoaded = false;
                return false;
            }
        }
    }

    projectLoaded = true;
    applyPluginStateReferences(loader.project(), pluginStateReferences);
    publishRoutingSnapshot();
    streaming.start(&loader,
                    streamingIoThreadStart,
                    streamingIoThreadStop, demoteBackgroundWorkerPriority,
                    residentIoYield);

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
        forceRemoveAll(p, ec);
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
#if JUCE_WINDOWS
    const bool playThroughOk = false;
#else
    const bool playThroughOk = isContainer && !promotingDraft && path == sourcePath && wasPlaying;
#endif
    Project snapshot = loader.project();
    auto extras = pendingPeakCacheExtras;
    auto pluginBank = activePluginProcessorBank();
    const std::string tempOut = path + ".saving";

    // Heavy archive write off the message thread. Directory packages copy via
    // the filesystem (no shared zip handle). saveAsWithExtras no longer mutates
    // openArchivePath, so streaming keeps the correct live path the whole time.
    saveThread = std::thread([this, path, tempOut, snapshot, extras, sourcePath, promotingDraft,
                              oldDraftPath, songToRestore, wasPlaying, playThroughOk, isContainer,
                              pluginBank, onComplete]() mutable {
        std::string error;
        auto pluginStateReferences = appendPluginStateFiles(
            snapshot, extras,
            pluginBank != nullptr
                ? pluginBank->snapshotStates()
                : PluginProcessorBank::StateSnapshot{});
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
                                         savedPluginStateReferences = std::move(pluginStateReferences),
                                         onComplete]() {
            namespace fs = std::filesystem;
            auto finish = [&](bool ok, const std::string& err) {
                busySaving.store(false, std::memory_order_release);
                if (onComplete)
                    onComplete(ok, err);
            };

            if (!wrote) {
                std::error_code ec;
                forceRemoveAll(tempOut, ec);
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
                forceRemoveAll(aside, ec); // previous interrupted save
                forceClearAttributes(path);
                fs::rename(path, aside, ec);
                if (ec) {
                    forceRemoveAll(tempOut, ec);
                    finish(false, "Failed to park live package: " + ec.message());
                    return;
                }
                forceClearAttributes(tempOut);
                fs::rename(tempOut, path, ec);
                if (ec) {
                    // Roll back so openArchivePath still matches on-disk.
                    std::error_code ec2;
                    forceClearAttributes(aside);
                    fs::rename(aside, path, ec2);
                    forceRemoveAll(tempOut, ec2);
                    finish(false, "Failed to install saved package: " + ec.message());
                    return;
                }
                // Open stem FILE* still hold the old inodes after rename —
                // unlinking the aside tree is safe (POSIX); free disk ASAP.
                forceRemoveAll(aside, ec);
                if (ec)
                    staleSavePackages.push_back(aside);
                // openArchivePath already equals `path`.
                applyPluginStateReferences(loader.project(), savedPluginStateReferences);
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
            std::string replaceErr;
            if (!replacePathHelper(tempOut, path, replaceErr, &staleSavePackages)) {
                std::string recoverErr;
                (void)loader.open(sourcePath, recoverErr);
                projectLoaded = loader.isOpen();
                if (projectLoaded)
                    streaming.start(&loader,
                    streamingIoThreadStart,
                    streamingIoThreadStop, demoteBackgroundWorkerPriority,
                    residentIoYield);
                finish(false, replaceErr.empty() ? "Failed to replace archive" : replaceErr);
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
                forceRemoveAll(oldDraftPath, ec);
            }

            projectLoaded = true;
            applyPluginStateReferences(loader.project(), savedPluginStateReferences);
            publishRoutingSnapshot();
            streaming.start(&loader,
                    streamingIoThreadStart,
                    streamingIoThreadStop, demoteBackgroundWorkerPriority,
                    residentIoYield);

            {
                // The callback reads these vectors while holding the same
                // mutex with a non-blocking try_lock. Keep reset/reprepare
                // under it: clearing BandEnergyMeter while currentLevels()
                // runs caused an observed Core SIGSEGV during save/reopen.
                std::lock_guard<std::recursive_mutex> routeLock(routingMutex);
                currentSong = static_cast<size_t>(-1);
                trackIdByIndex.clear();
                trackScratch.clear();
                // Drop every gain/pan glide: the strip layout is about to
                // change, so gliding from the old coefficients would be an
                // artefact, not a de-click.
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
                }
            }
            if (!trackIdByIndex.empty())
                publishRoutingSnapshot();

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
