/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "ProjectSchema.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <utility>

namespace resostage::automation_curve_cache {

enum class RestoreResult {
    NotFound,
    Incompatible,
    Restored,
};

struct StagedEntry {
    AutomationCurveCacheEntry entry;
};

inline bool sameTarget(const AutomationTarget& left,
                       const AutomationTarget& right) noexcept {
    return left.domain == right.domain
        && left.entityId == right.entityId
        && left.stripId == right.stripId
        && left.parameterId == right.parameterId
        && left.valueType == right.valueType;
}

inline size_t pointCount(const SongDef& song) noexcept {
    size_t count = 0;
    for (const auto& entry : song.automationCurveCache)
        count += entry.points.size();
    return count;
}

inline bool validForTarget(const std::vector<AutomationPoint>& points,
                           const AutomationTarget& target) noexcept {
    double previousTime = -1.0;
    for (const auto& point : points) {
        if (!std::isfinite(point.timeBeats) || point.timeBeats < 0.0
            || point.timeBeats < previousTime
            || !std::isfinite(point.value)
            || point.value < target.minValue || point.value > target.maxValue
            || !std::isfinite(point.curve)
            || point.curve < -1.0f || point.curve > 1.0f)
            return false;
        previousTime = point.timeBeats;
    }
    return true;
}

/** Validate and copy a lane curve before the caller starts project history. */
inline bool prepareStash(const AutomationLane& lane, StagedEntry& staged,
                          std::string& error) {
    if (lane.points.empty())
        return true;
    if (lane.points.size() > kMaximumAutomationCurveCachePoints
        || lane.target.entityId.empty() || lane.target.parameterId.empty()
        || !validForTarget(lane.points, lane.target)) {
        error = "Automation curve is invalid or exceeds the project cache limit";
        return false;
    }

    staged.entry.target = lane.target;
    staged.entry.scope = lane.scope;
    staged.entry.points = lane.points;
    return true;
}

/** Store a staged curve, evicting oldest entries first. Caller reserves capacity
    before beginning the project-history transaction. */
inline void applyStash(SongDef& song, AutomationCurveCacheEntry entry) {
    if (entry.points.empty())
        return;
    auto& cache = song.automationCurveCache;
    const auto existing = std::find_if(cache.begin(), cache.end(),
        [&](const AutomationCurveCacheEntry& cached) {
            return sameTarget(cached.target, entry.target)
                && cached.scope == entry.scope;
        });
    if (existing != cache.end())
        cache.erase(existing);

    while (!cache.empty()
        && (cache.size() >= kMaximumAutomationCurveCacheEntries
            || pointCount(song) + entry.points.size()
                > kMaximumAutomationCurveCachePoints))
        cache.erase(cache.begin());
    cache.push_back(std::move(entry));
}

/** Store a lane curve outside a larger history transaction. */
inline bool stash(SongDef& song, const AutomationLane& lane,
                  std::string& error) {
    StagedEntry staged;
    if (!prepareStash(lane, staged, error))
        return false;
    if (staged.entry.points.empty())
        return true;
    song.automationCurveCache.reserve(kMaximumAutomationCurveCacheEntries);
    applyStash(song, std::move(staged.entry));
    return true;
}

/** Move a matching compatible cached curve back onto a lane. */
inline RestoreResult restore(SongDef& song, AutomationLane& lane) {
    auto& cache = song.automationCurveCache;
    const auto found = std::find_if(cache.begin(), cache.end(),
        [&](const AutomationCurveCacheEntry& entry) {
            return sameTarget(entry.target, lane.target)
                && entry.scope == lane.scope;
        });
    if (found == cache.end())
        return RestoreResult::NotFound;
    if (!validForTarget(found->points, lane.target))
        return RestoreResult::Incompatible;

    lane.points = std::move(found->points);
    cache.erase(found);
    return RestoreResult::Restored;
}

} // namespace resostage::automation_curve_cache
