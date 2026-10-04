/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Web Builder song mutations, owned by the JUCE message thread.
// Project edits and undo history remain on this thread; this is an exact
// organizational split from MainComponentBuilder.cpp.

#include "MainComponent.h"
#include "engine/AudioEngineInternal.h"
#include "project/ProjectJson.h"
#include "project/RouteId.h"
#include "server/BuilderJson.h"
#include "timing/TempoMap.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace resostage {

using namespace builder_json;

void MainComponent::builderSongAdd(const std::string& json) {
    if (!engine.isProjectLoaded())
        return;
    engine.projectHistoryBeginEdit("", "Add song");
    Project& proj = engine.project();
    std::vector<std::string> used;
    for (const auto& s : proj.songs)
        used.push_back(s.id);
    SongDef song;
    song.id = makeUniqueId("song", used);
    song.name = "New Song";
    song.bpm = 120.0;
    // Default 64 bars (Logic Pro standard project start length)
    constexpr double kDefaultBars = 64.0;
    song.endSeconds = (kDefaultBars * 4.0 * 60.0) / 120.0; // 128.0 seconds
    // Metronome is project-global and already defaults to routing into
    // Master (ClickChannel::output defaults OutputType::Main) -- no seeding
    // needed here.

    // Callers that build their own exact track list right after adding the
    // song (e.g. ImportStemsModal.tsx mapping stem files to tracks) pass
    // noSeed so they get a genuinely empty song instead -- without this,
    // the default-track seeding below collided with their own trackAdd()
    // calls: the seeded tracks shifted every index the caller assumed was
    // fresh, so trackUpdate() ended up renaming/uploading onto the WRONG
    // (pre-seeded) track while the caller's own newly-added track sat
    // unused, still called "New Track" with no audio.
    glz::generic doc;
    bool noSeed = false;
    if (parseJson(json, doc))
        getBool(doc, "noSeed", noSeed);

    // No per-song track seeding needed; tracks are project-global.

    proj.songs.push_back(std::move(song));

    goToSong(static_cast<int>(proj.songs.size()) - 1);
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Song added");
}

void MainComponent::builderSongImportFolder(const std::string& json) {
    glz::generic doc;
    std::string path;
    if (!parseJson(json, doc) || !getString(doc, "path", path) || path.empty()) {
        // No path provided -- this is the native UI's own button, which has
        // no other way to name a folder; show the native picker as before.
        importSongFolderNative();
        return;
    }

    // Fast (header-only reads), read-only -- fine to do synchronously before
    // handing off to importSongFromFolderAsync's background thread.
    std::vector<std::string> wavPaths;
    double scannedBpm = 0.0;
    std::string scanError;
    if (!engine.scanFolderForImport(path, wavPaths, scannedBpm, scanError)) {
        setStatus("Import scan failed: " + juce::String(scanError));
        return;
    }

    std::string name;
    if (!getString(doc, "name", name) || name.empty())
        name = juce::File(path).getFileName().toStdString();
    double bpm = 0.0;
    if (!getDouble(doc, "bpm", bpm) || bpm <= 0.0)
        bpm = scannedBpm > 0.0 ? scannedBpm : 120.0;
    int tsNum = 4, tsDen = 4;
    getInt(doc, "tsNum", tsNum);
    getInt(doc, "tsDen", tsDen);

    setStatus("Importing '" + juce::String(name) + "' (" + juce::String(static_cast<int>(wavPaths.size()))
              + " file(s))...");
    engine.importSongFromFolderAsync(path, name, bpm, tsNum, tsDen, [this](bool ok, std::string error) {
        if (!ok) {
            setStatus("Song import failed: " + juce::String(error));
            return;
        }
        notifyProjectStructureChanged();
        setStatus("Song imported");
    });
}

void MainComponent::builderSongRemove(const std::string& json) {
    glz::generic doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.songs.size()))
        return;

    engine.projectHistoryBeginEdit("", "Remove song");
    proj.songs.erase(proj.songs.begin() + index);
    if (!proj.songs.empty())
        goToSong(std::min(index, static_cast<int>(proj.songs.size()) - 1));
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Song removed");
}

void MainComponent::builderSongMove(const std::string& json) {
    glz::generic doc;
    int index = -1, delta = 0;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !getInt(doc, "delta", delta)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    const int to = index + delta;
    if (index < 0 || index >= static_cast<int>(proj.songs.size()) || to < 0
        || to >= static_cast<int>(proj.songs.size()))
        return;

    engine.projectHistoryBeginEdit("", "Move song");
    std::swap(proj.songs[static_cast<size_t>(index)], proj.songs[static_cast<size_t>(to)]);
    goToSong(to);
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
}

/**
 * Set (or clear) a song's authored end.
 *
 * Its own command rather than a field on builderSongUpdate because this is
 * dragged: the SPA sends one of these per animation frame while the pointer
 * moves, and song/update would rewrite the whole song -- tempo, time
 * signature, the project-global metronome and its sends -- on every one of
 * them. Sharing a gesture id coalesces the whole drag into a single undo
 * entry (see projectHistoryBeginEdit).
 *
 * `endSeconds <= 0` clears the override and returns the song to deriving its
 * length from its content, which is how "reset" is expressed without a second
 * endpoint.
 */
void MainComponent::builderSongEnd(const std::string& json) {
    glz::generic doc;
    int index = -1;
    double endSeconds = 0.0;
    if (!parseJson(json, doc) || !getInt(doc, "index", index)
        || !getDouble(doc, "endSeconds", endSeconds) || !engine.isProjectLoaded())
        return;

    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.songs.size()))
        return;

    if (!std::isfinite(endSeconds) || endSeconds <= 0.0)
        endSeconds = 0.0;

    SongDef& song = proj.songs[static_cast<size_t>(index)];
    // A drag re-sends a value every frame, most of them identical or a
    // fraction of a millisecond apart. Anything under a tenth of a
    // millisecond is not a length change anyone authored, and turning it into
    // a project edit means a save and a full state broadcast for nothing.
    constexpr double kEndEpsilonSeconds = 1e-4;
    if (std::abs(song.endSeconds - endSeconds) < kEndEpsilonSeconds)
        return;

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    if (gestureId.empty())
        gestureId = "song_end";

    engine.projectHistoryBeginEdit(gestureId, "Resize song");
    song.endSeconds = endSeconds;
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
}

void MainComponent::builderSongUpdate(const std::string& json) {
    glz::generic doc;
    if (!parseJson(json, doc) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    if (gestureId.empty()) {
        gestureId = "song_update";
    }
    engine.projectHistoryBeginEdit(gestureId, "Edit song");

    std::string strVal;
    double numVal;
    int intVal;
    bool boolVal;

    // Metronome is project-global. Apply click fields even with zero songs
    // (empty project) so the mixer/player can toggle the click freely.
    bool clickTouched = false;
    if (getBool(doc, "click", boolVal)) {
        proj.click.enabled = boolVal;
        clickTouched = true;
    }
    if (getString(doc, "clickName", strVal)) {
        proj.click.name = strVal.empty() ? "Click" : strVal;
        clickTouched = true;
    }
    if (getString(doc, "clickBusId", strVal)) {
        // Same flat route id a track's main destination uses -- one decoder
        // for both, so the metronome can never end up supporting a different
        // set of destinations than a track (see engine/project/RouteId.h).
        applyRouteId(proj.click.output, strVal, proj);
        clickTouched = true;
    }
    if (getDouble(doc, "clickGainDb", numVal)) {
        proj.click.gainDb = numVal;
        clickTouched = true;
    }
    if (getDouble(doc, "clickPan", numVal)) {
        proj.click.pan = std::clamp(numVal, -1.0, 1.0);
        clickTouched = true;
    }
    if (getBool(doc, "clickMono", boolVal)) {
        proj.click.channels = boolVal ? 1 : 2;
        clickTouched = true;
    }
    if (const auto* clickSendsArr = getArray(doc, "clickSends")) {
        clickTouched = true;
        proj.click.output.sends.clear();
        for (const auto& csEl : *clickSendsArr) {
            SendConfig cs;
            if (!getString(csEl, "busId", cs.bus))
                continue; // busId is required
            double levelVal = 0.0;
            if (getDouble(csEl, "level", levelVal)) {
                cs.level = levelVal;
            } else if (getDouble(csEl, "gainDb", levelVal)) {
                cs.level = sendDbToLevel(levelVal);
            }
            bool enabled = true;
            getBool(csEl, "enabled", enabled);
            cs.enabled = enabled;
            proj.click.output.sends.push_back(std::move(cs));
        }
    }
    if (clickTouched) {
        engine.refreshClickState();
    }

    int index = -1;
    if (!getInt(doc, "index", index) || index < 0
        || index >= static_cast<int>(proj.songs.size())) {
        // Click-only update (empty project / no valid song index).
        if (clickTouched) {
            engine.projectHistoryCommitEdit();
            notifyProjectStructureChanged();
            setStatus("Click updated");
        } else {
            engine.projectHistoryCommitEdit();
        }
        return;
    }
    SongDef& s = proj.songs[static_cast<size_t>(index)];

    bool bpmChanged = false;
    bool tempoMapChanged = false;
    if (getString(doc, "name", strVal)) s.name = strVal;
    if (getDouble(doc, "bpm", numVal)) { s.bpm = numVal; bpmChanged = true; }
    if (getString(doc, "mode", strVal))
        s.onEnded = (strVal == "auto") ? SongEnd::Next : SongEnd::Stop;
    if (getInt(doc, "tsNum", intVal)) s.timeSignature.numerator = intVal;
    if (getInt(doc, "tsDen", intVal)) s.timeSignature.denominator = intVal;
    if (const auto* tempoArr = getArray(doc, "tempoPoints")) {
        std::vector<TempoPoint> importedPoints;
        importedPoints.reserve(tempoArr->size());
        for (const auto& pointValue : *tempoArr) {
            TempoPoint point;
            if (!getDouble(pointValue, "beat", point.beat)
                || !getDouble(pointValue, "bpm", point.bpm)
                || !std::isfinite(point.beat) || !std::isfinite(point.bpm) || point.bpm <= 0.0)
                continue;
            getDouble(pointValue, "timeSeconds", point.timeSeconds);
            getDouble(pointValue, "curve", point.curve);
            importedPoints.push_back(point);
        }
        TempoMap normalized(s.bpm, std::move(importedPoints));
        s.tempoPoints = normalized.points();
        tempoMapChanged = true;
    }
    if (const auto* signatureArr = getArray(doc, "signaturePoints")) {
        std::vector<SignaturePoint> importedPoints;
        importedPoints.reserve(signatureArr->size());
        for (const auto& pointValue : *signatureArr) {
            SignaturePoint point;
            if (!getDouble(pointValue, "beat", point.beat)
                || !getInt(pointValue, "numerator", point.numerator)
                || !getInt(pointValue, "denominator", point.denominator)
                || !std::isfinite(point.beat) || point.beat < 0.0
                || point.numerator <= 0 || point.denominator <= 0)
                continue;
            getInt(pointValue, "bar", point.bar);
            getInt(pointValue, "thirtySecondsPerQuarter", point.thirtySecondsPerQuarter);
            if (point.thirtySecondsPerQuarter < 0 || point.thirtySecondsPerQuarter > 255)
                continue;
            getInt(pointValue, "midiClocksPerMetronomeClick", point.midiClocksPerMetronomeClick);
            if (point.midiClocksPerMetronomeClick < 0
                || point.midiClocksPerMetronomeClick > 255)
                continue;
            importedPoints.push_back(point);
        }
        SignatureMap normalized(s.timeSignature.numerator, s.timeSignature.denominator,
                                std::move(importedPoints));
        s.signaturePoints = normalized.points();
    }

    if (index != static_cast<int>(engine.currentSongIndex())) {
        goToSong(index); // pushes BPM to LightEngine itself once this song is staged
    } else if (bpmChanged || tempoMapChanged) {
        // Editing the ACTIVE song's own tempo -- goToSong() isn't called for
        // this branch, so nothing else re-syncs LightEngine's BPM. Without
        // this, tempo-synced light effects on real hardware keep running at
        // the pre-edit tempo indefinitely (see RESTORE_POINT.md).
        if (bpmChanged || tempoMapChanged)
            engine.notifyLightEngineBpmChanged(s.bpm);
        engine.refreshActiveTempoMap();
    }
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Song updated");
}

} // namespace resostage
