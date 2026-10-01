/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <atomic>
#include <string>
#include <vector>

namespace resostage::media {

// Runs the app-bundled FFmpeg executable without a shell. Call only from a
// worker thread; file demuxing, codec work, and process waiting never belong
// on the audio callback or JUCE message thread.
bool runFFmpeg(const std::vector<std::string>& arguments,
               std::string& error,
               const std::atomic<bool>* cancel = nullptr);

} // namespace resostage::media
