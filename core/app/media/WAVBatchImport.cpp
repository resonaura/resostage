/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "WAVBatchImport.h"

#include "audio/peaks/PeakCache.h"
#include "project/Uuid.h"

#include <algorithm>
#include <cmath>
#include <exception>
#include <filesystem>
#include <iterator>
#include <unordered_set>

namespace resostage::media {

namespace {

std::filesystem::path pathFromUTF8(const std::string& value) {
    return std::filesystem::path(std::u8string(value.begin(), value.end()));
}

// saveAsWithExtras publishes assets before metadata. All paths here belong
// exclusively to this batch, so a later failed copy/save may remove them
// without touching any pre-existing region or its content.
struct PendingBatchAssets {
    std::filesystem::path directory;
    const std::vector<ProjectLoader::ExtraFile>& extras;
    bool committed = false;

    ~PendingBatchAssets() {
        if (committed)
            return;
        for (const auto& extra : extras) {
            std::error_code ignored;
            std::filesystem::remove(directory / extra.archivePath, ignored);
        }
    }
};

bool cancelled(const std::atomic<bool>* cancel) {
    return cancel != nullptr && cancel->load(std::memory_order_acquire);
}

} // namespace

bool writeWAVStemBatch(ProjectLoader& loader, const Project& before,
                      size_t songIndex, std::span<const WAVStemImportItem> items,
                      const std::string& outputPath, const std::atomic<bool>* cancel,
                      std::vector<std::pair<std::string, PeakOverview>>& committedPeaks,
                      std::string& error) {
    committedPeaks.clear();
    error.clear();
    if (items.empty() || items.size() > kMaximumWAVBatchFiles) {
        error = "A stem batch must contain between 1 and 256 files";
        return false;
    }
    if (songIndex >= before.songs.size() || outputPath.empty()) {
        error = "Invalid stem import song or project package";
        return false;
    }
    std::unordered_set<size_t> targets;
    for (const auto& item : items) {
        if (item.trackIndex >= before.tracks.size() || !targets.insert(item.trackIndex).second) {
            error = "Stem import requires distinct valid target tracks";
            return false;
        }
    }

    std::vector<ProjectLoader::ExtraFile> extras;
    PendingBatchAssets cleanup{pathFromUTF8(outputPath), extras};
    try {
        Project snapshot = before;
        std::vector<std::pair<std::string, PeakOverview>> preparedPeaks;
        extras.reserve(items.size() * 2);
        preparedPeaks.reserve(items.size());
        SongDef& song = snapshot.songs[songIndex];

        for (const auto& item : items) {
            if (cancelled(cancel)) {
                error = "Stem import cancelled";
                return false;
            }
            std::error_code fileError;
            const auto sourcePath = pathFromUTF8(item.filesystemPath);
            const bool regularFile = std::filesystem::is_regular_file(sourcePath, fileError);
            const auto sourceBytes = regularFile && !fileError
                ? std::filesystem::file_size(sourcePath, fileError) : 0;
            if (fileError || !regularFile || sourceBytes == 0 || sourceBytes > kMaximumWAVStemBytes) {
                error = "Stem is unreadable, empty, or larger than the 20 GiB import limit";
                return false;
            }

            PeakOverview overview;
            if (!overview.buildFromFile(item.filesystemPath, error, cancel)) {
                error = "Failed to prepare stem: " + error;
                return false;
            }
            const double duration = overview.durationSeconds;
            const std::string entry = "Audio/" + generateUuidV7() + ".wav";
            ProjectLoader::ExtraFile audio;
            audio.archivePath = entry;
            audio.sourcePath = item.filesystemPath;
            extras.push_back(std::move(audio));
            extras.push_back(PeakCache::makeCacheExtra(overview, entry));
            preparedPeaks.emplace_back(entry, std::move(overview));

            const auto& trackId = snapshot.tracks[item.trackIndex].id;
            auto region = std::find_if(song.regions.begin(), song.regions.end(),
                [&trackId](const Region& candidate) { return candidate.trackId == trackId; });
            if (region == song.regions.end()) {
                Region imported;
                imported.id = generateUuidV7();
                imported.trackId = trackId;
                imported.durationSeconds = duration;
                song.regions.push_back(std::move(imported));
                region = std::prev(song.regions.end());
            }
            region->source.file = entry;
            region->source.videoFile.clear();
            // An explicit authored song end must include complete new stems;
            // derived song lengths remain derived, just as for a single import.
            const double effectiveDuration = region->durationSeconds > 0.0
                ? region->durationSeconds : std::max(0.0, duration - region->source.offsetSeconds);
            if (song.endSeconds > 0.0)
                song.endSeconds = std::max(song.endSeconds,
                    region->startSeconds + effectiveDuration);
        }

        if (cancelled(cancel)) {
            error = "Stem import cancelled";
            return false;
        }
        if (!loader.saveAsWithExtras(outputPath, extras, error, &snapshot, cancel))
            return false;
        cleanup.committed = true;
        committedPeaks = std::move(preparedPeaks);
        return true;
    } catch (const std::exception& exception) {
        error = "Stem import failed: " + std::string(exception.what());
    } catch (...) {
        error = "Stem import failed with an unexpected worker error";
    }
    return false;
}

} // namespace resostage::media
