/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "server/BuilderJson.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <unordered_set>

namespace resostage::builder_json {

inline constexpr size_t kMaximumAutomationEditPoints = 65'536;
enum class AutomationPointDuplicates { Reject, KeepLatest };

constexpr bool canAdmitAutomationPoint(size_t existingCount, bool replacing) noexcept {
    return replacing || existingCount < kMaximumAutomationEditPoints;
}

/** Shared scalar/collection validation, performed before narrowing to float. */
inline bool validateAutomationPoint(double beat, double value, double curve,
                                    std::string& error) {
    if (!std::isfinite(beat) || beat < 0.0 || !std::isfinite(value)
        || std::abs(value) > std::numeric_limits<float>::max()
        || !std::isfinite(curve) || curve < -1.0 || curve > 1.0) {
        error = "Automation points require finite nonnegative beats, values and curves in [-1, 1]";
        return false;
    }
    return true;
}

inline bool parseAutomationPoint(const glz::generic& row, AutomationPoint& output,
                                  std::string& error) {
    double beat = 0.0, value = 0.0, curve = 0.0;
    if (!row.is_object() || !getDouble(row, "timeBeats", beat)
        || !getDouble(row, "value", value)
        || (row.contains("curve") && !getDouble(row, "curve", curve))) {
        error = "Automation point positions, values and curves must be numbers";
        return false;
    }
    if (!validateAutomationPoint(beat, value, curve, error)) return false;
    output = {beat, static_cast<float>(value), static_cast<float>(curve)};
    return true;
}

/** Legacy lane creation may supply one initial point instead of points[].
 * Absence means an empty lane; malformed supplied fields reject the request.
 */
inline bool parseAutomationInitialPoint(const glz::generic& doc,
                                        std::vector<AutomationPoint>& output,
                                        std::string& error) {
    if (!doc.contains("initialValue")) {
        if (doc.contains("initialTimeBeats")) {
            error = "An initial automation position requires an initial value";
            return false;
        }
        output.clear();
        return true;
    }
    double beat = 0.0, value = 0.0;
    if (!getDouble(doc, "initialValue", value)
        || (doc.contains("initialTimeBeats") && !getDouble(doc, "initialTimeBeats", beat))) {
        error = "Initial automation positions and values must be numbers";
        return false;
    }
    if (!validateAutomationPoint(beat, value, 0.0, error)) return false;
    output = {{beat, static_cast<float>(value), 0.0f}};
    return true;
}

/**
 * Parses one complete lane replacement off audio. Rejects the entire request
 * before mutation on bad input; sorting keeps curve attached to its endpoint.
 * Empty arrays intentionally clear an envelope without deleting its lane.
 */
inline bool parseAutomationPoints(const glz::generic& doc,
                                  std::vector<AutomationPoint>& output,
                                  std::string& error,
                                  AutomationPointDuplicates duplicates = AutomationPointDuplicates::Reject) {
    const auto* input = getArray(doc, "points");
    if (input == nullptr || input->size() > kMaximumAutomationEditPoints) {
        error = "Automation points must be an array of at most 65,536 points";
        return false;
    }
    std::vector<AutomationPoint> parsed;
    parsed.reserve(input->size());
    for (const auto& row : *input) {
        AutomationPoint point;
        if (!parseAutomationPoint(row, point, error)) return false;
        parsed.push_back(point);
    }
    std::stable_sort(parsed.begin(), parsed.end(),
        [](const AutomationPoint& a, const AutomationPoint& b) {
            return a.timeBeats < b.timeBeats;
        });
    size_t admitted = 0;
    for (const auto& point : parsed) {
        if (admitted != 0 && point.timeBeats - parsed[admitted - 1].timeBeats < 1.0e-6) {
            if (duplicates == AutomationPointDuplicates::Reject) {
                error = "Automation point positions must be distinct";
                return false;
            }
            // Live controls can update several times before telemetry advances
            // its beat. Stable sorting keeps the newest value for that position.
            parsed[admitted - 1] = point;
        } else {
            parsed[admitted++] = point;
        }
    }
    parsed.resize(admitted);
    output = std::move(parsed);
    return true;
}

/** Parse complete automation-lane arrays embedded in region mutations.
 * This boundary is intentionally stricter than project-file migration: a
 * malformed client edit is rejected as a whole before history or mutation.
 */
inline bool parseAutomationLanes(const glz::generic& doc,
                                 std::vector<AutomationLane>& output,
                                 std::string& error) {
    error.clear();
    const auto* input = getArray(doc, "automationLanes");
    if (input == nullptr) {
        if (doc.contains("automationLanes")) {
            error = "Embedded automation lanes must be an array";
            return false;
        }
        output.clear();
        return true;
    }
    constexpr size_t kMaximumAutomationLanes = 256;
    if (input->size() > kMaximumAutomationLanes) {
        error = "Embedded automation lanes must contain at most 256 lanes";
        return false;
    }

    std::vector<AutomationLane> parsed;
    parsed.reserve(input->size());
    std::unordered_set<std::string> laneIds;
    size_t totalPoints = 0;
    for (const auto& value : *input) {
        if (!value.is_object()) {
            error = "Each embedded automation lane must be an object";
            return false;
        }

        AutomationLane lane;
        if (value.contains("id") && !getString(value, "id", lane.id)) {
            error = "Embedded automation lane IDs must be strings";
            return false;
        }
        if (lane.id.size() > 256 || (!lane.id.empty() && !laneIds.insert(lane.id).second)) {
            error = "Embedded automation lane IDs must be unique and at most 256 characters";
            return false;
        }

        std::string text;
        if (value.contains("scope")) {
            if (!getString(value, "scope", text)
                || (text != "track" && text != "region" && text != "modulation")) {
                error = "Embedded automation lane scope is invalid";
                return false;
            }
            lane.scope = automationScopeFromString(text);
        }
        if (value.contains("writeMode")) {
            if (!getString(value, "writeMode", text)
                || (text != "read" && text != "touch" && text != "latch" && text != "write")) {
                error = "Embedded automation lane write mode is invalid";
                return false;
            }
            lane.writeMode = automationWriteModeFromString(text);
        }
        if ((value.contains("enabled") && !getBool(value, "enabled", lane.enabled))
            || (value.contains("muted") && !getBool(value, "muted", lane.muted))) {
            error = "Embedded automation lane enabled/muted flags must be booleans";
            return false;
        }

        if (value.contains("target")) {
            if (!value["target"].is_object()) {
                error = "Embedded automation lane target must be an object";
                return false;
            }
            const auto& target = value["target"];
            if (target.contains("domain")) {
                if (!getString(target, "domain", text)
                    || (text != "strip" && text != "plugin" && text != "midiCC"
                        && text != "midicc" && text != "midi" && text != "lighting"
                        && text != "light")) {
                    error = "Embedded automation target domain is invalid";
                    return false;
                }
                lane.target.domain = automationDomainFromString(text);
            }
            if ((target.contains("entityId")
                 && !getString(target, "entityId", lane.target.entityId))
                || (target.contains("parameterId")
                    && !getString(target, "parameterId", lane.target.parameterId))) {
                error = "Embedded automation target identifiers must be strings";
                return false;
            }
            if (lane.target.entityId.size() > 1024 || lane.target.parameterId.size() > 1024) {
                error = "Embedded automation target identifiers exceed 1,024 characters";
                return false;
            }
            if (target.contains("valueType")) {
                if (!getString(target, "valueType", text)
                    || (text != "floatNormalized" && text != "decibels" && text != "db"
                        && text != "frequencyHz" && text != "hz" && text != "milliseconds"
                        && text != "ms" && text != "boolean" && text != "bool"
                        && text != "integer" && text != "int" && text != "colorRgb"
                        && text != "rgb")) {
                    error = "Embedded automation target value type is invalid";
                    return false;
                }
                lane.target.valueType = parameterValueTypeFromString(text);
            }

            double defaultValue = lane.target.defaultValue;
            double minValue = lane.target.minValue;
            double maxValue = lane.target.maxValue;
            if ((target.contains("defaultValue")
                 && !getDouble(target, "defaultValue", defaultValue))
                || (target.contains("minValue") && !getDouble(target, "minValue", minValue))
                || (target.contains("maxValue") && !getDouble(target, "maxValue", maxValue))) {
                error = "Embedded automation target ranges must be numeric";
                return false;
            }
            const double maxFloat = std::numeric_limits<float>::max();
            if (!std::isfinite(defaultValue) || !std::isfinite(minValue)
                || !std::isfinite(maxValue) || std::abs(defaultValue) > maxFloat
                || std::abs(minValue) > maxFloat || std::abs(maxValue) > maxFloat
                || minValue > maxValue) {
                error = "Embedded automation target ranges must be finite and ordered";
                return false;
            }
            lane.target.defaultValue = static_cast<float>(defaultValue);
            lane.target.minValue = static_cast<float>(minValue);
            lane.target.maxValue = static_cast<float>(maxValue);
        }

        if (value.contains("points")) {
            if (!parseAutomationPoints(value, lane.points, error))
                return false;
            if (lane.points.size() > kMaximumAutomationEditPoints - totalPoints) {
                error = "Embedded automation lanes may contain at most 65,536 total points";
                return false;
            }
            totalPoints += lane.points.size();
        }
        parsed.push_back(std::move(lane));
    }
    output = std::move(parsed);
    return true;
}

struct AutomationRecordGesture {
    double punchInBeats = 0.0;
    double releaseBeats = 0.0;
    float releaseValue = 0.0f;
    double returnRampBeats = 0.0;
    float underlyingValue = 0.0f;
    double rdpTolerance = 0.002;
    bool pointsCompacted = false;
    std::vector<AutomationPoint> points;
};

/** Conservatively admits the complete post-punch lane, not only this request.
 * Positions removed by the punch do not consume the new-lane point budget.
 * Duplicate-boundary coalescing may make the resulting lane slightly smaller;
 * it must never make an over-budget accepted request larger.
 */
inline bool canAdmitAutomationPunch(const std::vector<AutomationPoint>& existing,
                                   size_t incomingCount, double startBeats,
                                   double endBeats) {
    const size_t retainedCount = static_cast<size_t>(std::count_if(
        existing.begin(), existing.end(), [&](const AutomationPoint& point) {
            return point.timeBeats < startBeats - 1.0e-9
                || point.timeBeats > endBeats + 1.0e-9;
        }));
    return retainedCount <= kMaximumAutomationEditPoints
        && incomingCount <= kMaximumAutomationEditPoints - retainedCount;
}

/** Validates a complete recording pass before history or project mutation.
 * Recording permits repeated sampled positions (newest wins), unlike point
 * editor replacements. Values are clamped only after finite/float validation;
 * malformed rows and points outside the declared pass reject the whole edit.
 */
inline bool parseAutomationRecordGesture(const glz::generic& doc,
                                         const AutomationTarget& target,
                                         AutomationRecordGesture& output,
                                         std::string& error) {
    error.clear();
    AutomationRecordGesture parsed;
    double releaseValue = 0.0, underlyingValue = 0.0;
    if (!getDouble(doc, "punchInBeats", parsed.punchInBeats)
        || !getDouble(doc, "releaseBeats", parsed.releaseBeats)
        || !getDouble(doc, "releaseValue", releaseValue)
        || (doc.contains("returnRampBeats") && !getDouble(doc, "returnRampBeats", parsed.returnRampBeats))
        || (doc.contains("underlyingValue") && !getDouble(doc, "underlyingValue", underlyingValue))
        || (doc.contains("rdpTolerance") && !getDouble(doc, "rdpTolerance", parsed.rdpTolerance))
        || !std::isfinite(parsed.punchInBeats) || parsed.punchInBeats < 0.0
        || !std::isfinite(parsed.releaseBeats) || parsed.releaseBeats < parsed.punchInBeats
        || !std::isfinite(parsed.returnRampBeats) || parsed.returnRampBeats < 0.0
        || !std::isfinite(parsed.releaseBeats + parsed.returnRampBeats)
        || !std::isfinite(releaseValue) || std::abs(releaseValue) > std::numeric_limits<float>::max()
        || !std::isfinite(underlyingValue) || std::abs(underlyingValue) > std::numeric_limits<float>::max()
        || !std::isfinite(parsed.rdpTolerance) || parsed.rdpTolerance <= 0.0 || parsed.rdpTolerance > 1.0
        || !std::isfinite(target.minValue) || !std::isfinite(target.maxValue)
        || target.minValue > target.maxValue) {
        error = "Automation recording requires finite ordered pass times, target values and a positive tolerance";
        return false;
    }
    if (doc.contains("pointsCompacted")
        && !getBool(doc, "pointsCompacted", parsed.pointsCompacted)) {
        error = "Automation recording compaction marker must be a boolean";
        return false;
    }
    if (!parseAutomationPoints(doc, parsed.points, error, AutomationPointDuplicates::KeepLatest))
        return false;
    // Validate the original positions too: timestamp coalescing must not hide
    // an out-of-pass sample just beside an admitted boundary.
    for (const auto& row : *getArray(doc, "points")) {
        double beat = 0.0;
        (void)getDouble(row, "timeBeats", beat);
        if (beat < parsed.punchInBeats || beat > parsed.releaseBeats) {
            error = "Recorded automation points must stay inside the declared pass";
            return false;
        }
    }
    for (auto& point : parsed.points) {
        point.value = std::clamp(point.value, target.minValue, target.maxValue);
    }
    parsed.releaseValue = std::clamp(static_cast<float>(releaseValue), target.minValue, target.maxValue);
    parsed.underlyingValue = std::clamp(static_cast<float>(underlyingValue), target.minValue, target.maxValue);
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
