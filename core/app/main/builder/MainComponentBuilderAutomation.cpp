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
#include "timing/TempoMap.h"

#include <algorithm>
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
    double initialTimeBeats = 0.0, initialValue = 0.0;
    if (getDouble(doc, "initialValue", initialValue)) {
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

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Add automation lane");

    if (!regionId.empty()) {
        bool added = false;
        for (auto& mr : s.midiRegions) {
            if (mr.id == regionId) {
                mr.automationLanes.push_back(lane);
                added = true;
                break;
            }
        }
        if (!added) {
            for (auto& r : s.regions) {
                if (r.id == regionId) {
                    r.automationLanes.push_back(lane);
                    added = true;
                    break;
                }
            }
        }
    } else {
        s.automationLanes.push_back(std::move(lane));
    }

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

    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("Automation gesture recorded");
}

} // namespace resostage

