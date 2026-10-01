/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "audio/peaks/PeakOverview.h"
#include "project/ProjectLoader.h"

#include <atomic>
#include <cstdint>
#include <span>
#include <string>
#include <utility>
#include <vector>

namespace resostage::media {

inline constexpr size_t kMaximumWAVBatchFiles = 256;
inline constexpr uintmax_t kMaximumWAVStemBytes = 20ull * 1024ull * 1024ull * 1024ull;

struct WAVStemImportItem {
    size_t trackIndex = 0;
    std::string filesystemPath;
};

// Runs only on the import worker while the caller owns the paused loader.
// Decodes one WAV/RF64 at a time, then stream-copies all source assets and
// atomically publishes metadata from a private snapshot. Existing regions
// retain their authored trims/fades/loop settings; a new region spans its
// complete stem. Each target track occurs once, and each source is <=20 GiB.
// On any failure, the live project/old metadata stay unchanged and this
// operation's UUID-named assets are removed. Only a committed batch returns
// prepared peaks for the caller to publish into its session cache.
bool writeWAVStemBatch(ProjectLoader& loader, const Project& before,
                      size_t songIndex, std::span<const WAVStemImportItem> items,
                      const std::string& outputPath, const std::atomic<bool>* cancel,
                      std::vector<std::pair<std::string, PeakOverview>>& committedPeaks,
                      std::string& error);

} // namespace resostage::media
