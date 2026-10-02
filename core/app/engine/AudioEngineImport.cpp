/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Audio/video / folder import for AudioEngine. Background-thread package writes +
// message-thread finishAsyncImport restage. Kept in its own translation unit
// so AudioEngine.cpp doesn't balloon; these are still AudioEngine member
// functions with full access to loader / streaming / peak cache state.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "../media/FFmpegProcess.h"

#include "audio/peaks/PeakCache.h"
#include "audio/streaming/WAVMetadata.h"
#include "project/Uuid.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace resostage {

namespace {
/** Identifies the history entry a folder import opens; see finishAsyncImport. */
constexpr const char* kFolderImportGestureId = "import-song-folder";

std::filesystem::path pathFromUTF8(const std::string& value) {
    return std::filesystem::path(std::u8string(value.begin(), value.end()));
}

std::string pathToUTF8(const std::filesystem::path& value) {
    const auto bytes = value.u8string();
    return std::string(bytes.begin(), bytes.end());
}

std::string lowercase(std::string value) {
    for (char& c : value)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return value;
}

bool isVideoMedia(const std::filesystem::path& path) {
    static constexpr std::array<const char*, 19> extensions = {
        ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpeg", ".mpg",
        ".mts", ".m2ts", ".ts", ".flv", ".wmv", ".3gp", ".mxf", ".ogv",
        ".vob", ".asf", ".dv"
    };
    const std::string ext = lowercase(path.extension().string());
    return std::find(extensions.begin(), extensions.end(), ext) != extensions.end();
}

std::string safeMediaName(std::string value) {
    for (char& c : value) {
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_' && c != '.')
            c = '_';
    }
    if (value.empty() || value == "." || value == "..")
        return "Media";
    return value;
}
} // namespace

using audio_engine_detail::streamingIoThreadStart;
using audio_engine_detail::streamingIoThreadStop;
using audio_engine_detail::residentIoYield;

void AudioEngine::importWAVForTrackAsync(size_t songIndex, size_t trackIndex, const std::string& filesystemPath,
                                         std::function<void(bool, std::string)> onComplete,
                                         double startSeconds) {
    auto fail = [&onComplete](std::string msg) {
        if (onComplete)
            onComplete(false, std::move(msg));
    };

    // A second request must not join the active import on the message thread
    // or clear its busy flag before its completion has reopened the project.
    if (isBusy()) {
        fail("Project operation already in progress");
        return;
    }
    if (importThread.joinable())
        importThread.join();
    if (pendingFinishImport) {
        auto fn = std::move(pendingFinishImport);
        pendingFinishImport = nullptr;
        fn();
    }
    const TrackDef* track = trackDefInSong(songIndex, trackIndex);
    if (track == nullptr || songIndex >= loader.project().songs.size()) {
        fail("Invalid song or track index");
        return;
    }
    if (!std::isfinite(startSeconds) || startSeconds < 0.0) {
        fail("Import start must be a finite nonnegative time");
        return;
    }
    if (!loader.isOpen() || loader.archivePath().empty()) {
        std::string err;
        const auto docDir = juce::File::getSpecialLocation(juce::File::userHomeDirectory).getChildFile("Documents").getChildFile("ResoSet_Projects");
        docDir.createDirectory();
        const std::string defaultPath = docDir.getChildFile("UntitledProject.rsnraset").getFullPathName().toStdString();
        if (!saveProject(defaultPath, err)) {
            fail("Failed to auto-create project archive: " + err);
            return;
        }
        track = trackDefInSong(songIndex, trackIndex);
        if (track == nullptr) {
            fail("Target track no longer exists after creating the project package");
            return;
        }
    }

    // Sanitize archive entry names and figure out the new track name --
    // cheap, message-thread-safe (no I/O) -- before touching anything slow.
    const std::filesystem::path sourcePath = pathFromUTF8(filesystemPath);
    const std::string base = sourcePath.filename().string().empty()
        ? track->id + ".wav" : pathToUTF8(sourcePath.filename());
    const bool hasOriginalVideo = isVideoMedia(sourcePath);
    const std::string mediaStem = sourcePath.stem().string().empty()
        ? std::string("Audio") : pathToUTF8(sourcePath.stem());
    // Repeated imports with identical source names need distinct package paths.
    std::string archiveTrackId = track->id;
    for (char& ch : archiveTrackId)
        if (!std::isalnum(static_cast<unsigned char>(ch)) && ch != '-' && ch != '_') ch = '_';
    const std::string regionId = generateUUIDv7();
    const std::string entry = "Audio/" + archiveTrackId + "_" + regionId + ".wav";
    const std::string videoEntry = hasOriginalVideo
        ? "Video/" + archiveTrackId + "_" + regionId + "_" + safeMediaName(base)
        : std::string{};
    std::string newTrackName = track->name;
    if (newTrackName.empty() || newTrackName == "New Track") {
        newTrackName = mediaStem;
    }

    // Conversion can fail before any asset exists. Keep the new region and
    // track name private until the package has committed, then record exactly
    // one history step from this unchanged "before" snapshot.
    const Project projectBefore = loader.project();
    Project projectSnapshot = projectBefore;
    projectSnapshot.tracks[trackIndex].name = newTrackName;
    Region importedRegion;
    importedRegion.id = regionId;
    importedRegion.trackId = track->id;
    importedRegion.source.file = entry;
    importedRegion.source.videoFile = videoEntry;
    importedRegion.startSeconds = startSeconds;
    projectSnapshot.songs[songIndex].regions.push_back(std::move(importedRegion));

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    stop();
    joinPendingPeakBuilds(); // also reads `loader`; must finish before we hand it to the import thread
    streaming.stop(); // halts the I/O thread -- loader is exclusively ours until streaming.start() below

    const std::string archivePath = loader.archivePath();
    const bool isContainer = loader.isDirectoryContainer();
    const std::string tempOut = isContainer ? archivePath : (archivePath + ".new");

    busyImporting.store(true, std::memory_order_release);
    cancelImport.store(false, std::memory_order_release);


    importThread = std::thread([this, songIndex, filesystemPath, entry, videoEntry,
                                 regionId, archivePath, tempOut, projectSnapshot, projectBefore, songToRestore,
                                 wasPlaying, startSeconds, onComplete]() mutable {
        std::string error;
        constexpr uintmax_t kMaximumSourceBytes = 20ull * 1024ull * 1024ull * 1024ull;
        std::error_code fileError;
        const uintmax_t sourceBytes = std::filesystem::file_size(pathFromUTF8(filesystemPath), fileError);
        bool readOk = !fileError && sourceBytes > 0 && sourceBytes <= kMaximumSourceBytes;
        if (!readOk) {
            error = fileError ? "Could not inspect the selected media file"
                              : "Selected media is empty or larger than the 20 GiB import limit";
        }

        const std::filesystem::path tempDirectory = std::filesystem::temp_directory_path(fileError);
        const std::filesystem::path tempWavPath = fileError
            ? std::filesystem::path{}
            : tempDirectory / ("resostage-import-" + regionId + ".wav");
        if (readOk && fileError) {
            readOk = false;
            error = "Could not locate a temporary folder for media conversion";
        }
        PeakOverview overview;
        const std::string extension = lowercase(pathToUTF8(pathFromUTF8(filesystemPath).extension()));
        const bool sourceIsWav = extension == ".wav" || extension == ".wave";

        bool prepared = false;
        std::string preparedWavPath = pathToUTF8(tempWavPath);
        if (readOk && sourceIsWav) {
            std::string peakError;
            prepared = overview.buildFromFile(filesystemPath, peakError, &cancelImport);
            if (prepared)
                preparedWavPath = filesystemPath;
            if (!prepared) {
                error = peakError;
            }
        }

        // Already-supported WAV files are copied bit-for-bit. Other media
        // formats, video containers, and WAV variants outside the engine's
        // small real-time decoder subset use the bundled FFmpeg worker to
        // prepare project-local 48 kHz stereo float PCM.
        if (readOk && !prepared) {
            std::error_code ignored;
            std::filesystem::remove(tempWavPath, ignored);
            error.clear();
            const bool transcoded = media::runFFmpeg({
                "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-threads", "2",
                "-i", filesystemPath, "-map", "0:a:0", "-vn", "-ac", "2",
                "-ar", "48000", "-c:a", "pcm_f32le", "-threads", "2", "-rf64", "auto",
                "-fs", std::to_string(kMaximumSourceBytes + 1), pathToUTF8(tempWavPath)
            }, error, &cancelImport);
            if (!transcoded) {
                prepared = false;
            } else {
                std::string peakError;
                const auto decodedBytes = std::filesystem::file_size(tempWavPath, fileError);
                prepared = !fileError && decodedBytes <= kMaximumSourceBytes;
                if (!prepared)
                    peakError = "Prepared audio exceeds the 20 GiB project-media import limit";
                else
                    prepared = overview.buildFromFile(pathToUTF8(tempWavPath), peakError, &cancelImport);
                if (!prepared)
                    error = peakError;
            }
        }
        readOk = readOk && prepared;
        if (cancelImport.load(std::memory_order_acquire)) {
            readOk = false;
            error = "Media import cancelled";
        }

        bool writeOk = false;
        if (readOk) {
            std::vector<ProjectLoader::ExtraFile> extras;
            ProjectLoader::ExtraFile extra;
            extra.archivePath = entry;
            extra.sourcePath = preparedWavPath;
            extras.push_back(std::move(extra));
            if (!videoEntry.empty()) {
                ProjectLoader::ExtraFile original;
                original.archivePath = videoEntry;
                original.sourcePath = filesystemPath;
                extras.push_back(std::move(original));
            }
            extras.push_back(PeakCache::makeCacheExtra(overview, entry));
            if (songIndex < projectSnapshot.songs.size()) {
                SongDef& s = projectSnapshot.songs[songIndex];
                auto region = std::find_if(s.regions.begin(), s.regions.end(),
                    [&regionId](const Region& candidate) { return candidate.id == regionId; });
                if (region != s.regions.end())
                    region->durationSeconds = overview.durationSeconds;
                // An authored song boundary is a guard, not a reason to
                // truncate newly imported media. Keep derived lengths derived,
                // but grow explicit lengths to include the complete source.
                if (s.endSeconds > 0.0)
                    s.endSeconds = std::max(s.endSeconds,
                        std::max(0.0, startSeconds) + overview.durationSeconds);
            }
            writeOk = loader.saveAsWithExtras(tempOut, extras, error, &projectSnapshot, &cancelImport);
            if (writeOk)
                cachePeakOverview(entry, std::move(overview));
            else {
                // These names contain this import's UUID and did not exist
                // before it. Remove any assets published before a later
                // copy failed; the old project metadata is still intact.
                for (const auto& failedExtra : extras) {
                    std::error_code ignored;
                    std::filesystem::remove(pathFromUTF8(tempOut) / failedExtra.archivePath, ignored);
                }
            }
        }

        std::error_code cleanupError;
        std::filesystem::remove(tempWavPath, cleanupError);

        auto finishFn = [this, readOk, writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, projectBefore, onComplete]() {
            finishAsyncImport(readOk && writeOk, error, tempOut, archivePath, songToRestore, wasPlaying,
                [this, projectBefore, onComplete](bool ok, std::string message) {
                    if (ok) {
                        projectHistory.beginEdit(projectBefore, "", "Import media");
                        projectHistory.commitEdit(loader.project());
                    }
                    if (onComplete)
                        onComplete(ok, std::move(message));
                });
        };

        pendingFinishImport = finishFn;

        juce::MessageManager::callAsync([this, lifetime = importCallbackLifetime]() {
            if (!lifetime->load(std::memory_order_acquire))
                return;
            if (pendingFinishImport) {
                auto fn = std::move(pendingFinishImport);
                pendingFinishImport = nullptr;
                fn();
            }
        });
    });
}

void AudioEngine::finishAsyncImport(bool writeSucceeded, std::string writeError, const std::string& tempOut,
                                    const std::string& archivePath, size_t songToRestore, bool wasPlaying,
                                    const std::function<void(bool, std::string)>& onComplete) {
    std::unique_ptr<ProjectReplacementScope> replacement;
    auto done = [&](bool ok, std::string msg) {
        // The completion callback may immediately start another project
        // operation. End this transition before it can reenter AudioEngine.
        replacement.reset();
        busyImporting.store(false, std::memory_order_release);
        if (onComplete)
            onComplete(ok, std::move(msg));
    };

    if (!writeSucceeded) {
        if (tempOut != archivePath)
            std::remove(tempOut.c_str());
        // loader/streaming were never touched by the failed background
        // write -- just restart streaming (halted before the background
        // thread started) and report the error.
        streaming.start(&loader,
                    streamingIoThreadStart,
                    streamingIoThreadStop, demoteBackgroundWorkerPriority,
                    residentIoYield);
        if (wasPlaying)
            play();
        done(false, writeError);
        return;
    }

    // Peaks for every file this import touched were already computed and
    // merged into peakOverviewSessionCache on the background thread (see
    // importWavForTrackAsync/importSongFromFolderAsync), keyed by archive
    // path -- so a stale entry from re-importing over the same filename is
    // naturally overwritten with the fresh one, and no other file's cached
    // peaks need to be thrown away just because an unrelated import happened.

    // The archive is rewritten for this same logical document. Gate the
    // callback while loader resources are replaced, but keep the project epoch
    // so unchanged processor nodes stay live after the import completes.
    replacement = std::make_unique<ProjectReplacementScope>(*this, false);

    if (tempOut != archivePath && std::rename(tempOut.c_str(), archivePath.c_str()) != 0) {
        std::string reopenError;
        (void)loader.reopenArchiveKeepProject(archivePath, reopenError);
        (void)loader.reparseProject(reopenError);
        projectLoaded = loader.isOpen();
        if (projectLoaded) {
            publishRoutingSnapshot();
            streaming.start(&loader,
                    streamingIoThreadStart,
                    streamingIoThreadStop, demoteBackgroundWorkerPriority,
                    residentIoYield);
        }
        done(false, "Failed to replace archive after import");
        return;
    }

    std::string openError;
    if (!loader.reopenArchiveKeepProject(archivePath, openError)
        || !loader.reparseProject(openError)) {
        projectLoaded = false;
        done(false, "Import written, but failed to reopen archive: " + openError);
        return;
    }
    projectLoaded = true;
    // Folder imports open this history gesture before their worker; media
    // imports record a before/after pair in their completion callback.
    (void)projectHistory.commitOpenEdit(kFolderImportGestureId, loader.project());
    currentSong = static_cast<size_t>(-1);
    trackIdByIndex.clear();
    trackScratch.clear();
    // Drop every gain/pan glide: the strip layout is about to change, so
    // gliding from the old coefficients would be an artefact, not a de-click.
    mixRenderer.resetSmoothing();
    trackMeters.clear();
    trackBandMeters.clear();
    trackPeaks.clear();
    publishRoutingSnapshot();
    ensureScratchSizes();
    streaming.start(&loader,
                    streamingIoThreadStart,
                    streamingIoThreadStop, demoteBackgroundWorkerPriority,
                    residentIoYield);

    if (songToRestore != static_cast<size_t>(-1) && songToRestore < loader.project().songs.size()) {
        std::string selectError;
        if (!selectSong(songToRestore, selectError)) {
            done(false, "Imported, but restage failed: " + selectError);
            return;
        }
        if (wasPlaying)
            play();
    }
    done(true, "");
}

bool AudioEngine::scanFolderForImport(const std::string& folderPath, std::vector<std::string>& outWavPaths,
                                      double& outDetectedBpm, std::string& error) const {
    namespace fs = std::filesystem;
    std::error_code ec;
    const fs::path dir = pathFromUTF8(folderPath);
    if (!fs::is_directory(dir, ec)) {
        error = "Not a folder: " + folderPath;
        return false;
    }

    outWavPaths.clear();
    for (const auto& entry : fs::directory_iterator(dir, ec)) {
        if (!entry.is_regular_file())
            continue;
        std::string ext = entry.path().extension().string();
        for (char& c : ext)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (ext == ".wav")
            outWavPaths.push_back(pathToUTF8(entry.path()));
    }
    if (ec) {
        error = "Failed to read folder: " + folderPath;
        return false;
    }
    if (outWavPaths.empty()) {
        error = "No .wav files found in " + folderPath;
        return false;
    }
    std::sort(outWavPaths.begin(), outWavPaths.end());

    outDetectedBpm = 0.0;
    for (const auto& wavPath : outWavPaths) {
        if (extractTempoFromWAVFile(wavPath, outDetectedBpm))
            break;
    }
    if (outDetectedBpm <= 0.0)
        parseBpmFromName(dir.filename().string(), outDetectedBpm);

    return true;
}

static std::string autoDetectStemCategory(const std::string& filename) {
    std::string upper = filename;
    for (char& c : upper) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));

    if (upper.find("CLICK") != std::string::npos || upper.find("METRO") != std::string::npos || upper.find("COUNT") != std::string::npos) return "Click";
    if (upper.find("GUIDE") != std::string::npos || upper.find("CUE") != std::string::npos || upper.find("SLATE") != std::string::npos) return "Guide";
    if (upper.find("BASS") != std::string::npos || upper.find("SUB") != std::string::npos) return "Bass";
    if (upper.find("DRUM") != std::string::npos || upper.find("DRM") != std::string::npos || upper.find("KICK") != std::string::npos || upper.find("SNARE") != std::string::npos || upper.find("BEAT") != std::string::npos || upper.find("HAT") != std::string::npos || upper.find("CYMBAL") != std::string::npos || upper.find("TOM") != std::string::npos) return "Drums";
    if (upper.find("PERC") != std::string::npos || upper.find("SHAKER") != std::string::npos || upper.find("CONGA") != std::string::npos || upper.find("TAMB") != std::string::npos || upper.find("CLAP") != std::string::npos) return "Percussion";
    if (upper.find("LOOP") != std::string::npos || upper.find("TOPS") != std::string::npos || upper.find("GROOVE") != std::string::npos) return "Loops";
    if (upper.find("BACK") != std::string::npos || upper.find("BK") != std::string::npos || upper.find("BGV") != std::string::npos || upper.find("BVOX") != std::string::npos || upper.find("BACKING") != std::string::npos || upper.find("CHOIR") != std::string::npos || upper.find("HARMONY") != std::string::npos) return "Backing Vocals";
    if (upper.find("VOX") != std::string::npos || upper.find("VOCAL") != std::string::npos || upper.find("LEAD") != std::string::npos) return "Vocals";
    if (upper.find("KEY") != std::string::npos || upper.find("PIANO") != std::string::npos || upper.find("ORGAN") != std::string::npos || upper.find("RHODES") != std::string::npos) return "Keys";
    if (upper.find("SYNTH") != std::string::npos || upper.find("PAD") != std::string::npos || upper.find("ARP") != std::string::npos) return "Synths";
    if (upper.find("GUITAR") != std::string::npos || upper.find("GTR") != std::string::npos || upper.find("ACOUSTIC") != std::string::npos || upper.find("ELECTRIC") != std::string::npos) return "Guitars";
    if (upper.find("SFX") != std::string::npos || upper.find("FX") != std::string::npos || upper.find("RISER") != std::string::npos || upper.find("SWEEP") != std::string::npos || upper.find("HIT") != std::string::npos || upper.find("DROP") != std::string::npos) return "SFX";

    std::string stem = filename;
    const auto slash = stem.find_last_of("/\\");
    if (slash != std::string::npos) stem = stem.substr(slash + 1);
    const auto dot = stem.find_last_of('.');
    if (dot != std::string::npos) stem = stem.substr(0, dot);
    return stem;
}

void AudioEngine::importSongFromFolderAsync(const std::string& folderPath, const std::string& songName, double bpm,
                                            int tsNumerator, int tsDenominator,
                                            std::function<void(bool, std::string)> onComplete) {
    auto fail = [&onComplete](std::string msg) {
        if (onComplete)
            onComplete(false, std::move(msg));
    };

    if (isBusy()) {
        fail("Project operation already in progress");
        return;
    }
    if (!projectLoaded) {
        fail("No project loaded");
        return;
    }
    if (!loader.isOpen() || loader.archivePath().empty()) {
        fail("Save the project first (Save As...) so imported audio has an archive to live in");
        return;
    }
    // Fast (header-only reads) -- fine to do synchronously before spawning
    // the background thread for the actual slow work below.
    std::vector<std::string> wavPaths;
    double scannedBpm = 0.0;
    std::string scanError;
    if (!scanFolderForImport(folderPath, wavPaths, scannedBpm, scanError)) {
        fail(scanError);
        return;
    }

    std::vector<std::string> existingIds;
    for (const auto& s : loader.project().songs)
        existingIds.push_back(s.id);
    std::string songId = "meta::song:x";
    for (int n = 1; n < 100000; ++n) {
        std::string candidate = "meta::song:" + std::to_string(n);
        if (std::find(existingIds.begin(), existingIds.end(), candidate) == existingIds.end()) {
            songId = candidate;
            break;
        }
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    stop();
    // The new song only exists once finishAsyncImport reparses the archive,
    // which happens on a later turn of the message loop -- so this entry is
    // closed by id there rather than here. Same bargain as a WAV import: the
    // audio stays in the archive, the history just records that a song was
    // brought in, and undo takes it back out.
    projectHistory.beginEdit(loader.project(), kFolderImportGestureId, "Import song folder");

    joinPendingPeakBuilds(); // also reads `loader`; must finish before we hand it to the import thread
    streaming.stop(); // halts the I/O thread -- loader is exclusively ours until streaming.start() below

    // Private snapshot the background thread builds the new song into and
    // writes from -- see importWavForTrackAsync's matching comment for why
    // the shared loader.project() must stay untouched until completion.
    Project projectSnapshot = loader.project();
    const std::string archivePath = loader.archivePath();
    // Container (directory) format must be updated in place: saveAsWithExtras
    // would otherwise write a whole second directory tree at archivePath+
    // ".new", and finishAsyncImport's std::rename() onto the already-existing,
    // non-empty archivePath directory fails with ENOTEMPTY -- unlike the
    // legacy single-file .zip format, where renaming a temp file over the
    // final path is the safe, atomic way to do it. Mirrors
    // importWavForTrackAsync's identical isContainer check.
    const bool isContainer = loader.isDirectoryContainer();

    if (importThread.joinable())
        importThread.join();
    busyImporting.store(true, std::memory_order_release);
    cancelImport.store(false, std::memory_order_release);

    importThread = std::thread([this, folderPath, songName, bpm, tsNumerator, tsDenominator, wavPaths, songId,
                                 archivePath, isContainer, projectSnapshot, songToRestore, wasPlaying,
                                 onComplete]() mutable {
        std::string error;

        SongDef song;
        song.id = songId;
        song.name = songName.empty() ? pathToUTF8(pathFromUTF8(folderPath).filename()) : songName;
        song.bpm = bpm > 0.0 ? bpm : 120.0;
        song.timeSignature.numerator = tsNumerator > 0 ? tsNumerator : 4;
        song.timeSignature.denominator = tsDenominator > 0 ? tsDenominator : 4;
        song.onEnded = SongEnd::Stop;

        std::vector<ProjectLoader::ExtraFile> extras;
        extras.reserve(wavPaths.size());
        // Decode one source at a time with bounded scratch and stream-copy
        // assets during save; a folder of long stems must not become a
        // project-sized vector of PCM file bytes in RAM.
        std::vector<ProjectLoader::ExtraFile> peakExtras;
        std::vector<std::pair<std::string, PeakOverview>> newPeakEntries;
        bool readOk = true;

        for (size_t i = 0; readOk && i < wavPaths.size(); ++i) {
            if (cancelImport.load(std::memory_order_acquire)) {
                error = "Folder import cancelled";
                readOk = false;
                break;
            }
            const std::filesystem::path srcPath = pathFromUTF8(wavPaths[i]);
            std::error_code fileError;
            const auto sourceBytes = std::filesystem::file_size(srcPath, fileError);
            constexpr uintmax_t kMaximumSourceBytes = 20ull * 1024ull * 1024ull * 1024ull;
            if (fileError || sourceBytes == 0 || sourceBytes > kMaximumSourceBytes) {
                readOk = false;
                error = "Folder stem is unreadable, empty, or larger than the 20 GiB import limit";
                break;
            }
            const std::string base = pathToUTF8(srcPath.filename());
            const std::string entry = "Audio/" + generateUUIDv7() + "_" + safeMediaName(base);

            PeakOverview overview;
            std::string peakError;
            if (!overview.buildFromFile(wavPaths[i], peakError, &cancelImport)) {
                readOk = false;
                error = "Failed to prepare folder stem: " + peakError;
                break;
            }
            const double durationSeconds = overview.durationSeconds;
            peakExtras.push_back(PeakCache::makeCacheExtra(overview, entry));
            newPeakEntries.emplace_back(entry, std::move(overview));

            ProjectLoader::ExtraFile extra;
            extra.archivePath = entry;
            extra.sourcePath = wavPaths[i];
            extras.push_back(std::move(extra));

            std::string category = autoDetectStemCategory(base);
            if (category == "Click") {
                // Project-global metronome on when a Click stem is imported.
                projectSnapshot.click.enabled = true;
                continue;
            }

            std::string trackId;
            for (const auto& t : projectSnapshot.tracks) {
                if (juce::String(t.name).equalsIgnoreCase(juce::String(category)) || t.id == category) {
                    trackId = t.id;
                    break;
                }
            }
            if (trackId.empty()) {
                TrackDef track;
                track.id = "audio::track:" + std::to_string(projectSnapshot.tracks.size() + 1);
                track.name = category;
                track.output.type = OutputType::Main;
                projectSnapshot.tracks.push_back(track);
                trackId = track.id;
            }

            Region reg;
            reg.id = generateUUIDv7();
            reg.trackId = trackId;
            reg.source.file = entry;
            reg.durationSeconds = durationSeconds;

            song.regions.push_back(std::move(reg));

        }

        bool writeOk = false;
        const std::string tempOut = isContainer ? archivePath : (archivePath + ".new");
        if (readOk) {
            projectSnapshot.songs.push_back(std::move(song));
            for (auto& pe : peakExtras)
                extras.push_back(std::move(pe));
            writeOk = loader.saveAsWithExtras(tempOut, extras, error, &projectSnapshot, &cancelImport);

            if (writeOk) {
                for (auto& [path, overview] : newPeakEntries)
                    cachePeakOverview(path, std::move(overview));
            } else {
                // This folder operation assigned fresh UUID asset paths.
                // The untouched metadata references none of these assets.
                for (const auto& failedExtra : extras) {
                    std::error_code ignored;
                    std::filesystem::remove(pathFromUTF8(tempOut) / failedExtra.archivePath, ignored);
                }
            }
        }

        auto finishFn = [this, readOk, writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete]() {
            finishAsyncImport(readOk && writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete);
        };

        pendingFinishImport = finishFn;

        juce::MessageManager::callAsync([this, lifetime = importCallbackLifetime]() {
            if (!lifetime->load(std::memory_order_acquire))
                return;
            if (pendingFinishImport) {
                auto fn = std::move(pendingFinishImport);
                pendingFinishImport = nullptr;
                fn();
            }
        });
    });
}

} // namespace resostage
