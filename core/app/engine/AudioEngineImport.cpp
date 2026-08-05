// WAV / folder import for AudioEngine. Background-thread archive writes +
// message-thread finishAsyncImport restage. Kept in its own translation unit
// so AudioEngine.cpp doesn't balloon; these are still AudioEngine member
// functions with full access to loader / streaming / peak cache state.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"

#include "audio/PeakCache.h"
#include "audio/WavMetadata.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

namespace resostage {

using audio_engine_detail::streamingIoThreadStart;
using audio_engine_detail::streamingIoThreadStop;

void AudioEngine::importWavForTrackAsync(size_t songIndex, size_t trackIndex, const std::string& filesystemPath,
                                         std::function<void(bool, std::string)> onComplete) {
    auto fail = [&onComplete](std::string msg) {
        if (onComplete)
            onComplete(false, std::move(msg));
    };

    if (importThread.joinable())
        importThread.join();
    if (pendingFinishImport) {
        auto fn = std::move(pendingFinishImport);
        pendingFinishImport = nullptr;
        fn();
    }
    busyImporting.store(false, std::memory_order_release);
    const TrackDef* track = trackDefInSong(songIndex, trackIndex);
    if (track == nullptr) {
        fail("Invalid track index");
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
    }

    // Sanitize archive entry name and figure out the new track name --
    // cheap, message-thread-safe (no I/O) -- before touching anything slow.
    std::string base = filesystemPath;
    const auto slash = base.find_last_of("/\\");
    if (slash != std::string::npos)
        base = base.substr(slash + 1);
    if (base.empty())
        base = track->id + ".wav";
    const std::string entry = "Audio/" + base;
    std::string newTrackName = track->name;
    if (newTrackName.empty() || newTrackName == "New Track") {
        const auto dot = base.find_last_of('.');
        newTrackName = (dot == std::string::npos) ? base : base.substr(0, dot);
    }

    // Update in-memory live track immediately so main thread UI/state has it
    if (TrackDef* liveTrack = trackDefAt(trackIndex)) {
        if (liveTrack->name.empty() || liveTrack->name == "New Track")
            liveTrack->name = newTrackName;
    }
    if (songIndex < loader.project().songs.size()) {
        SongDef& s = loader.project().songs[songIndex];
        const TrackDef* trk = trackDefAt(trackIndex);
        if (trk) {
            Region* regPtr = nullptr;
            for (auto& r : s.regions) {
                if (r.trackId == trk->id) { regPtr = &r; break; }
            }
            if (!regPtr) {
                Region reg;
                reg.id = "reg_" + s.id + "_" + trk->id;
                reg.trackId = trk->id;
                s.regions.push_back(reg);
                regPtr = &s.regions.back();
            }
            regPtr->file = entry;
        }
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    stop();
    joinPendingPeakBuilds(); // also reads `loader`; must finish before we hand it to the import thread
    streaming.stop(); // halts the I/O thread -- loader is exclusively ours until streaming.start() below

    // Private snapshot the background thread writes from
    Project projectSnapshot = loader.project();
    if (songIndex < projectSnapshot.songs.size()) {
        SongDef& s = projectSnapshot.songs[songIndex];
        if (trackIndex < projectSnapshot.tracks.size()) {
            const std::string& trkId = projectSnapshot.tracks[trackIndex].id;
            Region* regPtr = nullptr;
            for (auto& r : s.regions) {
                if (r.trackId == trkId) { regPtr = &r; break; }
            }
            if (!regPtr) {
                Region reg;
                reg.id = "reg_" + s.id + "_" + trkId;
                reg.trackId = trkId;
                s.regions.push_back(reg);
                regPtr = &s.regions.back();
            }
            regPtr->file = entry;
        }
    }

    const std::string archivePath = loader.archivePath();
    const bool isContainer = loader.isDirectoryContainer();
    const std::string tempOut = isContainer ? archivePath : (archivePath + ".new");

    busyImporting.store(true, std::memory_order_release);


    importThread = std::thread([this, songIndex, trackIndex, filesystemPath, entry, archivePath, tempOut, projectSnapshot, songToRestore, wasPlaying,
                                 onComplete]() mutable {
        std::string error;
        std::vector<uint8_t> data;
        bool readOk = true;

        FILE* f = std::fopen(filesystemPath.c_str(), "rb");
        if (f == nullptr) {
            error = "Failed to open file: " + filesystemPath;
            readOk = false;
        } else {
            std::fseek(f, 0, SEEK_END);
            const long sz = std::ftell(f);
            std::fseek(f, 0, SEEK_SET);
            if (sz <= 0 || sz > 512 * 1024 * 1024) {
                error = "Invalid WAV file size";
                readOk = false;
            } else {
                data.resize(static_cast<size_t>(sz));
                if (std::fread(data.data(), 1, data.size(), f) != data.size()) {
                    error = "Failed to read WAV file";
                    readOk = false;
                }
            }
            std::fclose(f);
        }

        bool writeOk = false;
        if (readOk) {
            PeakOverview overview;
            std::string peakError;
            const bool peaksOk = overview.buildFromBuffer(data.data(), data.size(), peakError);

            std::vector<ProjectLoader::ExtraFile> extras;
            ProjectLoader::ExtraFile extra;
            extra.archivePath = entry;
            extra.data = std::move(data);
            extras.push_back(std::move(extra));
            if (peaksOk) {
                extras.push_back(PeakCache::makeCacheExtra(overview, entry));
                if (songIndex < projectSnapshot.songs.size()) {
                    SongDef& s = projectSnapshot.songs[songIndex];
                    if (trackIndex < projectSnapshot.tracks.size()) {
                        const std::string& trkId = projectSnapshot.tracks[trackIndex].id;
                        for (auto& r : s.regions) {
                            if (r.trackId == trkId) {
                                r.durationSeconds = overview.durationSeconds;
                                break;
                            }
                        }
                    }
                }
            }



            writeOk = loader.saveAsWithExtras(tempOut, extras, error, &projectSnapshot);

            if (writeOk && peaksOk) {
                std::lock_guard<std::mutex> lock(peakCacheMutex);
                peakOverviewSessionCache[entry] = std::move(overview);
            }
        }

        auto finishFn = [this, readOk, writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete]() {
            finishAsyncImport(readOk && writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete);
        };

        pendingFinishImport = finishFn;

        juce::MessageManager::callAsync([this]() {
            if (pendingFinishImport) {
                auto fn = std::move(pendingFinishImport);
                pendingFinishImport = nullptr;
                fn();
            }
        });
    });
}

void AudioEngine::importSongStemsBatchAsync(size_t songIndex, const std::vector<BatchItem>& items,
                                            std::function<void(bool, std::string)> onComplete) {
    auto fail = [&onComplete](std::string msg) {
        if (onComplete)
            onComplete(false, std::move(msg));
    };

    if (items.empty()) {
        fail("No items to import");
        return;
    }

    if (importThread.joinable())
        importThread.join();
    if (pendingFinishImport) {
        auto fn = std::move(pendingFinishImport);
        pendingFinishImport = nullptr;
        fn();
    }
    busyImporting.store(false, std::memory_order_release);

    if (!loader.isOpen() || loader.archivePath().empty()) {
        newProject("New Project");
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    stop();
    joinPendingPeakBuilds();
    streaming.stop();

    Project projectSnapshot = loader.project();
    std::string archivePath = loader.archivePath();
    busyImporting.store(true, std::memory_order_release);

    importThread = std::thread([this, songIndex, items, archivePath, projectSnapshot, songToRestore, wasPlaying, onComplete]() mutable {
        namespace fs = std::filesystem;
        std::error_code ec;
        fs::path containerDir(archivePath);
        fs::create_directories(containerDir / "Audio", ec);
        fs::create_directories(containerDir / "Peaks", ec);

        std::string error;
        bool allOk = true;

        for (const auto& item : items) {
            std::string base = item.filesystemPath;
            const auto slash = base.find_last_of("/\\");
            if (slash != std::string::npos)
                base = base.substr(slash + 1);
            const std::string entry = "Audio/" + base;

            fs::path destAudio = containerDir / entry;
            fs::copy_file(item.filesystemPath, destAudio, fs::copy_options::overwrite_existing, ec);
            if (ec) {
                error = "Failed to copy audio file: " + item.filesystemPath + " (" + ec.message() + ")";
                allOk = false;
                break;
            }

            if (songIndex < projectSnapshot.songs.size() && item.trackIndex < projectSnapshot.tracks.size()) {
                SongDef& s = projectSnapshot.songs[songIndex];
                const std::string& trkId = projectSnapshot.tracks[item.trackIndex].id;
                Region* regPtr = nullptr;
                for (auto& r : s.regions) {
                    if (r.trackId == trkId) { regPtr = &r; break; }
                }
                if (!regPtr) {
                    Region reg;
                    reg.id = "reg_" + s.id + "_" + trkId;
                    reg.trackId = trkId;
                    s.regions.push_back(reg);
                    regPtr = &s.regions.back();
                }
                regPtr->file = entry;
            }

            std::vector<uint8_t> wavData;
            std::ifstream ifs(destAudio, std::ios::binary | std::ios::ate);
            if (ifs.is_open()) {
                std::streamsize sz = ifs.tellg();
                ifs.seekg(0, std::ios::beg);
                wavData.resize(static_cast<size_t>(sz));
                ifs.read(reinterpret_cast<char*>(wavData.data()), sz);
                ifs.close();
            }

            if (!wavData.empty()) {
                PeakOverview overview;
                std::string peakErr;
                if (overview.buildFromBuffer(wavData.data(), wavData.size(), peakErr)) {
                    ProjectLoader::ExtraFile cacheExtra = PeakCache::makeCacheExtra(overview, entry);
                    fs::path peakDest = containerDir / cacheExtra.archivePath;
                    fs::create_directories(peakDest.parent_path(), ec);
                    std::ofstream ofs(peakDest, std::ios::binary);
                    if (ofs.is_open()) {
                        ofs.write(reinterpret_cast<const char*>(cacheExtra.data.data()),
                                  static_cast<std::streamsize>(cacheExtra.data.size()));
                    }
                    std::lock_guard<std::mutex> lock(peakCacheMutex);
                    peakOverviewSessionCache[entry] = std::move(overview);
                }
            }
        }

        if (allOk) {
            std::string saveErr;
            loader.saveAsWithExtras(archivePath, {}, saveErr, &projectSnapshot);
        }

        auto finishFn = [this, allOk, error, archivePath, songToRestore, wasPlaying, onComplete]() {
            finishAsyncImport(allOk, error, archivePath, archivePath, songToRestore, wasPlaying, onComplete);
        };
        pendingFinishImport = finishFn;

        juce::MessageManager::callAsync([this]() {
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
    auto done = [&](bool ok, std::string msg) {
        busyImporting.store(false, std::memory_order_release);
        if (onComplete)
            onComplete(ok, std::move(msg));
    };

    if (!writeSucceeded) {
        std::remove(tempOut.c_str());
        // loader/streaming were never touched by the failed background
        // write -- just restart streaming (halted before the background
        // thread started) and report the error.
        streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
        done(false, writeError);
        return;
    }

    // Peaks for every file this import touched were already computed and
    // merged into peakOverviewSessionCache on the background thread (see
    // importWavForTrackAsync/importSongFromFolderAsync), keyed by archive
    // path -- so a stale entry from re-importing over the same filename is
    // naturally overwritten with the fresh one, and no other file's cached
    // peaks need to be thrown away just because an unrelated import happened.

    if (std::rename(tempOut.c_str(), archivePath.c_str()) != 0) {
        std::string reopenError;
        (void)loader.reopenArchiveKeepProject(archivePath, reopenError);
        (void)loader.reparseProject(reopenError);
        projectLoaded = loader.isOpen();
        if (projectLoaded)
            streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
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
    buildBusListFromProject();
    streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);

    currentSong = static_cast<size_t>(-1);
    trackIdByIndex.clear();
    trackScratch.clear();
    trackGainSmooth.clear();
    clickSendSmooth.clear();
    trackMeters.clear();
    trackBandMeters.clear();
    trackPeaks.clear();

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
    const fs::path dir(folderPath);
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
            outWavPaths.push_back(entry.path().string());
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
        if (extractTempoFromWavFile(wavPath, outDetectedBpm))
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

    if (busyImporting.load(std::memory_order_acquire)) {
        fail("Another import is already in progress");
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
    if (loader.project().busses.empty()) {
        fail("Project has no busses to route imported tracks to");
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
    std::string songId = "song_x";
    for (int n = 1; n < 100000; ++n) {
        std::string candidate = "song_" + std::to_string(n);
        if (std::find(existingIds.begin(), existingIds.end(), candidate) == existingIds.end()) {
            songId = candidate;
            break;
        }
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    stop();
    joinPendingPeakBuilds(); // also reads `loader`; must finish before we hand it to the import thread
    streaming.stop(); // halts the I/O thread -- loader is exclusively ours until streaming.start() below

    // Private snapshot the background thread builds the new song into and
    // writes from -- see importWavForTrackAsync's matching comment for why
    // the shared loader.project() must stay untouched until completion.
    Project projectSnapshot = loader.project();
    const std::string defaultBusId = projectSnapshot.busses.front().id;
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

    importThread = std::thread([this, folderPath, songName, bpm, tsNumerator, tsDenominator, wavPaths, songId,
                                 defaultBusId, archivePath, isContainer, projectSnapshot, songToRestore, wasPlaying,
                                 onComplete]() mutable {
        std::string error;

        SongDef song;
        song.id = songId;
        song.name = songName.empty() ? std::filesystem::path(folderPath).filename().string() : songName;
        song.bpm = bpm > 0.0 ? bpm : 120.0;
        song.timeSignature.numerator = tsNumerator > 0 ? tsNumerator : 4;
        song.timeSignature.denominator = tsDenominator > 0 ? tsDenominator : 4;
        song.playbackMode = PlaybackMode::WaitForTrigger;

        std::vector<ProjectLoader::ExtraFile> extras;
        extras.reserve(wavPaths.size());
        // Peaks built inline per file below, from bytes already in RAM, and
        // persisted alongside the audio in the same save -- see the matching
        // comment in importWavForTrackAsync for why this (not a post-import
        // sweep) is what keeps a folder import from freezing the app.
        std::vector<ProjectLoader::ExtraFile> peakExtras;
        std::vector<std::pair<std::string, PeakOverview>> newPeakEntries;
        bool readOk = true;

        for (size_t i = 0; readOk && i < wavPaths.size(); ++i) {
            const std::filesystem::path srcPath(wavPaths[i]);
            FILE* f = std::fopen(srcPath.string().c_str(), "rb");
            if (f == nullptr) {
                error = "Failed to open file: " + srcPath.string();
                readOk = false;
                break;
            }
            std::fseek(f, 0, SEEK_END);
            const long sz = std::ftell(f);
            std::fseek(f, 0, SEEK_SET);
            if (sz <= 0 || sz > 512 * 1024 * 1024) {
                std::fclose(f);
                error = "Invalid or oversized WAV file: " + srcPath.string();
                readOk = false;
                break;
            }
            std::vector<uint8_t> data(static_cast<size_t>(sz));
            const bool got = std::fread(data.data(), 1, data.size(), f) == data.size();
            std::fclose(f);
            if (!got) {
                error = "Failed to read WAV file: " + srcPath.string();
                readOk = false;
                break;
            }

            const std::string base = srcPath.filename().string();
            const std::string entry = "Audio/" + base;

            PeakOverview overview;
            std::string peakError;
            if (overview.buildFromBuffer(data.data(), data.size(), peakError)) {
                peakExtras.push_back(PeakCache::makeCacheExtra(overview, entry));
                newPeakEntries.emplace_back(entry, std::move(overview));
            }

            ProjectLoader::ExtraFile extra;
            extra.archivePath = entry;
            extra.data = std::move(data);
            extras.push_back(std::move(extra));

            std::string category = autoDetectStemCategory(srcPath.filename().string());
            if (category == "Click") {
                // Project-global metronome on when a Click stem is imported.
                projectSnapshot.builtInClickEnabled = true;
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
                track.id = "trk_" + std::to_string(projectSnapshot.tracks.size() + 1);
                track.name = category;
                track.busId = defaultBusId;
                projectSnapshot.tracks.push_back(track);
                trackId = track.id;
            }

            Region reg;
            reg.id = "reg_" + song.id + "_" + std::to_string(i + 1);
            reg.trackId = trackId;
            reg.file = entry;
            reg.durationSeconds = overview.durationSeconds;

            song.regions.push_back(std::move(reg));

        }

        bool writeOk = false;
        const std::string tempOut = isContainer ? archivePath : (archivePath + ".new");
        if (readOk) {
            projectSnapshot.songs.push_back(std::move(song));
            for (auto& pe : peakExtras)
                extras.push_back(std::move(pe));
            writeOk = loader.saveAsWithExtras(tempOut, extras, error, &projectSnapshot);

            if (writeOk) {
                std::lock_guard<std::mutex> lock(peakCacheMutex);
                for (auto& [path, overview] : newPeakEntries)
                    peakOverviewSessionCache[path] = std::move(overview);
            }
        }

        auto finishFn = [this, readOk, writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete]() {
            finishAsyncImport(readOk && writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete);
        };

        pendingFinishImport = finishFn;

        juce::MessageManager::callAsync([this]() {
            if (pendingFinishImport) {
                auto fn = std::move(pendingFinishImport);
                pendingFinishImport = nullptr;
                fn();
            }
        });
    });
}

} // namespace resostage
