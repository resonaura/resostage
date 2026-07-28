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

    // No per-song track seeding needed; tracks are project-global.

    proj.songs.push_back(std::move(song));

    goToSong(static_cast<int>(proj.songs.size()) - 1);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Song added");
}

void MainComponent::builderSongImportFolder(const std::string& json) {
    simdjson::dom::element doc;
    std::string path;
    if (!parseJson(json, doc) || !getString(doc, "path", path) || path.empty()) {
        // No path provided -- this is the native UI's own button, which has
        // no other way to name a folder; show the native picker as before.
        builderPanel.importSongFolderClicked();
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
        builderPanel.refresh();
        builderPanel.onProjectEdited();
        setStatus("Song imported");
    });
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
    // Click gain/pan are project-global (not per-song).
    if (getDouble(doc, "clickGainDb", numVal))
        proj.builtInClickGainDb = numVal;
    if (getDouble(doc, "clickPan", numVal))
        proj.builtInClickPan = std::clamp(numVal, -1.0, 1.0);

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

    // Click gain is project-global -- always refresh live click even if this
    // song isn't the staged one.
    engine.refreshClickState();
    if (index != static_cast<int>(engine.currentSongIndex()))
        goToSong(index);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Song updated");
}

void MainComponent::builderTrackAdd(const std::string& json) {
    if (!engine.isProjectLoaded())
        return;
    Project& proj = engine.project();

    std::vector<std::string> used;
    for (const auto& t : proj.tracks)
        used.push_back(t.id);
    TrackDef track;
    track.id = makeUniqueId("trk", used);
    track.name = "New Track";
    track.busId = proj.busses.empty() ? "main" : proj.busses.front().id;
    proj.tracks.push_back(track);

    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Track added");
}

void MainComponent::builderTrackRemove(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.tracks.size()))
        return;

    proj.tracks.erase(proj.tracks.begin() + index);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Track removed");
}

void MainComponent::builderTrackMove(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1, delta = 0;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !getInt(doc, "delta", delta) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    const int to = index + delta;
    if (index < 0 || index >= static_cast<int>(proj.tracks.size()) || to < 0 || to >= static_cast<int>(proj.tracks.size()))
        return;

    std::swap(proj.tracks[static_cast<size_t>(index)], proj.tracks[static_cast<size_t>(to)]);
    builderPanel.refresh();
    builderPanel.onProjectEdited();
}

void MainComponent::builderTrackUpdate(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.tracks.size()))
        return;
    TrackDef& t = proj.tracks[static_cast<size_t>(index)];

    std::string strVal;
    double numVal;
    bool boolVal;
    if (getString(doc, "name", strVal)) t.name = strVal;
    if (getString(doc, "busId", strVal)) t.busId = strVal;
    if (getDouble(doc, "gainDb", numVal)) t.gainDb = numVal;
    if (getDouble(doc, "pan", numVal)) t.pan = numVal;
    if (getBool(doc, "mute", boolVal)) t.mute = boolVal;
    if (getBool(doc, "solo", boolVal)) t.solo = boolVal;
    if (getBool(doc, "mono", boolVal)) t.mono = boolVal;

    engine.setTrackGainDb(0, static_cast<size_t>(index), t.gainDb);
    engine.setTrackPan(0, static_cast<size_t>(index), t.pan);
    engine.setTrackBusId(0, static_cast<size_t>(index), t.busId);
    engine.setTrackMute(0, static_cast<size_t>(index), t.mute);
    engine.setTrackSolo(0, static_cast<size_t>(index), t.solo);
    engine.setTrackMono(0, static_cast<size_t>(index), t.mono);

    builderPanel.refresh();
    builderPanel.onProjectEdited();
}

void MainComponent::builderRegionAdd(const std::string& json) {
    simdjson::dom::element doc;
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
    getString(doc, "file", reg.file);
    if (reg.file.empty())
        return;

    getDouble(doc, "startSeconds", reg.startSeconds);
    getDouble(doc, "sourceOffsetSeconds", reg.sourceOffsetSeconds);
    getDouble(doc, "durationSeconds", reg.durationSeconds);
    getDouble(doc, "gainDb", reg.gainDb);
    getDouble(doc, "fadeInSeconds", reg.fadeInSeconds);
    getDouble(doc, "fadeOutSeconds", reg.fadeOutSeconds);

    s.regions.push_back(std::move(reg));
    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Region added");
}

void MainComponent::builderRegionRemove(const std::string& json) {
    simdjson::dom::element doc;
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
        s.regions.erase(it, s.regions.end());
        builderPanel.refresh();
        builderPanel.onProjectEdited();
        setStatus("Region removed");
    }
}

void MainComponent::builderRegionUpdate(const std::string& json) {
    simdjson::dom::element doc;
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

    std::string strVal;
    double numVal;
    if (getString(doc, "trackId", strVal)) regPtr->trackId = strVal;
    if (getString(doc, "file", strVal)) regPtr->file = strVal;
    if (getDouble(doc, "startSeconds", numVal)) regPtr->startSeconds = numVal;
    if (getDouble(doc, "sourceOffsetSeconds", numVal)) regPtr->sourceOffsetSeconds = numVal;
    if (getDouble(doc, "durationSeconds", numVal)) regPtr->durationSeconds = numVal;
    if (getDouble(doc, "gainDb", numVal)) regPtr->gainDb = numVal;
    if (getDouble(doc, "fadeInSeconds", numVal)) regPtr->fadeInSeconds = numVal;
    if (getDouble(doc, "fadeOutSeconds", numVal)) regPtr->fadeOutSeconds = numVal;

    builderPanel.refresh();
    builderPanel.onProjectEdited();
    setStatus("Region updated");
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

void MainComponent::setProjectNameFromJson(const std::string& json) {
    simdjson::dom::element doc;
    std::string name;
    if (!parseJson(json, doc) || !getString(doc, "name", name) || !engine.isProjectLoaded())
        return;
    name.erase(0, name.find_first_not_of(" \t"));
    name.erase(name.find_last_not_of(" \t") + 1);
    if (name.empty())
        return;

    engine.project().name = name;
    engine.markDirty();
    projectTitle.setText(juce::String(name), juce::dontSendNotification);
    setStatus("Project renamed to '" + juce::String(name) + "'");
}

void MainComponent::removeTrackSendFromJson(const std::string& json) {
    simdjson::dom::element doc;
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

    for (size_t si = 0; si < t->sends.size(); ++si) {
        if (t->sends[si].busId == busId) {
            engine.removeTrackSend(songIdx, idx, si);
            mixerPanel.refreshStructure();
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

    // Anything that *depends* on the removed bus needs to be untangled, not
    // just the tracks that had it as their primary output above: a dangling
    // TrackSendDef/click-send referencing a bus id that no longer exists is
    // silently skipped by AudioEngine's routing build (see busIndexById
    // lookups there), so it wouldn't crash or misroute audio -- but it'd sit
    // in the project forever as dead weight, and sendsCount/UI would keep
    // showing a send that can never do anything. Drop those send rows
    // outright instead of leaving them dangling or silently re-pointing them
    // at some other bus (which would be a surprising routing change).
    auto dropsRemovedSend = [&removedId](const TrackSendDef& s) { return s.busId == removedId; };
    for (auto& tr : proj.tracks) {
        if (tr.busId == removedId)
            tr.busId = fallback;
        tr.sends.erase(std::remove_if(tr.sends.begin(), tr.sends.end(), dropsRemovedSend),
                        tr.sends.end());
    }
    for (auto& song : proj.songs) {
        if (song.builtInClickBusId == removedId)
            song.builtInClickBusId = fallback;
        song.builtInClickSends.erase(
            std::remove_if(song.builtInClickSends.begin(), song.builtInClickSends.end(), dropsRemovedSend),
            song.builtInClickSends.end());
    }

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
