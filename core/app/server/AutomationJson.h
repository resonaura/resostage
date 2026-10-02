/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "server/BuilderJson.h"

#include <cmath>
#include <limits>

namespace resostage::builder_json {

inline constexpr size_t kMaximumAutomationEditPoints = 65'536;

/**
 * Parses one complete lane replacement off audio. Rejects the entire request
 * before mutation on bad input; sorting keeps curve attached to its endpoint.
 * Empty arrays intentionally clear an envelope without deleting its lane.
 */
inline bool parseAutomationPoints(const glz::generic& doc,
                                  std::vector<AutomationPoint>& output,
                                  std::string& error) {
    const auto* input = getArray(doc, "points");
    if (input == nullptr || input->size() > kMaximumAutomationEditPoints) {
        error = "Automation points must be an array of at most 65,536 points";
        return false;
    }
    std::vector<AutomationPoint> parsed;
    parsed.reserve(input->size());
    for (const auto& row : *input) {
        double beat = 0.0, value = 0.0, curve = 0.0;
        if (!row.is_object() || !getDouble(row, "timeBeats", beat)
            || !getDouble(row, "value", value)
            || (row.contains("curve") && !getDouble(row, "curve", curve))
            || !std::isfinite(beat) || beat < 0.0
            || !std::isfinite(value)
            || std::abs(value) > std::numeric_limits<float>::max()
            || !std::isfinite(curve) || curve < -1.0 || curve > 1.0) {
            error = "Automation points require finite nonnegative beats, values and curves in [-1, 1]";
            return false;
        }
        parsed.push_back({beat, static_cast<float>(value), static_cast<float>(curve)});
    }
    std::stable_sort(parsed.begin(), parsed.end(),
        [](const AutomationPoint& a, const AutomationPoint& b) {
            return a.timeBeats < b.timeBeats;
        });
    for (size_t i = 1; i < parsed.size(); ++i) {
        if (parsed[i].timeBeats - parsed[i - 1].timeBeats < 1.0e-6) {
            error = "Automation point positions must be distinct";
            return false;
        }
    }
    output = std::move(parsed);
    return true;
}

inline AutomationLane* findAutomationLane(SongDef& song, const std::string& id) {
    for (auto& lane : song.automationLanes)
        if (lane.id == id) return &lane;
    for (auto& region : song.midiRegions)
        for (auto& lane : region.automationLanes)
            if (lane.id == id) return &lane;
    for (auto& region : song.regions)
        for (auto& lane : region.automationLanes)
            if (lane.id == id) return &lane;
    return nullptr;
}

} // namespace resostage::builder_json
