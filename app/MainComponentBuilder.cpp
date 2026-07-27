// Builder structural-edit parity for the web UI. Each method here mirrors
// the matching BuilderPanel.cpp method (addItem/removeItem/moveItem/
// apply*Settings) as closely as possible -- same Project mutations, same
// engine setter calls, same post-edit refresh hooks -- just driven by a JSON
// payload (see WebCommand::json, parsed with simdjson via BuilderJson.h)
// instead of native widget state. Kept in its own translation unit so
// MainComponent.cpp doesn't balloon; these are still MainComponent member
// functions with full access to `engine`/`builderPanel`/etc.

#include "MainComponent.h"
#include "web/BuilderJson.h"

#include <algorithm>
#include <cstdio>

namespace resoset {

using namespace builder_json;

namespace {

bool parseJson(const std::string& json, simdjson::dom::element& out) {
    static simdjson::dom::parser parser; // simdjson's parser is reusable/reentrant only from one thread at a time -- fine here (message thread only)
    return !parser.parse(json).get(out);
}

} // namespace

void MainComponent::builderSongAdd(const std::string& json) {
    if (!engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    std::vector<std::string> used;
    for (const auto& s : proj.songs)
        used.push_back(s.id);
    SongDef song;
    song.id = makeUniqueId("song", used);
    song.name = "New Song";
    song.bpm = 120.0;
    if (!proj.busses.empty())
        song.builtInClickBusId = proj.busses.front().id;

    const std::string defaultBusId = !proj.busses.empty() ? proj.busses.front().id : "main";

    // Callers that build their own exact track list right after adding the
    // song (e.g. ImportStemsModal.tsx mapping stem files to tracks) pass
    // noSeed so they get a genuinely empty song instead -- without this,
    // the default-track seeding below collided with their own trackAdd()
    // calls: the seeded tracks shifted every index the caller assumed was
    // fresh, so trackUpdate() ended up renaming/uploading onto the WRONG
    // (pre-seeded) track while the caller's own newly-added track sat
    // unused, still called "New Track" with no audio.
    simdjson::dom::element doc;
    bool noSeed = false;
    if (parseJson(json, doc))
        getBool(doc, "noSeed", noSeed);

    if (noSeed) {
        // no tracks -- caller adds exactly what it needs
    } else if (!proj.songs.empty() && !proj.songs.front().tracks.empty()) {
        std::vector<std::string> trUsed;
        for (const auto& masterTr : proj.songs.front().tracks) {
            TrackDef t;
            t.id = makeUniqueId("trk", trUsed);
            trUsed.push_back(t.id);
            t.name = masterTr.name;
            t.file = ""; // empty audio region until imported
            t.busId = masterTr.busId;
            t.gainDb = masterTr.gainDb;
            t.pan = masterTr.pan;
            t.mute = masterTr.mute;
            t.solo = masterTr.solo;
            t.sends = masterTr.sends;
            song.tracks.push_back(std::move(t));
        }
    } else {
        const std::vector<std::string> defaultTrackNames = {
            "Drums", "Percussion", "Bass", "Guitars", "Synths", "Vocals", "SFX", "Guide"
        };
        std::vector<std::string> trUsed;
        for (const auto& tname : defaultTrackNames) {
            TrackDef t;
            t.id = makeUniqueId("trk", trUsed);
            trUsed.push_back(t.id);
            t.name = tname;
            t.file = "";
            t.busId = defaultBusId;
            song.tracks.push_back(std::move(t));
        }
    }

    proj.songs.push_back(std::move(song));

    goToSong(static_cast<int>(proj.songs.size()) - 1);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Song added");
}

void MainComponent::builderSongRemove(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.songs.size()))
        return;

    proj.songs.erase(proj.songs.begin() + index);
    if (!proj.songs.empty())
        goToSong(std::min(index, static_cast<int>(proj.songs.size()) - 1));
    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Song removed");
}

void MainComponent::builderSongMove(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1, delta = 0;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !getInt(doc, "delta", delta)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    const int to = index + delta;
    if (index < 0 || index >= static_cast<int>(proj.songs.size()) || to < 0
        || to >= static_cast<int>(proj.songs.size()))
        return;

    std::swap(proj.songs[static_cast<size_t>(index)], proj.songs[static_cast<size_t>(to)]);
    goToSong(to);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
}

void MainComponent::builderSongUpdate(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(index)];

    std::string strVal;
    double numVal;
    int intVal;
    bool boolVal;
    if (getString(doc, "name", strVal)) s.name = strVal;
    if (getDouble(doc, "bpm", numVal)) s.bpm = numVal;
    if (getString(doc, "mode", strVal))
        s.playbackMode = (strVal == "auto") ? PlaybackMode::AutoplayNext : PlaybackMode::WaitForTrigger;
    if (getInt(doc, "tsNum", intVal)) s.timeSignature.numerator = intVal;
    if (getInt(doc, "tsDen", intVal)) s.timeSignature.denominator = intVal;
    if (getBool(doc, "click", boolVal)) s.builtInClickEnabled = boolVal;
    if (getString(doc, "clickBusId", strVal)) s.builtInClickBusId = strVal;

    // clickSends: full replacement when present (web sends the entire array)
    simdjson::dom::array clickSendsArr;
    if (!doc["clickSends"].get(clickSendsArr)) {
        s.builtInClickSends.clear();
        for (simdjson::dom::element csEl : clickSendsArr) {
            TrackSendDef cs;
            std::string_view sv;
            if (csEl["busId"].get(sv))
                continue; // busId is required
            cs.busId = std::string(sv);
            (void)csEl["gainDb"].get(cs.gainDb);
            bool enabled = true;
            (void)csEl["enabled"].get(enabled);
            cs.enabled = enabled;
            s.builtInClickSends.push_back(std::move(cs));
        }
    }

    if (index == static_cast<int>(engine.currentSongIndex())) {
        engine.refreshClickState();
    } else {
        goToSong(index);
    }
    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Song updated");
}

void MainComponent::builderTrackAdd(const std::string& json) {
    simdjson::dom::element doc;
    int songIndex = -1;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    std::vector<std::string> used;
    for (const auto& t : s.tracks)
        used.push_back(t.id);
    TrackDef track;
    track.id = makeUniqueId("trk", used);
    track.name = "New Track";
    track.file = ""; // no audio yet -- empty is the established "unassigned" convention
                      // (see StreamingEngine::stageSong's `trackDef.file.empty()` skip and
                      // builderSongAdd's default-track seeding); a fake non-empty path here
                      // caused "File not found in archive" failures on song select/play.
    track.busId = proj.busses.empty() ? "bus_main" : proj.busses.front().id;
    s.tracks.push_back(std::move(track));

    goToSong(songIndex);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Track added -- use Import WAV to give it audio");
}

void MainComponent::builderTrackRemove(const std::string& json) {
    simdjson::dom::element doc;
    int songIndex = -1, index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getInt(doc, "index", index)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];
    if (index < 0 || index >= static_cast<int>(s.tracks.size()))
        return;

    s.tracks.erase(s.tracks.begin() + index);
    goToSong(songIndex);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Track removed");
}

void MainComponent::builderTrackMove(const std::string& json) {
    simdjson::dom::element doc;
    int songIndex = -1, index = -1, delta = 0;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getInt(doc, "index", index)
        || !getInt(doc, "delta", delta) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];
    const int to = index + delta;
    if (index < 0 || index >= static_cast<int>(s.tracks.size()) || to < 0
        || to >= static_cast<int>(s.tracks.size()))
        return;

    std::swap(s.tracks[static_cast<size_t>(index)], s.tracks[static_cast<size_t>(to)]);
    goToSong(songIndex);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
}

void MainComponent::builderTrackUpdate(const std::string& json) {
    simdjson::dom::element doc;
    int songIndex = -1, index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getInt(doc, "index", index)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];
    if (index < 0 || index >= static_cast<int>(s.tracks.size()))
        return;
    TrackDef& t = s.tracks[static_cast<size_t>(index)];

    std::string strVal;
    double numVal;
    bool boolVal;
    if (getString(doc, "name", strVal)) t.name = strVal;
    if (getString(doc, "busId", strVal)) t.busId = strVal; // "" == sends-only, matches kNoBusComboId
    if (getDouble(doc, "gainDb", numVal)) t.gainDb = numVal;
    if (getDouble(doc, "pan", numVal)) t.pan = numVal;
    if (getBool(doc, "mute", boolVal)) t.mute = boolVal;
    if (getBool(doc, "solo", boolVal)) t.solo = boolVal;

    // Same live-routing setters MixerStrip/BuilderPanel's "Apply track" call
    // -- safe to call unconditionally whether or not songIndex is staged.
    const auto sIdx = static_cast<size_t>(songIndex);
    const auto tIdx = static_cast<size_t>(index);
    engine.setTrackGainDb(sIdx, tIdx, t.gainDb);
    engine.setTrackPan(sIdx, tIdx, t.pan);
    engine.setTrackMute(sIdx, tIdx, t.mute);
    engine.setTrackSolo(sIdx, tIdx, t.solo);
    engine.setTrackBusId(sIdx, tIdx, t.busId);

    builderPanel.refresh();
    mixerPanel.refreshStructure();
    playerPanel.refreshProject();
    setStatus("Track updated");
}

void MainComponent::setTrackSendFromJson(const std::string& json) {
    simdjson::dom::element doc;
    int trackIndex = -1;
    std::string busId;
    double gainDb = 0.0;
    if (!parseJson(json, doc) || !getInt(doc, "trackIndex", trackIndex) || !getString(doc, "busId", busId)
        || !getDouble(doc, "gainDb", gainDb) || !engine.isProjectLoaded())
        return;
    const size_t idx = static_cast<size_t>(trackIndex);
    const size_t songIdx = engine.currentSongIndex();
    const TrackDef* t = engine.trackDefAt(idx);
    if (t == nullptr)
        return;

    // Mirrors MixerPanel.cpp's onSendChanged: find this track's existing send
    // to busId and update its gain, or create one if this is the first time
    // (turning a knob up from its floor implicitly creates the send).
    for (size_t si = 0; si < t->sends.size(); ++si) {
        if (t->sends[si].busId == busId) {
            TrackSendDef updated = t->sends[si];
            updated.gainDb = gainDb;
            engine.setTrackSend(songIdx, idx, si, updated);
            mixerPanel.refreshStructure();
            return;
        }
    }
    TrackSendDef newSend;
    newSend.busId = busId;
    newSend.gainDb = gainDb;
    newSend.enabled = true;
    engine.addTrackSend(songIdx, idx, newSend);
    mixerPanel.refreshStructure();
}

void MainComponent::builderTrackImportWavUpload(int songIndex, int trackIndex, const std::string& tempWavPath) {
    if (songIndex < 0 || trackIndex < 0) {
        std::remove(tempWavPath.c_str());
        setStatus("Import failed: no target track");
        return;
    }
    if (engine.projectPath().empty()) {
        // importWavForTrackAsync needs an on-disk archive to write into --
        // unlike the native flow (which can pop a Save As prompt), a remote
        // upload has nowhere to prompt, so just fail with a clear reason.
        std::remove(tempWavPath.c_str());
        setStatus("Import failed: save the project first (it needs an archive to write audio into)");
        return;
    }

    const auto sIdx = static_cast<size_t>(songIndex);
    const auto tIdx = static_cast<size_t>(trackIndex);
    engine.importWavForTrackAsync(sIdx, tIdx, tempWavPath, [this, tempWavPath](bool ok, std::string error) {
        std::remove(tempWavPath.c_str());
        if (!ok) {
            setStatus("Import failed: " + juce::String(error));
            return;
        }
        builderPanel.refresh();
        if (builderPanel.onProjectEdited)
            builderPanel.onProjectEdited();
        setStatus("WAV imported");
    });
}

void MainComponent::builderBusAdd() {
    if (!engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    std::vector<std::string> used;
    for (const auto& b : proj.busses)
        used.push_back(b.id);
    BusDef bus;
    bus.id = makeUniqueId("bus", used);
    bus.name = "New Bus";
    bus.channels = 2;
    int nextCh = 0;
    for (const auto& b : proj.busses)
        nextCh = std::max(nextCh, b.output.startChannel + b.channels);
    bus.output.startChannel = nextCh;
    proj.busses.push_back(std::move(bus));

    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Bus added");
}

void MainComponent::builderBusRemove(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.busses.size()) || proj.busses.size() <= 1)
        return; // keep at least one bus, matches BuilderPanel::removeItem()

    const std::string removedId = proj.busses[static_cast<size_t>(index)].id;
    proj.busses.erase(proj.busses.begin() + index);
    const std::string fallback = proj.busses.front().id;
    for (auto& song : proj.songs)
        for (auto& tr : song.tracks)
            if (tr.busId == removedId)
                tr.busId = fallback;

    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Bus removed");
}

void MainComponent::builderBusMove(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1, delta = 0;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !getInt(doc, "delta", delta)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    const int to = index + delta;
    if (index < 0 || index >= static_cast<int>(proj.busses.size()) || to < 0
        || to >= static_cast<int>(proj.busses.size()))
        return;

    std::swap(proj.busses[static_cast<size_t>(index)], proj.busses[static_cast<size_t>(to)]);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
}

void MainComponent::builderBusUpdate(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.busses.size()))
        return;
    BusDef& b = proj.busses[static_cast<size_t>(index)];

    std::string strVal;
    double numVal;
    int intVal;
    bool boolVal;
    if (getString(doc, "name", strVal)) b.name = strVal;
    if (getInt(doc, "channels", intVal)) b.channels = (intVal >= 2) ? 2 : 1;
    if (getInt(doc, "startChannel", intVal)) b.output.startChannel = intVal;
    if (getDouble(doc, "gainDb", numVal)) b.gainDb = numVal;
    if (getBool(doc, "mute", boolVal)) b.mute = boolVal;
    if (getBool(doc, "solo", boolVal)) b.solo = boolVal;
    if (getBool(doc, "isAux", boolVal)) b.isAux = boolVal;

    const auto idx = static_cast<size_t>(index);
    engine.setBusGainDb(idx, b.gainDb);
    engine.setBusMute(idx, b.mute);
    engine.setBusSolo(idx, b.solo);
    engine.setBusOutputChannel(idx, b.output.startChannel);

    builderPanel.refresh();
    mixerPanel.refreshStructure();
    setStatus("Bus updated");
}

void MainComponent::builderEventAdd(const std::string& json) {
    simdjson::dom::element doc;
    int songIndex = -1;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

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

    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Event added");
}

void MainComponent::builderEventRemove(const std::string& json) {
    simdjson::dom::element doc;
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

    s.events.erase(s.events.begin() + index);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Event removed");
}

void MainComponent::builderEventMove(const std::string& json) {
    simdjson::dom::element doc;
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

    std::swap(s.events[static_cast<size_t>(index)], s.events[static_cast<size_t>(to)]);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
}

void MainComponent::builderEventUpdate(const std::string& json) {
    simdjson::dom::element doc;
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

    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Event updated");
}

} // namespace resoset
