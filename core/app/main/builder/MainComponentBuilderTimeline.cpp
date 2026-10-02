/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Timeline marker, cycle, and MIDI event Builder commands.
#include "MainComponent.h"
#include "engine/AudioEngineInternal.h"
#include "project/ProjectJson.h"
#include "project/RouteId.h"
#include "server/BuilderJson.h"

#if JUCE_WINDOWS
#include <windows.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace resostage {

using namespace builder_json;

// Structural song markers (Intro/Verse/Chorus/Bridge/Outro/Solo/custom) --
// web-command equivalent of TimelineView.cpp's section-marker ruler
// (addSectionAt/showSectionContextMenu). Identity is by `sectionId` (like
// regions), not positional index (like events), since repositioning a
// marker is just a startSeconds update, not a swap.
void MainComponent::builderSectionAdd(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    std::vector<std::string> used;
    for (const auto& sec : s.sections)
        used.push_back(sec.id);

    SongSection sec;
    sec.id = makeUniqueId("sec", used);
    std::string name;
    sec.name = getString(doc, "name", name) ? name : "Section";
    getDouble(doc, "startSeconds", sec.startSeconds);
    sec.startSeconds = std::max(0.0, sec.startSeconds);
    sec.colorIndex = static_cast<int>(s.sections.size());

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Add section");
    s.sections.push_back(std::move(sec));
    std::sort(s.sections.begin(), s.sections.end(),
              [](const SongSection& a, const SongSection& b) { return a.startSeconds < b.startSeconds; });
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Section added");
}

void MainComponent::builderSectionRemove(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string sectionId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "sectionId", sectionId)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    const auto it = std::find_if(s.sections.begin(), s.sections.end(),
                              [&](const SongSection& sec) { return sec.id == sectionId; });
    if (it != s.sections.end()) {
        std::string gestureId;
        getString(doc, "gestureId", gestureId);
        engine.projectHistoryBeginEdit(gestureId, "Remove section");
        // Compaction moves rows too: capture history before erase/remove.
        std::erase_if(s.sections, [&](const SongSection& sec) { return sec.id == sectionId; });
        engine.projectHistoryCommitEdit();
        notifyProjectStructureChanged();
        setStatus("Section removed");
    }
}

void MainComponent::builderSectionUpdate(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string sectionId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "sectionId", sectionId)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    SongSection* secPtr = nullptr;
    for (auto& sec : s.sections) {
        if (sec.id == sectionId) {
            secPtr = &sec;
            break;
        }
    }
    if (!secPtr) return;

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Edit section");

    std::string strVal;
    double numVal;
    int intVal;
    if (getString(doc, "name", strVal)) secPtr->name = strVal;
    if (getDouble(doc, "startSeconds", numVal)) secPtr->startSeconds = std::max(0.0, numVal);
    if (getInt(doc, "colorIndex", intVal)) secPtr->colorIndex = intVal;

    // Re-sort after a position change (drag) -- matches TimelineView.cpp's
    // own post-drag sort, and keeps "jump to next/last section" navigation
    // (which walks this vector in order) correct without its own re-sort.
    std::sort(s.sections.begin(), s.sections.end(),
              [](const SongSection& a, const SongSection& b) { return a.startSeconds < b.startSeconds; });
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Section updated");
}

void MainComponent::builderCycleUpdate(const std::string& json) {
    glz::generic doc;
    if (!parseJson(json, doc) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Edit cycle");

    // Single project-wide cycle. songIndex rebinds the zone to a song
    // (required when creating/moving locators); left/right stay song-local.
    int songIndex = proj.cycle.songIndex;
    if (getInt(doc, "songIndex", songIndex)) {
        if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size())) {
            engine.projectHistoryCommitEdit();
            return;
        }
        proj.cycle.songIndex = songIndex;
    }

    bool boolVal = false;
    double numVal = 0.0;
    if (getBool(doc, "active", boolVal))
        proj.cycle.active = boolVal;
    if (getBool(doc, "skip", boolVal))
        proj.cycle.skip = boolVal;
    if (getDouble(doc, "leftSec", numVal))
        proj.cycle.startSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "rightSec", numVal))
        proj.cycle.endSeconds = std::max(0.0, numVal);
    if (proj.cycle.endSeconds < proj.cycle.startSeconds)
        std::swap(proj.cycle.startSeconds, proj.cycle.endSeconds);

    // If still unbound, attach to the currently staged song.
    if (proj.cycle.songIndex < 0 && !proj.songs.empty())
        proj.cycle.songIndex = static_cast<int>(engine.currentSongIndex());

    engine.projectHistoryCommitEdit();
    engine.markDirty();
    // Mirror onto audio-thread atomics so loop/skip applies even with no SPA
    // client driving seeks, and every tab hears the same cycle.
    engine.syncTransportCycleFromProject();
    // A locator drag changes no source interval or tempo. Keep the prepared
    // all-song activity index while publishing cycle and structural UI state.
    notifyProjectStructureChanged(/*contentChanged=*/false);
}

void MainComponent::builderEventAdd(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    engine.projectHistoryBeginEdit("", "Add event");

    std::vector<std::string> used;
    for (const auto& e : s.events)
        used.push_back(e.id);
    TimelineEvent ev;
    ev.id = makeUniqueId("ev", used);
    ev.type = EventType::MidiProgramChange;
    ev.timeSeconds = 0.0;
    ev.midiChannel = 1;
    ev.midiProgram = 0;
    s.events.push_back(std::move(ev));
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Event added");
}

void MainComponent::builderEventRemove(const std::string& json) {
    glz::generic doc;
    int songIndex = -1, index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getInt(doc, "index", index)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];
    if (index < 0 || index >= static_cast<int>(s.events.size()))
        return;

    engine.projectHistoryBeginEdit("", "Remove event");
    s.events.erase(s.events.begin() + index);
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Event removed");
}

void MainComponent::builderEventMove(const std::string& json) {
    glz::generic doc;
    int songIndex = -1, index = -1, delta = 0;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getInt(doc, "index", index)
        || !getInt(doc, "delta", delta) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];
    const int to = index + delta;
    if (index < 0 || index >= static_cast<int>(s.events.size()) || to < 0
        || to >= static_cast<int>(s.events.size()))
        return;

    engine.projectHistoryBeginEdit("", "Move event");
    std::swap(s.events[static_cast<size_t>(index)], s.events[static_cast<size_t>(to)]);
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
}

void MainComponent::builderEventUpdate(const std::string& json) {
    glz::generic doc;
    int songIndex = -1, index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getInt(doc, "index", index)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];
    if (index < 0 || index >= static_cast<int>(s.events.size()))
        return;
    TimelineEvent& e = s.events[static_cast<size_t>(index)];

    // A gestureId collapses a whole slider drag / typed field into one entry,
    // exactly as region edits do.
    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Edit event");

    std::string strVal;
    double numVal;
    int intVal;
    bool boolVal;
    if (getString(doc, "type", strVal)) e.type = eventTypeFromWebString(strVal);
    if (getDouble(doc, "timeSeconds", numVal)) e.timeSeconds = numVal;
    if (getBool(doc, "triggerOnLoad", boolVal)) e.triggerOnLoad = boolVal;
    if (getDouble(doc, "latencyMs", numVal)) e.latencyCompensationMs = numVal;
    if (getInt(doc, "midiChannel", intVal)) e.midiChannel = intVal;
    if (getInt(doc, "midiProgram", intVal)) e.midiProgram = intVal;
    if (getInt(doc, "midiCC", intVal)) e.midiCC = intVal;
    if (getInt(doc, "midiCCValue", intVal)) e.midiCCValue = intVal;
    if (getInt(doc, "midiNote", intVal)) e.midiNote = intVal;
    if (getInt(doc, "midiVelocity", intVal)) e.midiVelocity = intVal;
    if (getString(doc, "httpUrl", strVal)) e.httpUrl = strVal;
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Event updated");
}

} // namespace resostage
