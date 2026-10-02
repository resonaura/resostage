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
#include "project/ProjectJson.h"
#include "server/BuilderJson.h"
#include "server/AutomationJson.h"
#include "timing/TempoMap.h"

#include <algorithm>
#include <bit>
#include <cmath>

namespace resostage {

using namespace builder_json;

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
    double initialTimeBeats = 0.0, initialValue = 0.0;
    if (doc.contains("points")) {
        std::string error;
        if (!parseAutomationPoints(doc, lane.points, error)) {
            setStatus("Could not add automation lane: " + juce::String(error));
            return;
        }
    } else if (getDouble(doc, "initialValue", initialValue)) {
        (void)getDouble(doc, "initialTimeBeats", initialTimeBeats);
        if (std::isfinite(initialTimeBeats) && std::isfinite(initialValue)) {
            lane.points.push_back({std::max(0.0, initialTimeBeats),
                static_cast<float>(initialValue), 0.0f});
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
    engine.projectHistoryBeginEdit(gestureId, "Update automation lane");

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
    double timeBeats = 0.0, value = 0.0, curve = 0.0;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "laneId", laneId)
        || !getDouble(doc, "timeBeats", timeBeats) || !getDouble(doc, "value", value) || !engine.isProjectLoaded())
        return;
    getDouble(doc, "curve", curve);

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
    engine.projectHistoryBeginEdit(gestureId, "Add automation point");

    AutomationPoint pt;
    pt.timeBeats = std::max(0.0, timeBeats);
    pt.value = static_cast<float>(value);
    pt.curve = static_cast<float>(std::clamp(curve, -1.0, 1.0));

    bool updated = false;
    for (auto& p : lanePtr->points) {
        if (std::abs(p.timeBeats - pt.timeBeats) < 1.0e-6) {
            p = pt;
            updated = true;
            break;
        }
    }
    if (!updated) {
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
    if (!lanePtr) return;

    double punchInBeats = 0.0, releaseBeats = 0.0, releaseVal = 0.0, returnRampBeats = 0.0, underlyingVal = 0.0, rdpTol = 0.002;
    getDouble(doc, "punchInBeats", punchInBeats);
    getDouble(doc, "releaseBeats", releaseBeats);
    getDouble(doc, "releaseValue", releaseVal);
    getDouble(doc, "returnRampBeats", returnRampBeats);
    getDouble(doc, "underlyingValue", underlyingVal);
    getDouble(doc, "rdpTolerance", rdpTol);

    std::vector<AutomationPoint> rawPoints;
    if (doc.contains("points") && doc["points"].is_array()) {
        const auto& arr = doc["points"].get_array();
        rawPoints.reserve(arr.size());
        for (const auto& ptVal : arr) {
            if (!ptVal.is_object()) continue;
            double t = 0.0, v = 0.0;
            if (getDouble(ptVal, "timeBeats", t) && getDouble(ptVal, "value", v)) {
                rawPoints.push_back({t, static_cast<float>(v), 0.0f});
            }
        }
    }

    if (rawPoints.empty()) {
        rawPoints.push_back({punchInBeats, static_cast<float>(releaseVal), 0.0f});
    }

    rawPoints.push_back({releaseBeats, static_cast<float>(releaseVal), 0.0f});
    double rampEndBeats = releaseBeats;
    if (returnRampBeats > 0.0) {
        rampEndBeats = releaseBeats + returnRampBeats;
        rawPoints.push_back({rampEndBeats, static_cast<float>(underlyingVal), 0.0f});
    }

    std::sort(rawPoints.begin(), rawPoints.end(),
              [](const AutomationPoint& a, const AutomationPoint& b) {
                  return a.timeBeats < b.timeBeats;
              });

    const auto thinned = RamerDouglasPeucker::thin(rawPoints, rdpTol > 0.0 ? rdpTol : 0.002);

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Record automation gesture");

    AutomationRecorder::punchPointsIntoLane(*lanePtr, thinned, punchInBeats, rampEndBeats);

    // Write mode automatically returns to touch safety to prevent unintentional overwriting
    if (lanePtr->writeMode == AutomationWriteMode::Write) {
        lanePtr->writeMode = AutomationWriteMode::Touch;
    }

    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("Automation gesture recorded");
}

} // namespace resostage
