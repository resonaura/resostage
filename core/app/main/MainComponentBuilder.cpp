// Builder structural-edit parity for the web UI. Each method here mirrors
// the matching BuilderPanel.cpp method (addItem/removeItem/moveItem/
// apply*Settings) as closely as possible -- same Project mutations, same
// engine setter calls, same post-edit refresh hooks -- just driven by a JSON
// payload (see WebCommand::json, parsed with glz::generic via BuilderJson.h)
// instead of native widget state. Kept in its own translation unit so
// MainComponent.cpp doesn't balloon; these are still MainComponent member
// functions with full access to engine / web-command handlers.

#include "MainComponent.h"
#include "engine/AudioEngineInternal.h"
#include "project/ProjectJson.h"
#include "project/RouteId.h"
#include "server/BuilderJson.h"
#include "automation/AutomationRecorder.h"
#include "automation/RamerDouglasPeucker.h"

#if JUCE_WINDOWS
#include <windows.h>
#endif

#include <algorithm>
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
    if (getString(doc, "name", strVal)) s.name = strVal;
    if (getDouble(doc, "bpm", numVal)) { s.bpm = numVal; bpmChanged = true; }
    if (getString(doc, "mode", strVal))
        s.onEnded = (strVal == "auto") ? SongEnd::Next : SongEnd::Stop;
    if (getInt(doc, "tsNum", intVal)) s.timeSignature.numerator = intVal;
    if (getInt(doc, "tsDen", intVal)) s.timeSignature.denominator = intVal;

    if (index != static_cast<int>(engine.currentSongIndex())) {
        goToSong(index); // pushes BPM to LightEngine itself once this song is staged
    } else if (bpmChanged) {
        // Editing the ACTIVE song's own tempo -- goToSong() isn't called for
        // this branch, so nothing else re-syncs LightEngine's BPM. Without
        // this, tempo-synced light effects on real hardware keep running at
        // the pre-edit tempo indefinitely (see RESTORE_POINT.md).
        engine.notifyLightEngineBpmChanged(s.bpm);
    }
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Song updated");
}

void MainComponent::builderTrackAdd(const std::string& /*json*/) {
    if (!engine.isProjectLoaded())
        return;
    Project& proj = engine.project();

    std::vector<std::string> used;
    for (const auto& t : proj.tracks)
        used.push_back(t.id);
    TrackDef track;
    track.id = makeUniqueId("trk", used);
    track.name = "New Track";
    track.output.type = OutputType::Main;
    engine.projectHistoryBeginEdit("", "Add track");
    proj.tracks.push_back(track);
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Track added");
}

void MainComponent::builderTrackRemove(const std::string& json) {
    glz::generic doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.tracks.size()))
        return;

    engine.projectHistoryBeginEdit("", "Remove track");
    proj.tracks.erase(proj.tracks.begin() + index);
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Track removed");
}

void MainComponent::builderTrackMove(const std::string& json) {
    glz::generic doc;
    int index = -1, delta = 0;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !getInt(doc, "delta", delta) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    const int to = index + delta;
    if (index < 0 || index >= static_cast<int>(proj.tracks.size()) || to < 0 || to >= static_cast<int>(proj.tracks.size()))
        return;

    engine.projectHistoryBeginEdit("", "Move track");
    std::swap(proj.tracks[static_cast<size_t>(index)], proj.tracks[static_cast<size_t>(to)]);
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
}

void MainComponent::builderTrackUpdate(const std::string& json) {
    glz::generic doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.tracks.size()))
        return;
    TrackDef& t = proj.tracks[static_cast<size_t>(index)];

    // Covers every field this endpoint can touch, including the Mixer's
    // "Direct Output" bus (re)assignment (see mixer.setTrackBus in api.ts) --
    // the fast dedicated endpoints for gain/pan/mute/solo/mono already wrap
    // their own history in MainComponent::drainWebCommands' dispatchOne, so
    // this is what was missing for "any mixer action" to be undoable.
    engine.projectHistoryBeginEdit("", "Edit track");

    std::string strVal;
    double numVal;
    bool boolVal;
    if (getString(doc, "name", strVal)) t.name = strVal;
    if (getString(doc, "busId", strVal)) {
        // Same 3-way route mapping as the click's busId: "" = Sends Only,
        // "audio::main" = Main, otherwise an ext-out target string.
        if (strVal.empty()) {
            t.output.type = OutputType::SendsOnly;
            t.output.target.reset();
        } else if (strVal == "audio::main") {
            t.output.type = OutputType::Main;
            t.output.target.reset();
        } else {
            t.output.type = OutputType::ExtOut;
            t.output.target = strVal;
        }
    }
    if (getDouble(doc, "gainDb", numVal)) t.gainDb = numVal;
    if (getDouble(doc, "pan", numVal)) t.pan = numVal;
    if (getBool(doc, "mute", boolVal)) t.mute = boolVal;
    if (getBool(doc, "solo", boolVal)) t.solo = boolVal;
    if (getBool(doc, "mono", boolVal)) t.channels = boolVal ? 1 : 2;

    engine.setTrackGainDb(0, static_cast<size_t>(index), t.gainDb);
    engine.setTrackPan(0, static_cast<size_t>(index), t.pan);
    engine.setTrackBusId(0, static_cast<size_t>(index), routeIdOf(t.output));
    engine.setTrackMute(0, static_cast<size_t>(index), t.mute);
    engine.setTrackSolo(0, static_cast<size_t>(index), t.solo);
    engine.setTrackMono(0, static_cast<size_t>(index), t.channels == 1);

    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
}

void MainComponent::builderRegionAdd(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string trackId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "trackId", trackId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    std::vector<std::string> used;
    for (const auto& r : s.regions)
        used.push_back(r.id);

    Region reg;
    reg.id = makeUniqueId("reg", used);
    reg.trackId = trackId;
    getString(doc, "file", reg.source.file);
    if (reg.source.file.empty())
        return;

    getDouble(doc, "startSeconds", reg.startSeconds);
    getDouble(doc, "sourceOffsetSeconds", reg.source.offsetSeconds);
    getDouble(doc, "durationSeconds", reg.durationSeconds);
    getDouble(doc, "gainDb", reg.gainDb);
    getDouble(doc, "fadeInSeconds", reg.fade.inSeconds);
    getDouble(doc, "fadeOutSeconds", reg.fade.outSeconds);
    getDouble(doc, "fadeInCurve", reg.fade.inCurve);
    getDouble(doc, "fadeOutCurve", reg.fade.outCurve);
    bool loopEnabled = false;
    getBool(doc, "loop", loopEnabled);
    reg.loop.enabled = loopEnabled;

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Add region");
    s.regions.push_back(std::move(reg));
    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("Region added");
}

void MainComponent::builderRegionRemove(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string regionId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "regionId", regionId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    auto it = std::remove_if(s.regions.begin(), s.regions.end(), [&](const Region& r) { return r.id == regionId; });
    if (it != s.regions.end()) {
        std::string gestureId;
        getString(doc, "gestureId", gestureId);
        engine.projectHistoryBeginEdit(gestureId, "Remove region");
        s.regions.erase(it, s.regions.end());
        engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
        setStatus("Region removed");
    }
}

void MainComponent::builderRegionUpdate(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string regionId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "regionId", regionId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    Region* regPtr = nullptr;
    for (auto& r : s.regions) {
        if (r.id == regionId) {
            regPtr = &r;
            break;
        }
    }
    if (!regPtr) return;

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Edit region");

    std::string strVal;
    double numVal;
    if (getString(doc, "trackId", strVal)) regPtr->trackId = strVal;
    if (getString(doc, "file", strVal)) regPtr->source.file = strVal;
    if (getDouble(doc, "startSeconds", numVal)) regPtr->startSeconds = numVal;
    if (getDouble(doc, "sourceOffsetSeconds", numVal)) regPtr->source.offsetSeconds = numVal;
    if (getDouble(doc, "durationSeconds", numVal)) regPtr->durationSeconds = numVal;
    if (getDouble(doc, "gainDb", numVal)) regPtr->gainDb = numVal;
    if (getDouble(doc, "fadeInSeconds", numVal)) regPtr->fade.inSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "fadeOutSeconds", numVal)) regPtr->fade.outSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "fadeInCurve", numVal))
        regPtr->fade.inCurve = std::clamp(numVal, -1.0, 1.0);
    if (getDouble(doc, "fadeOutCurve", numVal))
        regPtr->fade.outCurve = std::clamp(numVal, -1.0, 1.0);
    bool loopEnabled = false;
    if (getBool(doc, "loop", loopEnabled))
        regPtr->loop.enabled = loopEnabled;
    if (getDouble(doc, "loopLengthSeconds", numVal))
        regPtr->loop.lengthSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "speed", numVal))
        regPtr->playback.speed = std::clamp(numVal, 0.25, 4.0);
    if (getDouble(doc, "semitones", numVal))
        regPtr->playback.semitones = std::clamp(numVal, -24.0, 24.0);
    bool reverseFlag = false;
    if (getBool(doc, "reverse", reverseFlag))
        regPtr->playback.reverse = reverseFlag;

    // Keep fades from exceeding the clip length (each side ≤ half duration).
    if (regPtr->durationSeconds > 0.0) {
        const double maxFade = std::max(0.0, regPtr->durationSeconds * 0.5);
        regPtr->fade.inSeconds = std::min(regPtr->fade.inSeconds, maxFade);
        regPtr->fade.outSeconds = std::min(regPtr->fade.outSeconds, maxFade);
    }

    engine.projectHistoryCommitEdit();
    engine.updateRegionWindow(*regPtr);
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("Region updated");
}

void MainComponent::builderMidiRegionAdd(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string trackId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "trackId", trackId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    std::vector<std::string> used;
    for (const auto& r : s.midiRegions)
        used.push_back(r.id);

    MidiRegion reg;
    reg.id = makeUniqueId("midi_reg", used);
    reg.trackId = trackId;
    getString(doc, "name", reg.name);
    if (reg.name.empty()) reg.name = "MIDI Region";
    getDouble(doc, "startBeats", reg.startBeats);
    getDouble(doc, "durationBeats", reg.durationBeats);
    if (reg.durationBeats <= 0.0) reg.durationBeats = 16.0;
    getDouble(doc, "clipOffsetBeats", reg.clipOffsetBeats);
    bool loop = false;
    getBool(doc, "loop", loop);
    reg.loop = loop;
    getDouble(doc, "loopLengthBeats", reg.loopLengthBeats);
    if (reg.loopLengthBeats <= 0.0) reg.loopLengthBeats = reg.durationBeats;
    getString(doc, "color", reg.color);

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Add MIDI region");
    s.midiRegions.push_back(std::move(reg));
    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("MIDI region added");
}

void MainComponent::builderMidiRegionRemove(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string regionId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "regionId", regionId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    auto it = std::remove_if(s.midiRegions.begin(), s.midiRegions.end(), [&](const MidiRegion& r) { return r.id == regionId; });
    if (it != s.midiRegions.end()) {
        std::string gestureId;
        getString(doc, "gestureId", gestureId);
        engine.projectHistoryBeginEdit(gestureId, "Remove MIDI region");
        s.midiRegions.erase(it, s.midiRegions.end());
        engine.projectHistoryCommitEdit();
        engine.markDirty();
        notifyProjectStructureChanged();
        setStatus("MIDI region removed");
    }
}

void MainComponent::builderMidiRegionUpdate(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string regionId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "regionId", regionId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    MidiRegion* regPtr = nullptr;
    for (auto& r : s.midiRegions) {
        if (r.id == regionId) {
            regPtr = &r;
            break;
        }
    }
    if (!regPtr) return;

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Edit MIDI region");

    std::string strVal;
    double numVal;
    bool boolVal;
    if (getString(doc, "trackId", strVal)) regPtr->trackId = strVal;
    if (getString(doc, "name", strVal)) regPtr->name = strVal;
    if (getDouble(doc, "startBeats", numVal)) regPtr->startBeats = std::max(0.0, numVal);
    if (getDouble(doc, "durationBeats", numVal)) regPtr->durationBeats = std::max(0.25, numVal);
    if (getDouble(doc, "clipOffsetBeats", numVal)) regPtr->clipOffsetBeats = numVal;
    if (getBool(doc, "loop", boolVal)) regPtr->loop = boolVal;
    if (getDouble(doc, "loopLengthBeats", numVal)) regPtr->loopLengthBeats = std::max(0.25, numVal);
    if (getBool(doc, "muted", boolVal)) regPtr->muted = boolVal;
    if (getString(doc, "color", strVal)) regPtr->color = strVal;

    // Optional notes array update
    if (doc.contains("notes") && doc["notes"].is_array()) {
        const auto& arr = doc["notes"].get_array();
        std::vector<MidiNote> updatedNotes;
        updatedNotes.reserve(arr.size());
        for (const auto& noteVal : arr) {
            if (!noteVal.is_object()) continue;
            MidiNote n;
            int idInt = 0;
            if (getInt(noteVal, "id", idInt)) n.id = static_cast<uint64_t>(idInt);
            int pitchInt = 60;
            if (getInt(noteVal, "pitch", pitchInt)) n.pitch = static_cast<uint8_t>(std::clamp(pitchInt, 0, 127));
            getDouble(noteVal, "startBeats", n.startBeats);
            getDouble(noteVal, "durationBeats", n.durationBeats);
            double v = 0.8;
            if (getDouble(noteVal, "velocity", v)) n.velocity = static_cast<float>(std::clamp(v, 0.0, 1.0));
            double relV = 0.5;
            if (getDouble(noteVal, "releaseVelocity", relV)) n.releaseVelocity = static_cast<float>(std::clamp(relV, 0.0, 1.0));
            double prob = 1.0;
            if (getDouble(noteVal, "probability", prob)) n.probability = static_cast<float>(std::clamp(prob, 0.0, 1.0));
            bool m = false;
            if (getBool(noteVal, "muted", m)) n.muted = m;
            updatedNotes.push_back(n);
        }
        regPtr->notes = std::move(updatedNotes);
    }

    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
}

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

    auto it = std::remove_if(s.sections.begin(), s.sections.end(),
                              [&](const SongSection& sec) { return sec.id == sectionId; });
    if (it != s.sections.end()) {
        std::string gestureId;
        getString(doc, "gestureId", gestureId);
        engine.projectHistoryBeginEdit(gestureId, "Remove section");
        s.sections.erase(it, s.sections.end());
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
    notifyProjectStructureChanged();
}

void MainComponent::setTrackSendFromJson(const std::string& json) {
    glz::generic doc;
    int trackIndex = -1;
    std::string busId;
    double level = 0.0;
    if (!parseJson(json, doc) || !getInt(doc, "trackIndex", trackIndex)
        || !getString(doc, "busId", busId) || !getDouble(doc, "level", level)
        || !engine.isProjectLoaded())
        return;
    // `level` is the schema's own unit: 0-100 LINEAR percent, 100 = unity.
    // The wire used to carry dB and convert here, which is why a send saved
    // at "100%" could never be set to exactly 0 or exactly 100 from the UI --
    // the round trip through dB and back always landed just off.
    level = std::clamp(level, 0.0, 100.0);

    // Absent `enabled` means "just move the level" -- an enabled send stays
    // enabled, and turning a knob up from the floor implicitly creates one.
    bool enabled = true;
    const bool enabledGiven = getBool(doc, "enabled", enabled);

    const size_t idx = static_cast<size_t>(trackIndex);
    const size_t songIdx = engine.currentSongIndex();
    const TrackDef* t = engine.trackDefAt(idx);
    if (t == nullptr)
        return;

    // A send knob is dragged, so its stream of writes carries a gestureId and
    // collapses into one undo entry -- without it, turning one knob buried
    // every earlier edit under a hundred entries, which is the same as having
    // no history at all.
    std::string gestureId;
    getString(doc, "gestureId", gestureId);

    for (size_t si = 0; si < t->output.sends.size(); ++si) {
        if (t->output.sends[si].bus == busId) {
            SendConfig updated = t->output.sends[si];
            updated.level = level;
            updated.enabled = enabledGiven ? enabled : updated.enabled;
            engine.projectHistoryBeginEdit(gestureId, "Edit send");
            engine.setTrackSend(songIdx, idx, si, updated);
            engine.projectHistoryCommitEdit();
            notifyRoutingChanged();
            return;
        }
    }
    SendConfig newSend;
    newSend.bus = busId;
    newSend.level = level;
    newSend.enabled = enabledGiven ? enabled : true;
    engine.projectHistoryBeginEdit(gestureId, "Add send");
    engine.addTrackSend(songIdx, idx, newSend);
    engine.projectHistoryCommitEdit();
    notifyRoutingChanged();
}

void MainComponent::setProjectNameFromJson(const std::string& json) {
    glz::generic doc;
    std::string name;
    if (!parseJson(json, doc) || !getString(doc, "name", name) || !engine.isProjectLoaded())
        return;
    name.erase(0, name.find_first_not_of(" \t"));
    name.erase(name.find_last_not_of(" \t") + 1);
    if (name.empty())
        return;

    engine.projectHistoryBeginEdit("", "Rename project");
    engine.project().name = name;
    engine.projectHistoryCommitEdit();
    engine.markDirty();
    setStatus("Project renamed to '" + juce::String(name) + "'");
}

void MainComponent::removeTrackSendFromJson(const std::string& json) {
    glz::generic doc;
    int trackIndex = -1;
    std::string busId;
    if (!parseJson(json, doc) || !getInt(doc, "trackIndex", trackIndex) || !getString(doc, "busId", busId)
        || !engine.isProjectLoaded())
        return;
    const size_t idx = static_cast<size_t>(trackIndex);
    const size_t songIdx = engine.currentSongIndex();
    const TrackDef* t = engine.trackDefAt(idx);
    if (t == nullptr)
        return;

    for (size_t si = 0; si < t->output.sends.size(); ++si) {
        if (t->output.sends[si].bus == busId) {
            engine.projectHistoryBeginEdit("", "Remove send");
            engine.removeTrackSend(songIdx, idx, si);
            engine.projectHistoryCommitEdit();
            notifyRoutingChanged();
            return;
        }
    }
}

void MainComponent::builderTrackImportWavUpload(int songIndex, int trackIndex, const std::string& tempWavPath) {
    if (songIndex < 0 || trackIndex < 0) {
        std::remove(tempWavPath.c_str());
        setStatus("Import failed: no target track");
        return;
    }
    if (engine.projectPath().empty()) {
        std::string err;
        const auto docDir = juce::File::getSpecialLocation(juce::File::userHomeDirectory).getChildFile("Documents").getChildFile("ResoSet_Projects");
        docDir.createDirectory();
        const std::string defaultPath = docDir.getChildFile("UntitledProject.rsnraset").getFullPathName().toStdString();
        if (!engine.saveProject(defaultPath, err)) {
            std::remove(tempWavPath.c_str());
            setStatus("Import failed: could not auto-create project archive (" + juce::String(err) + ")");
            return;
        }
    }

    const auto sIdx = static_cast<size_t>(songIndex);
    const auto tIdx = static_cast<size_t>(trackIndex);
    engine.importWavForTrackAsync(sIdx, tIdx, tempWavPath, [this, tempWavPath](bool ok, std::string error) {
        std::remove(tempWavPath.c_str());
        if (!ok) {
            setStatus("Import failed: " + juce::String(error));
            return;
        }
    notifyProjectStructureChanged();
        setStatus("WAV imported");
    });
}

void MainComponent::builderTrackImportWavDialog(const std::string& json) {
    if (!engine.isProjectLoaded())
        return;
    glz::generic doc;
    int songIndex = -1, trackIndex = -1;
    if (parseJson(json, doc)) {
        getInt(doc, "songIndex", songIndex);
        getInt(doc, "index", trackIndex);
    }
    if (songIndex < 0 || trackIndex < 0)
        return;

    // Native OS picker -- only reachable from the embedded webview (the
    // plain-browser timeline keeps its own <input type=file> fallback, see
    // AudioTrackLanes.tsx). The picked file imports straight from disk, no
    // upload round-trip. importWavForTrackAsync auto-creates a default
    // archive if the project was never saved, so no extra guard needed here.
#if JUCE_WINDOWS
    ::AllowSetForegroundWindow(ASFW_ANY);
#endif
    fileChooser = std::make_unique<juce::FileChooser>(
        "Open Audio File", juce::File(),
        "*.wav;*.wave;*.aiff;*.aif;*.mp3;*.flac;*.ogg;*.m4a;*.aac;*.opus;*.wma;*.caf");
    const auto browserFlags = juce::FileBrowserComponent::openMode
                               | juce::FileBrowserComponent::canSelectFiles;
    const auto sIdx = static_cast<size_t>(songIndex);
    const auto tIdx = static_cast<size_t>(trackIndex);
    fileChooser->launchAsync(browserFlags, [this, sIdx, tIdx](const juce::FileChooser& fc) {
        const auto file = fc.getResult();
        if (file == juce::File() || !file.existsAsFile())
            return;
        engine.importWavForTrackAsync(sIdx, tIdx, file.getFullPathName().toStdString(),
                                      [this](bool ok, std::string error) {
            if (!ok) {
                setStatus("Import failed: " + juce::String(error));
                return;
            }
            notifyProjectStructureChanged();
            setStatus("Audio imported");
        });
    });
}

void MainComponent::builderBusAdd() {
    if (!engine.isProjectLoaded())
        return;
    Project& proj = engine.project();

    // Sends own a sequential "audio::send:N" id -- reuse any gaps left by
    // earlier removals by continuing past the highest existing suffix.
    int maxSend = 0;
    constexpr const char* kSendPrefix = "audio::send:";
    for (const auto& s : proj.sends) {
        if (s.id.rfind(kSendPrefix, 0) != 0)
            continue;
        try {
            maxSend = std::max(maxSend, std::stoi(s.id.substr(std::string(kSendPrefix).size())));
        } catch (...) {
            continue;
        }
    }
    SendBus bus;
    bus.id = kSendPrefix + std::to_string(maxSend + 1);
    bus.name = "New Bus";
    bus.channels = 2;
    bus.output.type = OutputType::ExtOut;

    // Place the new send on the first physical channel past every bus that
    // already owns direct channels (master included).
    int nextCh = 0;
    const auto extendFrom = [&nextCh](const std::optional<std::string>& target) {
        if (!target.has_value())
            return;
        int start = 0, count = 0;
        parseExtOutTarget(*target, start, count);
        nextCh = std::max(nextCh, start + count);
    };
    extendFrom(proj.main.output.target);
    for (const auto& s : proj.sends)
        extendFrom(s.output.target);
    bus.output.target = extOutTarget(nextCh, bus.channels);

    engine.projectHistoryBeginEdit("", "Add Send");
    proj.sends.push_back(std::move(bus));
    engine.projectHistoryCommitEdit();
    engine.rebuildBussesFromProject();
    notifyProjectStructureChanged();
    setStatus("Send added");
}

void MainComponent::builderBusRemove(const std::string& json) {
    glz::generic doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    // Bus rail indexes: 0 = Master (never removable), 1..N = Sends.
    if (index <= 0 || index > static_cast<int>(proj.sends.size()))
        return;

    engine.projectHistoryBeginEdit("", "Remove send");
    const size_t sIdx = static_cast<size_t>(index - 1);
    const std::string removedId = proj.sends[sIdx].id;
    proj.sends.erase(proj.sends.begin() + static_cast<ptrdiff_t>(sIdx));

    // Anything that depends on the removed send needs to be untangled: a
    // dangling send row referencing a bus id that no longer exists is
    // silently skipped by AudioEngine's routing build (see busIndexById
    // lookups there), so it wouldn't crash or misroute audio -- but it'd sit
    // in the project forever as dead weight, and sendsCount/UI would keep
    // showing a send that can never do anything. Drop those send rows
    // outright instead of leaving them dangling or silently re-pointing them
    // at some other bus (which would be a surprising routing change).
    auto dropsRemovedSend = [&removedId](const SendConfig& s) { return s.bus == removedId; };
    for (auto& tr : proj.tracks)
        tr.output.sends.erase(std::remove_if(tr.output.sends.begin(), tr.output.sends.end(), dropsRemovedSend),
                              tr.output.sends.end());
    // Project-global metronome routing.
    proj.click.output.sends.erase(
        std::remove_if(proj.click.output.sends.begin(), proj.click.output.sends.end(), dropsRemovedSend),
        proj.click.output.sends.end());
    engine.projectHistoryCommitEdit();
    engine.rebuildBussesFromProject();
    notifyProjectStructureChanged();
    setStatus("Send removed");
}

void MainComponent::builderBusMove(const std::string& json) {
    glz::generic doc;
    int index = -1, delta = 0;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !getInt(doc, "delta", delta)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    const int to = index + delta;
    // Bus rail indexes: 0 = Master (fixed), 1..N = Sends.
    if (index <= 0 || index > static_cast<int>(proj.sends.size()) || to <= 0
        || to > static_cast<int>(proj.sends.size()))
        return;

    engine.projectHistoryBeginEdit("", "Move send");
    std::swap(proj.sends[static_cast<size_t>(index - 1)], proj.sends[static_cast<size_t>(to - 1)]);
    engine.projectHistoryCommitEdit();
    engine.rebuildBussesFromProject();
    notifyProjectStructureChanged();
}

void MainComponent::builderBusUpdate(const std::string& json) {
    glz::generic doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index > static_cast<int>(proj.sends.size()))
        return;

    // Covers every field this endpoint can touch, including bus creation's
    // follow-up configure step (queueBusJob in MixerScreen.tsx -- "Add Send"
    // / "Direct Output" both create-then-immediately-busUpdate) and channel
    // width / routing changes. The fast dedicated endpoints for gain/mute/
    // solo already wrap their own history in dispatchOne; this covers the
    // rest of what "any mixer action" needs.
    engine.projectHistoryBeginEdit("", "Edit bus");

    std::string strVal;
    double numVal;
    int intVal;
    bool boolVal;
    if (index == 0) {
        // Master strip -- lives in proj.main (never a send).
        if (getString(doc, "name", strVal)) proj.main.name = strVal;
        if (getInt(doc, "channels", intVal)) proj.main.channels = (intVal >= 2) ? 2 : 1;
        int startChannel = -1;
        if (getInt(doc, "startChannel", intVal)) startChannel = intVal;
        if (getDouble(doc, "gainDb", numVal)) proj.main.gainDb = numVal;
        if (getDouble(doc, "pan", numVal)) proj.main.pan = std::clamp(numVal, -1.0, 1.0);
        if (getBool(doc, "mute", boolVal)) proj.main.mute = boolVal;
        if (getBool(doc, "solo", boolVal)) proj.main.solo = boolVal;
        if (startChannel >= 0) {
            proj.main.output.type = OutputType::ExtOut;
            proj.main.output.target = extOutTarget(startChannel, proj.main.channels);
        }
    } else {
        SendBus& b = proj.sends[static_cast<size_t>(index - 1)];
        if (getString(doc, "name", strVal)) b.name = strVal;
        if (getInt(doc, "channels", intVal)) b.channels = (intVal >= 2) ? 2 : 1;
        int startChannel = -1;
        if (getInt(doc, "startChannel", intVal)) startChannel = intVal;
        if (getDouble(doc, "gainDb", numVal)) b.gainDb = numVal;
        if (getDouble(doc, "pan", numVal)) b.pan = std::clamp(numVal, -1.0, 1.0);
        if (getBool(doc, "mute", boolVal)) b.mute = boolVal;
        if (getBool(doc, "solo", boolVal)) b.solo = boolVal;
        if (startChannel >= 0) {
            b.output.type = OutputType::ExtOut;
            b.output.target = extOutTarget(startChannel, b.channels);
        }
    }

    engine.projectHistoryCommitEdit();

    // Always rebuild the live bus list from project so LoadedBus.channelCount
    // stays in lockstep with SendBus.channels and the ext-out targets.
    // rebuildBussesFromProject also republishes the routing snapshot (gain/
    // mute/solo/startChannel all read from project).
    engine.rebuildBussesFromProject();
    notifyRoutingChanged();
    setStatus("Bus updated");
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
