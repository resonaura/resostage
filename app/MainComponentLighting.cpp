// Lighting web parity for the settings-card rig config, the 3D fixture
// placement editor, and the Editor's Light-mode timeline. Mirrors
// MainComponentBuilder.cpp's approach (JSON-driven, same Project mutations
// a native UI would make, same history wrapping) -- see RESTORE_POINT.md
// Feature 6 for the overall design.

#include "MainComponent.h"
#include "web/BuilderJson.h"

#include <algorithm>

namespace resostage {

using namespace builder_json;

namespace {

bool parseJson(const std::string& json, simdjson::dom::element& out) {
    static simdjson::dom::parser parser; // message-thread only, same convention as MainComponentBuilder.cpp
    return !parser.parse(json).get(out);
}

// Keeps the ResoLightBar subset of `cfg.fixtures` in sync with
// resoLightColumns x resoLightRows: grows/shrinks the tail, leaving every
// existing bar's id/position/LED count untouched, and never touches
// DmxGeneric entries. Idempotent -- calling it again with the same
// columns/rows is a no-op copy.
void regenerateResoLightFixtures(LightingConfig& cfg) {
    const int desired = std::max(0, cfg.resoLightColumns) * std::max(0, cfg.resoLightRows);

    std::vector<LightFixture> bars;
    std::vector<LightFixture> others;
    for (auto& f : cfg.fixtures) {
        if (f.kind == LightFixture::Kind::ResoLightBar)
            bars.push_back(f);
        else
            others.push_back(f);
    }

    if (static_cast<int>(bars.size()) > desired) {
        bars.resize(static_cast<size_t>(desired));
    } else {
        std::vector<std::string> used;
        for (const auto& f : cfg.fixtures)
            used.push_back(f.id);
        // Nominal default spacing -- purely a starting point for the 3D
        // editor; the user drags bars to their real position afterward.
        constexpr double kSpacingMeters = 2.0;
        while (static_cast<int>(bars.size()) < desired) {
            const int index = static_cast<int>(bars.size());
            const int col = cfg.resoLightColumns > 0 ? index % cfg.resoLightColumns : 0;
            const int row = cfg.resoLightColumns > 0 ? index / cfg.resoLightColumns : 0;
            LightFixture f;
            f.id = makeUniqueId("bar", used);
            used.push_back(f.id);
            f.name = "Bar " + std::to_string(index + 1);
            f.kind = LightFixture::Kind::ResoLightBar;
            f.gridColumn = col;
            f.gridRow = row;
            f.ledCount = 120;
            f.addressable = true;
            f.posX = col * kSpacingMeters;
            f.posY = 0.0;
            f.posZ = row * kSpacingMeters;
            bars.push_back(std::move(f));
        }
    }

    cfg.fixtures.clear();
    cfg.fixtures.reserve(bars.size() + others.size());
    for (auto& f : bars)
        cfg.fixtures.push_back(std::move(f));
    for (auto& f : others)
        cfg.fixtures.push_back(std::move(f));
}

} // namespace

void MainComponent::lightingSetConfig(const std::string& json) {
    simdjson::dom::element doc;
    if (!parseJson(json, doc) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    LightingConfig& cfg = proj.lighting;

    engine.projectHistoryBeginEdit("", "Edit lighting config");

    bool boolVal;
    std::string strVal;
    int intVal;
    if (getBool(doc, "enabled", boolVal))
        cfg.enabled = boolVal;
    if (getString(doc, "kind", strVal)) {
        if (strVal == "resoLight") cfg.kind = LightingKind::ResoLight;
        else if (strVal == "dmxGeneric") cfg.kind = LightingKind::DmxGeneric;
        else cfg.kind = LightingKind::None;
    }
    if (getInt(doc, "resoLightColumns", intVal))
        cfg.resoLightColumns = std::max(0, intVal);
    if (getInt(doc, "resoLightRows", intVal))
        cfg.resoLightRows = std::max(0, intVal);
    if (getString(doc, "idleBehavior", strVal)) {
        if (strVal == "blackout" || strVal == "staticColor" || strVal == "holdLast")
            cfg.idleBehavior = strVal;
    }
    if (getInt(doc, "idleColorR", intVal))
        cfg.idleColorR = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "idleColorG", intVal))
        cfg.idleColorG = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "idleColorB", intVal))
        cfg.idleColorB = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    double doubleVal;
    if (getDouble(doc, "idleIntensity", doubleVal))
        cfg.idleIntensity = std::clamp(doubleVal, 0.0, 1.0);

    if (cfg.kind == LightingKind::ResoLight)
        regenerateResoLightFixtures(cfg);

    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    // Every lighting mutator must refresh LightEngine's snapshot (see
    // RESTORE_POINT.md's "project snapshot goes stale" finding) -- otherwise
    // this edit is only visible in the web preview (which reads
    // engine.project() live) and never reaches the real-time DMX thread.
    engine.notifyLightEngineProjectChanged();
    setStatus("Lighting settings updated");
}

// Manual fixture add/remove -- the counterpart to regenerateResoLightFixtures
// above, which only ever manages the ResoLightBar subset via
// resoLightColumns/Rows. DmxGeneric fixtures (a moving head, a PAR can, any
// non-ResoLight instrument) have no grid concept to seed them from, so they
// need their own explicit add/remove, driven the same way as a ResoLight bar
// otherwise: one entry in cfg.fixtures, placed in the 3D stage, assignable to
// light tracks, driven by cues/effects through the exact same resolver path.
void MainComponent::lightingFixtureAdd(const std::string& json) {
    if (!engine.isProjectLoaded())
        return;
    simdjson::dom::element doc;
    const bool hasBody = parseJson(json, doc);

    Project& proj = engine.project();
    LightingConfig& cfg = proj.lighting;

    std::vector<std::string> used;
    for (const auto& f : cfg.fixtures)
        used.push_back(f.id);

    LightFixture f;
    f.id = makeUniqueId("dmx", used);
    std::string name;
    f.name = (hasBody && getString(doc, "name", name) && !name.empty())
        ? name
        : ("DMX Fixture " + std::to_string(cfg.fixtures.size() + 1));
    f.kind = LightFixture::Kind::DmxGeneric;
    f.addressable = false;
    f.ledCount = 1;
    // "bar" is the LightFixture default (meant for ResoLightBar), not a
    // sensible shape for a freshly added generic fixture -- "par" plus the
    // 3-channel RGB profile is the most common real-world starting point.
    f.shape = "par";
    f.channelProfile = "rgb";
    // Aimed off vertical by default, purely cosmetic -- reads as a real
    // hung fixture aiming at the stage rather than every light standing
    // bolt upright like a ResoLightBar. Trivially overridden per-fixture.
    f.tiltDeg = 25.0;

    // Auto-place right after the last occupied channel range in universe 0
    // so a freshly added fixture never silently overlaps an existing one's
    // DMX channels -- the user can still repoint it to a different
    // universe/range by hand afterward.
    int nextChannel = 1;
    for (const auto& other : cfg.fixtures) {
        if (other.dmxUniverse == 0)
            nextChannel = std::max(nextChannel, other.dmxStartChannel + other.dmxChannelCount);
    }
    f.dmxUniverse = 0;
    f.dmxStartChannel = std::min(nextChannel, 510);
    f.dmxChannelCount = 3;

    // Off to the side in the 3D stage, one step back per existing fixture,
    // so it never spawns on top of a ResoLight bar grid or another DMX
    // fixture -- same "just a starting point, drag it where it belongs"
    // spirit as regenerateResoLightFixtures' default spacing.
    f.posX = 0.0;
    f.posY = 0.0;
    f.posZ = static_cast<double>(cfg.fixtures.size()) * -2.0;

    engine.projectHistoryBeginEdit("", "Add DMX fixture");
    cfg.fixtures.push_back(std::move(f));
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
    setStatus("DMX fixture added");
}

void MainComponent::lightingFixtureDuplicate(const std::string& json) {
    simdjson::dom::element doc;
    std::string fixtureId;
    if (!parseJson(json, doc) || !getString(doc, "fixtureId", fixtureId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    LightingConfig& cfg = proj.lighting;

    const LightFixture* src = nullptr;
    for (const auto& f : cfg.fixtures) {
        if (f.id == fixtureId) {
            src = &f;
            break;
        }
    }
    if (src == nullptr)
        return;

    std::vector<std::string> used;
    for (const auto& f : cfg.fixtures)
        used.push_back(f.id);

    LightFixture copy = *src;
    copy.id = makeUniqueId(src->kind == LightFixture::Kind::ResoLightBar ? "bar" : "dmx", used);
    copy.name = src->name + " Copy";

    // Auto-place right after the last occupied channel range in the SAME
    // universe as the source -- same collision-avoidance lightingFixtureAdd
    // uses, since a byte-for-byte copy would otherwise leave both fixtures
    // pointing at identical DMX channels.
    int nextChannel = 1;
    for (const auto& other : cfg.fixtures) {
        if (other.dmxUniverse == src->dmxUniverse)
            nextChannel = std::max(nextChannel, other.dmxStartChannel + other.dmxChannelCount);
    }
    copy.dmxStartChannel = std::min(nextChannel, 510);

    // Nudged in the 3D stage so the copy doesn't spawn exactly on top of
    // the fixture it came from.
    copy.posX = src->posX + 0.5;
    copy.posZ = src->posZ + 0.5;

    engine.projectHistoryBeginEdit("", "Duplicate fixture");
    cfg.fixtures.push_back(std::move(copy));
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
    setStatus("Fixture duplicated");
}

void MainComponent::lightingFixtureRemove(const std::string& json) {
    simdjson::dom::element doc;
    std::string fixtureId;
    if (!parseJson(json, doc) || !getString(doc, "fixtureId", fixtureId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    LightingConfig& cfg = proj.lighting;

    auto it = std::find_if(cfg.fixtures.begin(), cfg.fixtures.end(),
                            [&](const LightFixture& f) { return f.id == fixtureId; });
    if (it == cfg.fixtures.end())
        return;

    engine.projectHistoryBeginEdit("", "Remove fixture");
    cfg.fixtures.erase(it);
    // Drop the removed fixture from every light track's roster -- an
    // orphaned fixtureId would never resolve to anything again (same
    // cleanup lightingTrackRemove does for cues referencing a removed
    // track).
    for (auto& lt : proj.lightTracks) {
        auto fit = std::remove(lt.fixtureIds.begin(), lt.fixtureIds.end(), fixtureId);
        lt.fixtureIds.erase(fit, lt.fixtureIds.end());
    }
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
    setStatus("Fixture removed");
}

void MainComponent::lightingFixtureUpdate(const std::string& json) {
    simdjson::dom::element doc;
    std::string fixtureId;
    if (!parseJson(json, doc) || !getString(doc, "fixtureId", fixtureId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    LightFixture* fx = nullptr;
    for (auto& f : proj.lighting.fixtures) {
        if (f.id == fixtureId) {
            fx = &f;
            break;
        }
    }
    if (fx == nullptr)
        return;

    engine.projectHistoryBeginEdit("", "Edit fixture");

    std::string strVal;
    double numVal;
    bool boolVal;
    int intVal;
    if (getString(doc, "name", strVal)) fx->name = strVal;
    if (getInt(doc, "ledCount", intVal)) fx->ledCount = std::max(1, intVal);
    if (getBool(doc, "addressable", boolVal)) fx->addressable = boolVal;
    if (getInt(doc, "gridColumn", intVal)) fx->gridColumn = std::max(0, intVal);
    if (getInt(doc, "gridRow", intVal)) fx->gridRow = std::max(0, intVal);
    if (getDouble(doc, "posX", numVal)) fx->posX = numVal;
    if (getDouble(doc, "posY", numVal)) fx->posY = numVal;
    if (getDouble(doc, "posZ", numVal)) fx->posZ = numVal;
    if (getDouble(doc, "rotationYDeg", numVal)) fx->rotationYDeg = numVal;
    if (getBool(doc, "mountedHorizontally", boolVal)) fx->mountedHorizontally = boolVal;
    if (getInt(doc, "dmxUniverse", intVal)) fx->dmxUniverse = intVal;
    if (getInt(doc, "dmxStartChannel", intVal)) fx->dmxStartChannel = intVal;
    if (getInt(doc, "dmxChannelCount", intVal)) fx->dmxChannelCount = intVal;
    // Cosmetic-only strings (see LightFixture's doc comment) -- the engine
    // never branches on either, so no allowlist to keep in sync here; the
    // web UI owns the canonical set of known values.
    if (getString(doc, "shape", strVal)) fx->shape = strVal;
    if (getInt(doc, "matrixCols", intVal)) fx->matrixCols = std::max(0, intVal);
    if (getString(doc, "channelProfile", strVal)) fx->channelProfile = strVal;
    if (getDouble(doc, "tiltDeg", numVal)) fx->tiltDeg = numVal;

    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
}

void MainComponent::lightingTrackAdd(const std::string& /*json*/) {
    if (!engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    std::vector<std::string> used;
    for (const auto& lt : proj.lightTracks)
        used.push_back(lt.id);
    LightTrack lt;
    lt.id = makeUniqueId("lt", used);
    lt.name = "New Light Track";

    engine.projectHistoryBeginEdit("", "Add light track");
    proj.lightTracks.push_back(std::move(lt));
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
    setStatus("Light track added");
}

void MainComponent::lightingTrackRemove(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.lightTracks.size()))
        return;
    const std::string removedId = proj.lightTracks[static_cast<size_t>(index)].id;

    engine.projectHistoryBeginEdit("", "Remove light track");
    proj.lightTracks.erase(proj.lightTracks.begin() + index);
    // An orphaned LightCue::trackId would never resolve to a fixture again --
    // drop cues on the removed track from every song rather than leave dead
    // weight in the file.
    for (auto& song : proj.songs) {
        auto it = std::remove_if(song.lightCues.begin(), song.lightCues.end(),
                                  [&](const LightCue& c) { return c.trackId == removedId; });
        song.lightCues.erase(it, song.lightCues.end());
    }
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
    setStatus("Light track removed");
}

void MainComponent::lightingTrackMove(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1, delta = 0;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !getInt(doc, "delta", delta)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    const int to = index + delta;
    if (index < 0 || index >= static_cast<int>(proj.lightTracks.size())
        || to < 0 || to >= static_cast<int>(proj.lightTracks.size()))
        return;

    engine.projectHistoryBeginEdit("", "Move light track");
    std::swap(proj.lightTracks[static_cast<size_t>(index)], proj.lightTracks[static_cast<size_t>(to)]);
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
}

void MainComponent::lightingTrackUpdate(const std::string& json) {
    simdjson::dom::element doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.lightTracks.size()))
        return;
    LightTrack& lt = proj.lightTracks[static_cast<size_t>(index)];

    engine.projectHistoryBeginEdit("", "Edit light track");

    std::string strVal;
    if (getString(doc, "name", strVal))
        lt.name = strVal;

    simdjson::dom::array fxIdsArr;
    if (!doc["fixtureIds"].get(fxIdsArr)) {
        lt.fixtureIds.clear();
        for (simdjson::dom::element idEl : fxIdsArr) {
            std::string_view v;
            if (!idEl.get(v))
                lt.fixtureIds.push_back(std::string(v));
        }
    }

    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
}

void MainComponent::lightingCueAdd(const std::string& json) {
    simdjson::dom::element doc;
    int songIndex = -1;
    std::string trackId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "trackId", trackId)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    std::vector<std::string> used;
    for (const auto& c : s.lightCues)
        used.push_back(c.id);

    LightCue cue;
    cue.id = makeUniqueId("lc", used);
    cue.trackId = trackId;
    double startSeconds = 0.0;
    getDouble(doc, "startSeconds", startSeconds);
    cue.startSeconds = std::max(0.0, startSeconds);
    double durationSeconds = 2.0;
    getDouble(doc, "durationSeconds", durationSeconds);
    cue.durationSeconds = std::max(0.1, durationSeconds);

    int intVal = 0;
    if (getInt(doc, "colorR", intVal)) cue.colorR = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "colorG", intVal)) cue.colorG = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "colorB", intVal)) cue.colorB = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    double numVal = 0.0;
    if (getDouble(doc, "intensity", numVal)) cue.intensity = std::clamp(numVal, 0.0, 1.0);
    if (getDouble(doc, "fadeInSeconds", numVal)) cue.fadeInSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "fadeOutSeconds", numVal)) cue.fadeOutSeconds = std::max(0.0, numVal);
    std::string strVal;
    if (getString(doc, "label", strVal)) cue.label = strVal;
    if (getString(doc, "effectType", strVal)) cue.effectType = strVal;
    if (getString(doc, "effectSourceType", strVal)) cue.effectSourceType = strVal;
    if (getString(doc, "effectSourceId", strVal)) cue.effectSourceId = strVal;
    if (getDouble(doc, "effectIntensity", numVal)) cue.effectIntensity = static_cast<float>(std::clamp(numVal, 0.0, 1.0));
    bool boolVal = false;
    if (getBool(doc, "tempoSync", boolVal)) cue.tempoSync = boolVal;
    if (getString(doc, "tempoSubdiv", strVal)) cue.tempoSubdiv = strVal;
    if (getDouble(doc, "effectRateHz", numVal)) cue.effectRateHz = static_cast<float>(std::max(0.01, numVal));
    if (getString(doc, "gradientPreset", strVal)) cue.gradientPreset = strVal;
    if (getString(doc, "gradientColors", strVal)) cue.gradientColors = strVal;
    if (getString(doc, "blendMode", strVal)) cue.blendMode = strVal;

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Add light cue");
    s.lightCues.push_back(std::move(cue));
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
    setStatus("Light cue added");
}

void MainComponent::lightingCueRemove(const std::string& json) {
    simdjson::dom::element doc;
    int songIndex = -1;
    std::string cueId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "cueId", cueId)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    auto it = std::remove_if(s.lightCues.begin(), s.lightCues.end(),
                              [&](const LightCue& c) { return c.id == cueId; });
    if (it != s.lightCues.end()) {
        std::string gestureId;
        getString(doc, "gestureId", gestureId);
        engine.projectHistoryBeginEdit(gestureId, "Remove light cue");
        s.lightCues.erase(it, s.lightCues.end());
        engine.projectHistoryCommitEdit();
        notifyProjectStructureChanged();
        engine.notifyLightEngineProjectChanged();
        setStatus("Light cue removed");
    }
}

void MainComponent::lightingCueUpdate(const std::string& json) {
    simdjson::dom::element doc;
    int songIndex = -1;
    std::string cueId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "cueId", cueId)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    LightCue* cue = nullptr;
    for (auto& c : s.lightCues) {
        if (c.id == cueId) {
            cue = &c;
            break;
        }
    }
    if (cue == nullptr)
        return;

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Edit light cue");

    double numVal;
    int intVal;
    std::string strVal;
    if (getDouble(doc, "startSeconds", numVal)) cue->startSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "durationSeconds", numVal)) cue->durationSeconds = std::max(0.1, numVal);
    if (getInt(doc, "colorR", intVal)) cue->colorR = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "colorG", intVal)) cue->colorG = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "colorB", intVal)) cue->colorB = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getDouble(doc, "intensity", numVal)) cue->intensity = std::clamp(numVal, 0.0, 1.0);
    if (getDouble(doc, "fadeInSeconds", numVal)) cue->fadeInSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "fadeOutSeconds", numVal)) cue->fadeOutSeconds = std::max(0.0, numVal);
    if (getString(doc, "label", strVal)) cue->label = strVal;

    // Audio-reactive effect fields.
    if (getString(doc, "effectType", strVal)) cue->effectType = strVal;
    if (getString(doc, "effectSourceType", strVal)) cue->effectSourceType = strVal;
    if (getString(doc, "effectSourceId", strVal)) cue->effectSourceId = strVal;
    if (getDouble(doc, "effectIntensity", numVal))
        cue->effectIntensity = static_cast<float>(std::clamp(numVal, 0.0, 1.0));
    bool boolVal = false;
    if (getBool(doc, "tempoSync", boolVal)) cue->tempoSync = boolVal;
    if (getString(doc, "tempoSubdiv", strVal)) cue->tempoSubdiv = strVal;
    if (getDouble(doc, "effectRateHz", numVal))
        cue->effectRateHz = static_cast<float>(std::max(0.01, numVal));
    if (getString(doc, "gradientPreset", strVal)) cue->gradientPreset = strVal;
    if (getString(doc, "gradientColors", strVal)) cue->gradientColors = strVal;
    if (getString(doc, "blendMode", strVal)) cue->blendMode = strVal;

    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();

    // Push an updated snapshot to LightEngine so changes take effect on the
    // next DMX frame without waiting for a project reload.
    engine.notifyLightEngineProjectChanged();
}

} // namespace resostage
