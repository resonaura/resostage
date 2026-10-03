/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Web Builder automation mutations, owned by the JUCE message thread.
// These handlers mutate project/history state; keep them off the WebServer and
// audio-callback threads. The file split is organizational and preserves the
// existing command semantics.

#include "MainComponent.h"
#include "automation/AutomationRecorder.h"
#include "automation/RamerDouglasPeucker.h"
#include "engine/AudioEngineInternal.h"
#include "project/AutomationCurveCache.h"
#include "project/ProjectJson.h"
#include "server/BuilderJson.h"
#include "server/AutomationJson.h"
#include "timing/TempoMap.h"
#include "plugins/PluginProcessorBank.h"

#include <algorithm>
#include <bit>
#include <charconv>
#include <cmath>
#include <limits>

namespace resostage {

using namespace builder_json;

namespace {

bool resolvePluginAutomationStrip(const Project& project, AutomationTarget& target,
                                  std::string& error) {
    std::string resolvedStripId;
    for (const auto& track : project.tracks) {
        if (!target.stripId.empty() && track.effectiveStripId() != target.stripId)
            continue;
        const bool hasSlot = std::any_of(track.plugins.begin(), track.plugins.end(),
            [&](const PluginSlot& slot) { return slot.id == target.entityId; });
        if (!hasSlot)
            continue;
        const auto& candidateStripId = track.effectiveStripId();
        if (!resolvedStripId.empty() && resolvedStripId != candidateStripId) {
            error = "Plug-in slot identity is ambiguous; choose an exact strip and slot";
            return false;
        }
        resolvedStripId = candidateStripId;
    }
    if (resolvedStripId.empty()) {
        error = "Plug-in slot does not exist on the requested strip";
        return false;
    }
    if (target.stripId.empty())
        target.stripId = resolvedStripId;
    return true;
}

bool isAutomatablePluginTarget(const PluginProcessorBank* bank,
                               const AutomationTarget& target) {
    if (bank == nullptr || target.domain != AutomationDomain::Plugin
        || target.valueType != ParameterValueType::FloatNormalized
        || std::abs(target.minValue) > 1.0e-4f
        || std::abs(target.maxValue - 1.0f) > 1.0e-4f)
        return false;
    const int index = bank->resolvePluginParameterIndex(
        target.stripId, target.entityId, target.parameterId);
    if (index < 0)
        return false;
    const auto parameters = bank->parametersForSlot(target.stripId, target.entityId);
    return std::any_of(parameters.begin(), parameters.end(), [&](const auto& parameter) {
        return parameter.index == static_cast<uint32_t>(index) && parameter.automatable;
    });
}

} // namespace

void MainComponent::builderAutomationLaneAdd(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    AutomationLane lane;
    std::string usedPrefix = "auto_lane";
    std::vector<std::string> used;
    for (const auto& l : s.automationLanes) used.push_back(l.id);
    lane.id = makeUniqueId(usedPrefix, used);

    std::string domainStr, valueTypeStr, scopeStr, writeModeStr;
    if (getString(doc, "domain", domainStr)) lane.target.domain = automationDomainFromString(domainStr);
    getString(doc, "entityId", lane.target.entityId);
    getString(doc, "stripId", lane.target.stripId);
    getString(doc, "parameterId", lane.target.parameterId);
    if (getString(doc, "valueType", valueTypeStr)) lane.target.valueType = parameterValueTypeFromString(valueTypeStr);
    double defVal = 0.0, minVal = 0.0, maxVal = 1.0;
    if (getDouble(doc, "defaultValue", defVal)) lane.target.defaultValue = static_cast<float>(defVal);
    if (getDouble(doc, "minValue", minVal)) lane.target.minValue = static_cast<float>(minVal);
    if (getDouble(doc, "maxValue", maxVal)) lane.target.maxValue = static_cast<float>(maxVal);
    if (!std::isfinite(lane.target.defaultValue) || !std::isfinite(lane.target.minValue)
        || !std::isfinite(lane.target.maxValue) || lane.target.minValue > lane.target.maxValue) {
        setStatus("Could not add automation lane: invalid target range");
        return;
    }
    if (lane.target.domain == AutomationDomain::Plugin) {
        if (lane.target.entityId.empty() || lane.target.entityId.size() > 128
            || lane.target.stripId.size() > 128 || lane.target.parameterId.empty()
            || lane.target.parameterId.size() > 1024) {
            setStatus("Could not add automation lane: plug-in target identity is malformed");
            return;
        }
        std::string identityError;
        if (!resolvePluginAutomationStrip(proj, lane.target, identityError)
            || !isAutomatablePluginTarget(engine.activePluginProcessorBank().get(), lane.target)) {
            setStatus("Could not add automation lane: " + juce::String(
                identityError.empty()
                    ? "plug-in parameter is not loaded or automatable"
                    : identityError));
            return;
        }
    }
    if (doc.contains("points")) {
        std::string error;
        if (!parseAutomationPoints(doc, lane.points, error)) {
            setStatus("Could not add automation lane: " + juce::String(error));
            return;
        }
    } else {
        std::string error;
        if (!parseAutomationInitialPoint(doc, lane.points, error)) {
            setStatus("Could not add automation lane: " + juce::String(error));
            return;
        }
    }

    if (getString(doc, "scope", scopeStr)) lane.scope = automationScopeFromString(scopeStr);
    if (getString(doc, "writeMode", writeModeStr)) lane.writeMode = automationWriteModeFromString(writeModeStr);
    bool enabled = true, muted = false;
    if (getBool(doc, "enabled", enabled)) lane.enabled = enabled;
    if (getBool(doc, "muted", muted)) lane.muted = muted;

    std::string regionId;
    getString(doc, "regionId", regionId);

    // Resolve the destination before opening history: a removed region must
    // not create a dirty no-op or report that a lane was added successfully.
    std::vector<AutomationLane>* destination = &s.automationLanes;
    if (!regionId.empty()) {
        destination = nullptr;
        for (auto& region : s.midiRegions)
            if (region.id == regionId) { destination = &region.automationLanes; break; }
        if (destination == nullptr)
            for (auto& region : s.regions)
                if (region.id == regionId) { destination = &region.automationLanes; break; }
        if (destination == nullptr) {
            setStatus("Could not add automation lane: region no longer exists");
            return;
        }
    }

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Add automation lane");

    if (regionId.empty() && lane.scope == AutomationScope::Track)
        (void)automation_curve_cache::restore(s, lane);
    destination->push_back(std::move(lane));

    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("Automation lane added");
}

void MainComponent::builderAutomationLaneRemove(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string laneId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "laneId", laneId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Remove automation lane");

    auto it = std::remove_if(s.automationLanes.begin(), s.automationLanes.end(),
                             [&](const AutomationLane& l) { return l.id == laneId; });
    bool removed = (it != s.automationLanes.end());
    if (removed) s.automationLanes.erase(it, s.automationLanes.end());

    for (auto& mr : s.midiRegions) {
        auto rit = std::remove_if(mr.automationLanes.begin(), mr.automationLanes.end(),
                                  [&](const AutomationLane& l) { return l.id == laneId; });
        if (rit != mr.automationLanes.end()) {
            mr.automationLanes.erase(rit, mr.automationLanes.end());
            removed = true;
        }
    }
    for (auto& r : s.regions) {
        auto rit = std::remove_if(r.automationLanes.begin(), r.automationLanes.end(),
                                  [&](const AutomationLane& l) { return l.id == laneId; });
        if (rit != r.automationLanes.end()) {
            r.automationLanes.erase(rit, r.automationLanes.end());
            removed = true;
        }
    }

    if (removed) {
        engine.projectHistoryCommitEdit();
        engine.markDirty();
        notifyProjectStructureChanged();
        setStatus("Automation lane removed");
    } else {
        engine.projectHistoryCommitEdit();
    }
}

void MainComponent::builderAutomationLaneUpdate(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string laneId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "laneId", laneId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    AutomationLane* lanePtr = nullptr;
    bool isSongTrackLane = false;
    for (auto& l : s.automationLanes) {
        if (l.id == laneId) { lanePtr = &l; isSongTrackLane = true; break; }
    }
    if (!lanePtr) {
        for (auto& mr : s.midiRegions) {
            for (auto& l : mr.automationLanes) {
                if (l.id == laneId) { lanePtr = &l; break; }
            }
            if (lanePtr) break;
        }
    }
    if (!lanePtr) {
        for (auto& r : s.regions) {
            for (auto& l : r.automationLanes) {
                if (l.id == laneId) { lanePtr = &l; break; }
            }
            if (lanePtr) break;
        }
    }
    if (!lanePtr) return;

    std::optional<AutomationTarget> replacementTarget;
    if (doc.contains("target")) {
        const auto& targetDoc = doc["target"];
        std::string domain, valueType;
        AutomationTarget target;
        double defaultValue = 0.0;
        double minValue = 0.0;
        double maxValue = 1.0;
        std::string error;
        if (!targetDoc.is_object()
            || !getString(targetDoc, "domain", domain)
            || !getString(targetDoc, "entityId", target.entityId)
            || (targetDoc.contains("stripId")
                && !getString(targetDoc, "stripId", target.stripId))
            || !getString(targetDoc, "parameterId", target.parameterId)
            || !getString(targetDoc, "valueType", valueType)
            || !getDouble(targetDoc, "defaultValue", defaultValue)
            || !getDouble(targetDoc, "minValue", minValue)
            || !getDouble(targetDoc, "maxValue", maxValue)) {
            setStatus("Could not rebind automation lane: target fields are incomplete");
            return;
        }
        const auto parsedType = parameterValueTypeFromString(valueType);
        const bool knownType = valueType == parameterValueTypeToString(parsedType);
        if (!isSongTrackLane || lanePtr->scope != AutomationScope::Track
            || (domain != "plugin" && domain != "strip" && domain != "midiCC")
            || !knownType
            || target.entityId.empty() || target.entityId.size() > 128
            || target.stripId.size() > 128
            || target.parameterId.empty() || target.parameterId.size() > 1024
            || !std::isfinite(defaultValue) || !std::isfinite(minValue)
            || !std::isfinite(maxValue) || minValue < -1.0e9 || maxValue > 1.0e9
            || minValue >= maxValue || defaultValue < minValue || defaultValue > maxValue
            || std::abs(defaultValue) > std::numeric_limits<float>::max()
            || std::abs(minValue) > std::numeric_limits<float>::max()
            || std::abs(maxValue) > std::numeric_limits<float>::max()) {
            setStatus("Could not rebind automation lane: target is malformed, unsupported, or not a song track lane");
            return;
        }

        target.domain = automationDomainFromString(domain);
        target.valueType = parsedType;
        target.defaultValue = static_cast<float>(defaultValue);
        target.minValue = static_cast<float>(minValue);
        target.maxValue = static_cast<float>(maxValue);

        std::string identityError;
        if (target.domain == AutomationDomain::Plugin
            && !resolvePluginAutomationStrip(proj, target, identityError)) {
            setStatus("Could not rebind automation lane: " + juce::String(identityError));
            return;
        }

        const auto targetTrack = std::find_if(proj.tracks.begin(), proj.tracks.end(),
            [&](const TrackDef& track) { return track.id == target.entityId; });
        const auto hasRange = [&](float min, float max) {
            constexpr float tolerance = 1.0e-4f;
            return std::abs(target.minValue - min) <= tolerance
                && std::abs(target.maxValue - max) <= tolerance;
        };
        bool supported = false;
        if (domain == "plugin") {
            const auto bank = engine.activePluginProcessorBank();
            supported = hasRange(0.0f, 1.0f)
                && isAutomatablePluginTarget(bank.get(), target);
        } else if (domain == "strip" && targetTrack != proj.tracks.end()) {
            if (target.parameterId == "faderGainDb") {
                supported = target.valueType == ParameterValueType::Decibels
                    && hasRange(-60.0f, 12.0f);
            } else if (target.parameterId == "pan") {
                supported = target.valueType == ParameterValueType::FloatNormalized
                    && hasRange(-1.0f, 1.0f);
            } else if (target.parameterId == "mute") {
                supported = target.valueType == ParameterValueType::Boolean
                    && hasRange(0.0f, 1.0f);
            } else if (target.parameterId.rfind("send:", 0) == 0
                       && target.valueType == ParameterValueType::FloatNormalized
                       && hasRange(0.0f, 1.0f)) {
                const auto route = target.parameterId.substr(5);
                const auto matches = std::count_if(
                    targetTrack->output.sends.begin(), targetTrack->output.sends.end(),
                    [&](const SendConfig& send) {
                        if (!send.enabled) return false;
                        if (route == send.bus) return true;
                        if (route.rfind("audio::send:", 0) == 0) return false;
                        size_t sendIndex = 0;
                        const auto parsed = std::from_chars(route.data(),
                            route.data() + route.size(), sendIndex);
                        return parsed.ec == std::errc{}
                            && parsed.ptr == route.data() + route.size()
                            && sendIndex < targetTrack->output.sends.size()
                            && &send == &targetTrack->output.sends[sendIndex];
                    });
                supported = matches == 1;
            }
        } else if (domain == "midiCC" && targetTrack != proj.tracks.end()
                   && isMidiInputTrack(targetTrack->kind)
                   && target.valueType == ParameterValueType::Integer) {
            if (target.parameterId == "pitchBend") {
                supported = hasRange(-8192.0f, 8191.0f);
            } else if (target.parameterId.rfind("cc:", 0) == 0
                       && hasRange(0.0f, 127.0f)) {
                int controller = -1;
                const auto text = target.parameterId.substr(3);
                const auto parsed = std::from_chars(text.data(),
                    text.data() + text.size(), controller);
                supported = parsed.ec == std::errc{}
                    && parsed.ptr == text.data() + text.size()
                    && controller >= 0 && controller <= 127;
            }
        }

        const bool duplicateTarget = std::any_of(s.automationLanes.begin(),
            s.automationLanes.end(), [&](const AutomationLane& candidate) {
                return candidate.id != laneId
                    && candidate.scope == lanePtr->scope
                    && automation_curve_cache::sameTarget(candidate.target, target);
            });
        if (!supported || duplicateTarget) {
            setStatus(!supported
                ? "Could not rebind automation lane: destination parameter is not loaded or supported"
                : "Could not rebind automation lane: another lane already controls this parameter");
            return;
        }
        replacementTarget = std::move(target);
    }

    std::optional<automation_curve_cache::StagedEntry> stagedCurve;
    if (replacementTarget) {
        const bool targetIdentityChanges = !automation_curve_cache::sameTarget(
            lanePtr->target, *replacementTarget);
        if (!automation_curve_cache::validForTarget(lanePtr->points,
                                                    targetIdentityChanges
                                                        ? lanePtr->target
                                                        : *replacementTarget)
            || (targetIdentityChanges
                && lanePtr->points.size() > kMaximumAutomationCurveCachePoints)) {
            setStatus("Could not rebind automation lane: existing curve is invalid or exceeds the project cache limit");
            return;
        }
        if (targetIdentityChanges && !lanePtr->points.empty()) {
            automation_curve_cache::StagedEntry staged;
            std::string cacheError;
            if (!automation_curve_cache::prepareStash(*lanePtr, staged,
                                                       cacheError)) {
                setStatus("Could not rebind automation lane: "
                          + juce::String(cacheError));
                return;
            }
            stagedCurve = std::move(staged);
            s.automationCurveCache.reserve(kMaximumAutomationCurveCacheEntries);
        }
    }

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Update automation lane");

    if (replacementTarget) {
        if (!automation_curve_cache::sameTarget(lanePtr->target,
                                                 *replacementTarget)) {
            if (stagedCurve)
                automation_curve_cache::applyStash(
                    s, std::move(stagedCurve->entry));
            lanePtr->target = std::move(*replacementTarget);
            lanePtr->points.clear();
            (void)automation_curve_cache::restore(s, *lanePtr);
        } else {
            lanePtr->target = std::move(*replacementTarget);
        }
    }
    bool bVal;
    std::string strVal;
    if (getBool(doc, "enabled", bVal)) lanePtr->enabled = bVal;
    if (getBool(doc, "muted", bVal)) lanePtr->muted = bVal;
    if (getString(doc, "writeMode", strVal)) lanePtr->writeMode = automationWriteModeFromString(strVal);

    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("Automation lane updated");
}

void MainComponent::builderAutomationPointAdd(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string laneId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "laneId", laneId)
        || !engine.isProjectLoaded())
        return;
    AutomationPoint pt;
    std::string error;
    if (!parseAutomationPoint(doc, pt, error)) {
        setStatus("Could not add automation point: " + juce::String(error));
        return;
    }

    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    AutomationLane* lanePtr = nullptr;
    for (auto& l : s.automationLanes) {
        if (l.id == laneId) { lanePtr = &l; break; }
    }
    if (!lanePtr) {
        for (auto& mr : s.midiRegions) {
            for (auto& l : mr.automationLanes) {
                if (l.id == laneId) { lanePtr = &l; break; }
            }
            if (lanePtr) break;
        }
    }
    if (!lanePtr) {
        for (auto& r : s.regions) {
            for (auto& l : r.automationLanes) {
                if (l.id == laneId) { lanePtr = &l; break; }
            }
            if (lanePtr) break;
        }
    }
    if (!lanePtr) return;

    const auto existing = std::find_if(lanePtr->points.begin(), lanePtr->points.end(),
        [&](const AutomationPoint& point) { return std::abs(point.timeBeats - pt.timeBeats) < 1.0e-6; });
    if (!canAdmitAutomationPoint(lanePtr->points.size(), existing != lanePtr->points.end())) {
        setStatus("Could not add automation point: the lane already contains 65,536 points");
        return;
    }

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Add automation point");

    if (existing != lanePtr->points.end()) {
        // Sub-microbeat differences identify the same point throughout the
        // command boundary. Keep its position so a value update cannot shrink
        // the next gap below the complete-editor distinct-position threshold.
        pt.timeBeats = existing->timeBeats;
        *existing = pt;
    } else {
        lanePtr->points.push_back(pt);
        std::sort(lanePtr->points.begin(), lanePtr->points.end(),
                  [](const AutomationPoint& a, const AutomationPoint& b) {
                      return a.timeBeats < b.timeBeats;
                  });
    }

    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("Automation point added");
}

void MainComponent::builderAutomationPointRemove(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string laneId;
    double timeBeats = 0.0;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "laneId", laneId)
        || !getDouble(doc, "timeBeats", timeBeats) || !engine.isProjectLoaded())
        return;

    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    AutomationLane* lanePtr = nullptr;
    for (auto& l : s.automationLanes) {
        if (l.id == laneId) { lanePtr = &l; break; }
    }
    if (!lanePtr) {
        for (auto& mr : s.midiRegions) {
            for (auto& l : mr.automationLanes) {
                if (l.id == laneId) { lanePtr = &l; break; }
            }
            if (lanePtr) break;
        }
    }
    if (!lanePtr) {
        for (auto& r : s.regions) {
            for (auto& l : r.automationLanes) {
                if (l.id == laneId) { lanePtr = &l; break; }
            }
            if (lanePtr) break;
        }
    }
    if (!lanePtr) return;

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Remove automation point");

    auto it = std::remove_if(lanePtr->points.begin(), lanePtr->points.end(),
                             [&](const AutomationPoint& p) {
                                 return std::abs(p.timeBeats - timeBeats) < 1.0e-5;
                             });
    if (it != lanePtr->points.end()) {
        lanePtr->points.erase(it, lanePtr->points.end());
        engine.projectHistoryCommitEdit();
        engine.markDirty();
        notifyProjectStructureChanged();
        setStatus("Automation point removed");
    } else {
        engine.projectHistoryCommitEdit();
    }
}

void MainComponent::builderAutomationPointsReplace(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string laneId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex)
        || !getString(doc, "laneId", laneId) || !engine.isProjectLoaded()) return;
    auto& project = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(project.songs.size())) return;
    auto* lane = findAutomationLane(project.songs[static_cast<size_t>(songIndex)], laneId);
    if (lane == nullptr) {
        setStatus("Could not edit automation: lane no longer exists");
        return;
    }
    std::vector<AutomationPoint> points;
    std::string error;
    if (!parseAutomationPoints(doc, points, error)) {
        setStatus("Could not edit automation: " + juce::String(error));
        return;
    }
    if (points.size() == lane->points.size()
        && std::equal(points.begin(), points.end(), lane->points.begin(),
            [](const AutomationPoint& a, const AutomationPoint& b) {
                return std::bit_cast<uint64_t>(a.timeBeats) == std::bit_cast<uint64_t>(b.timeBeats)
                    && std::bit_cast<uint32_t>(a.value) == std::bit_cast<uint32_t>(b.value)
                    && std::bit_cast<uint32_t>(a.curve) == std::bit_cast<uint32_t>(b.curve);
            })) return;
    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    // One snapshot/commit preserves scope, mode, target and curves together;
    // selection drags cannot leave half-applied remove/add commands behind.
    engine.projectHistoryBeginEdit(gestureId, "Edit automation points");
    lane->points = std::move(points);
    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("Automation points updated");
}

void MainComponent::builderAutomationRecordGesture(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string laneId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "laneId", laneId) || !engine.isProjectLoaded())
        return;

    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    AutomationLane* lanePtr = nullptr;
    for (auto& l : s.automationLanes) {
        if (l.id == laneId) { lanePtr = &l; break; }
    }
    if (!lanePtr) {
        for (auto& mr : s.midiRegions) {
            for (auto& l : mr.automationLanes) {
                if (l.id == laneId) { lanePtr = &l; break; }
            }
            if (lanePtr) break;
        }
    }
    if (!lanePtr) {
        for (auto& r : s.regions) {
            for (auto& l : r.automationLanes) {
                if (l.id == laneId) { lanePtr = &l; break; }
            }
            if (lanePtr) break;
        }
    }
    if (!lanePtr) {
        setStatus("Could not record automation: lane no longer exists");
        return;
    }

    AutomationRecordGesture gesture;
    std::string error;
    if (!parseAutomationRecordGesture(doc, lanePtr->target, gesture, error)) {
        setStatus("Could not record automation: " + juce::String(error));
        return;
    }
    auto rawPoints = std::move(gesture.points);

    if (rawPoints.empty()) {
        rawPoints.push_back({gesture.punchInBeats, gesture.releaseValue, 0.0f});
    }

    rawPoints.push_back({gesture.releaseBeats, gesture.releaseValue, 0.0f});
    const double rampEndBeats = gesture.releaseBeats + gesture.returnRampBeats;
    if (gesture.returnRampBeats > 0.0) {
        rawPoints.push_back({rampEndBeats, gesture.underlyingValue, 0.0f});
    }

    std::stable_sort(rawPoints.begin(), rawPoints.end(),
              [](const AutomationPoint& a, const AutomationPoint& b) {
                  return a.timeBeats < b.timeBeats;
              });

    const auto thinned = RamerDouglasPeucker::thin(rawPoints, gesture.rdpTolerance);

    // Independent passes can accumulate outside the replaced window. Apply the
    // same complete-lane budget as point editing before allocating history or
    // changing mode, instead of accepting an envelope the editor cannot replace.
    if (!canAdmitAutomationPunch(lanePtr->points, thinned.size(),
                                 gesture.punchInBeats, rampEndBeats)) {
        setStatus("Could not record automation: the complete lane exceeds 65,536 points");
        return;
    }

    AutomationLane updatedLane = *lanePtr;
    if (!AutomationRecorder::punchPointsIntoLane(
            updatedLane, thinned, gesture.punchInBeats, rampEndBeats)) {
        setStatus("Could not record automation: preserving the surrounding curve exceeds its safe point budget");
        return;
    }

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Record automation gesture");
    lanePtr->points = std::move(updatedLane.points);

    // Write mode automatically returns to touch safety to prevent unintentional overwriting
    if (lanePtr->writeMode == AutomationWriteMode::Write) {
        lanePtr->writeMode = AutomationWriteMode::Touch;
    }

    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus(gesture.pointsCompacted
        ? "Automation gesture recorded with bounded sample compaction"
        : "Automation gesture recorded");
}

} // namespace resostage
