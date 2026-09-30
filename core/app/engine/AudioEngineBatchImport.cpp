// Batch WAV-stem import for AudioEngine. The background worker copies audio
// and prepares peaks; the shared finishAsyncImport path reopens and restages
// the archive on the message thread.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"

#include "audio/peaks/PeakCache.h"
#include "project/Uuid.h"

#include <filesystem>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

namespace resostage {

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
                    reg.id = generateUuidV7();
                    reg.trackId = trkId;
                    s.regions.push_back(reg);
                    regPtr = &s.regions.back();
                }
                regPtr->source.file = entry;
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
                    cachePeakOverview(entry, std::move(overview));
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

} // namespace resostage
