/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "BuilderJson.h"

#include <cstddef>
#include <string>

namespace resostage::midi_region_admission {

inline constexpr std::size_t kMaximumMidiRegionRows = 200'000;
inline constexpr std::size_t kMaximumMidiEventDataBytes = 65'536;
inline constexpr std::size_t kMaximumMidiRegionEventDataBytes = 8 * 1024 * 1024;
inline constexpr std::size_t kMaximumMidiRegionUmpWords = 800'000;

bool validateMidiRegionCollectionLimits(const glz::generic& document,
                                        std::string& error);

} // namespace resostage::midi_region_admission
