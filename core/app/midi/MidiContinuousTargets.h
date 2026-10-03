/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "project/ProjectSchema.h"

#include <charconv>
#include <optional>
#include <string_view>

namespace resostage::midi_control {

inline std::optional<size_t> numericIndex(std::string_view value) {
    if (value.empty())
        return std::nullopt;
    size_t index = 0;
    const auto [end, error] = std::from_chars(
        value.data(), value.data() + value.size(), index);
    if (error != std::errc{} || end != value.data() + value.size())
        return std::nullopt;
    return index;
}

// New MIDI bindings use stable entity IDs. Numeric indices remain readable so
// existing rig-wide mappings keep their historical positional behavior.
inline std::optional<size_t> trackIndexForTarget(
    const Project& project, std::string_view target) {
    if (const auto index = numericIndex(target))
        return *index < project.tracks.size() ? index : std::nullopt;
    for (size_t index = 0; index < project.tracks.size(); ++index)
        if (project.tracks[index].id == target)
            return index;
    return std::nullopt;
}

// Bus pan's runtime index reserves zero for the master; project sends begin
// at index one in AudioEngine::setBusPan().
inline std::optional<size_t> sendBusIndexForTarget(
    const Project& project, std::string_view target) {
    for (size_t index = 0; index < project.sends.size(); ++index)
        if (project.sends[index].id == target)
            return index + 1;
    return std::nullopt;
}

struct TrackSendTarget {
    std::string_view trackId;
    std::string_view busId;
};

inline std::optional<TrackSendTarget> parseTrackSendTarget(
    std::string_view target) {
    const auto separator = target.find('|');
    if (separator == std::string_view::npos || separator == 0
        || separator + 1 >= target.size()
        || target.find('|', separator + 1) != std::string_view::npos)
        return std::nullopt;
    return TrackSendTarget{target.substr(0, separator), target.substr(separator + 1)};
}

} // namespace resostage::midi_control
