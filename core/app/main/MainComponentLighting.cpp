// Lighting web parity for the settings-card rig config, the 3D fixture
// placement editor, and the Editor's Light-mode timeline. Mirrors
// MainComponentBuilder.cpp's approach (JSON-driven, same Project mutations
// a native UI would make, same history wrapping) -- see RESTORE_POINT.md
// Feature 6 for the overall design.

#include "MainComponent.h"
#include "project/Uuid.h"
#include "server/BuilderJson.h"

#include <algorithm>

namespace resostage {

using namespace builder_json;

namespace {

// Keeps the ResoLightBar subset of `cfg.fixtures` in sync with
// resoLightColumns x resoLightRows: grows/shrinks the tail, leaving every
// existing bar's id/position/LED count untouched, and never touches
// DmxGeneric entries. Idempotent -- calling it again with the same
// columns/rows is a no-op copy.
void regenerateResoLightFixtures(LightingConfig& cfg) {
    const int desired = std::max(0, cfg.resoLight.columns) * std::max(0, cfg.resoLight.rows);

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
            const int col = cfg.resoLight.columns > 0 ? index % cfg.resoLight.columns : 0;
            const int row = cfg.resoLight.columns > 0 ? index / cfg.resoLight.columns : 0;
            LightFixture f;
            f.id = makeUniqueId("bar", used);
            used.push_back(f.id);
            f.name = "Bar " + std::to_string(index + 1);
            f.kind = LightFixture::Kind::ResoLightBar;
            f.grid.column = col;
            f.grid.row = row;
            f.ledCount = 120;
            f.addressable = true;
            // Center the grid around X=0 so two bars land at -1.0 and +1.0
            // instead of 0 and 2.0 -- the 3D preview then feels balanced,
            // with the audience/camera anchor at the center of the rig.
            const double halfWidthX = (cfg.resoLight.columns > 1 ? (cfg.resoLight.columns - 1) * 0.5 * kSpacingMeters : 0.0);
            const double halfWidthZ = (cfg.resoLight.rows > 1    ? (cfg.resoLight.rows    - 1) * 0.5 * kSpacingMeters : 0.0);
            f.position.x = col * kSpacingMeters - halfWidthX;
            f.position.y = 0.0;
            f.position.z = row * kSpacingMeters - halfWidthZ;
            // RGBW is the default for new ResoLight bars: the dedicated white
            // channel gives richer whites than mixing R+G+B to near-white,
            // which is exactly what a stage light is asked to do most often.
            f.channelProfile = "rgbw";
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
    glz::generic doc;
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
        cfg.resoLight.columns = std::max(0, intVal);
    if (getInt(doc, "resoLightRows", intVal))
        cfg.resoLight.rows = std::max(0, intVal);
    double doubleVal;
    if (getString(doc, "idleBehavior", strVal)) {
        if (strVal == "blackout" || strVal == "staticColor" || strVal == "effect" || strVal == "holdLast")
            cfg.idle.behavior = strVal;
    }
    if (getString(doc, "idleEffectType", strVal)) {
        // Validate against the same catalog buildIdleEffectOutputs will use
        // (parseEffectType returns Type::None for unknown strings, which is
        // the "off" value -- so reject anything that doesn't parse rather
        // than silently turning the effect off).
        if (parseEffectType(strVal) != EffectParams::Type::None)
            cfg.idle.effect.type = strVal;
    }
    if (getDouble(doc, "idleEffectRateHz", doubleVal))
        cfg.idle.effect.rateHz = std::clamp(doubleVal, 0.05, 30.0);
    if (getString(doc, "idleGradientPreset", strVal)) {
        // Accept any value the frontend sends -- parseGradientPreset handles
        // unknown strings by falling back to Solid, so there's no invalid state.
        cfg.idle.gradient.preset = strVal;
    }
    if (getString(doc, "idleGradientColors", strVal))
        cfg.idle.gradient.colors = strVal;
    if (getInt(doc, "idleColorR", intVal))
        cfg.idle.color.r = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "idleColorG", intVal))
        cfg.idle.color.g = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "idleColorB", intVal))
        cfg.idle.color.b = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getDouble(doc, "idleIntensity", doubleVal))
        cfg.idle.intensity = std::clamp(doubleVal, 0.0, 1.0);
    if (getDouble(doc, "defaultRefreshRateHz", doubleVal))
        // Upper-bounded at LightEngine's internal compute tick (60Hz, see
        // LightEngine.h's kFrameRateHz) -- a configured rate faster than
        // that would just silently get capped at the tick rate anyway.
        cfg.defaultRefreshRateHz = std::clamp(doubleVal, 1.0, 60.0);
    // "" is a valid, meaningful value here (broadcast -- see the field's
    // doc comment in ProjectSchema.h), not "leave unset".
    if (getString(doc, "artNetTargetHost", strVal))
        cfg.artNetTargetHost = strVal;

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
    glz::generic doc;
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
    f.tiltDegrees = 25.0;

    // Auto-place right after the last occupied channel range in universe 0
    // so a freshly added fixture never silently overlaps an existing one's
    // DMX channels -- the user can still repoint it to a different
    // universe/range by hand afterward.
    int nextChannel = 1;
    for (const auto& other : cfg.fixtures) {
        if (other.dmx.universe == 0)
            nextChannel = std::max(nextChannel, other.dmx.startChannel + other.dmx.channelCount);
    }
    f.dmx.universe = 0;
    f.dmx.startChannel = std::min(nextChannel, 510);
    f.dmx.channelCount = 3;

    // Off to the side in the 3D stage, one step back per existing fixture,
    // so it never spawns on top of a ResoLight bar grid or another DMX
    // fixture -- same "just a starting point, drag it where it belongs"
    // spirit as regenerateResoLightFixtures' default spacing.
    f.position.x = 0.0;
    f.position.y = 0.0;
    f.position.z = static_cast<double>(cfg.fixtures.size()) * -2.0;

    engine.projectHistoryBeginEdit("", "Add DMX fixture");
    cfg.fixtures.push_back(std::move(f));
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
    setStatus("DMX fixture added");
}

void MainComponent::lightingFixtureDuplicate(const std::string& json) {
    glz::generic doc;
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
    // Hardware is 1:1 with a physical board -- never let a duplicate steal
    // the source's IP. Operator re-pairs the copy if they want one.
    copy.networkHost.reset();

    // Auto-place right after the last occupied channel range in the SAME
    // universe as the source -- same collision-avoidance lightingFixtureAdd
    // uses, since a byte-for-byte copy would otherwise leave both fixtures
    // pointing at identical DMX channels.
    int nextChannel = 1;
    for (const auto& other : cfg.fixtures) {
        if (other.dmx.universe == src->dmx.universe)
            nextChannel = std::max(nextChannel, other.dmx.startChannel + other.dmx.channelCount);
    }
    copy.dmx.startChannel = std::min(nextChannel, 510);

    // Nudged in the 3D stage so the copy doesn't spawn exactly on top of
    // the fixture it came from.
    copy.position.x = src->position.x + 0.5;
    copy.position.z = src->position.z + 0.5;

    engine.projectHistoryBeginEdit("", "Duplicate fixture");
    cfg.fixtures.push_back(std::move(copy));
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
    setStatus("Fixture duplicated");
}

void MainComponent::lightingFixtureRemove(const std::string& json) {
    glz::generic doc;
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
    glz::generic doc;
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

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    if (gestureId.empty() && fx != nullptr) {
        gestureId = "fx_" + fx->id;
    }
    engine.projectHistoryBeginEdit(gestureId, "Edit fixture");

    std::string strVal;
    double numVal;
    bool boolVal;
    int intVal;
    if (getString(doc, "name", strVal)) fx->name = strVal;
    if (getInt(doc, "ledCount", intVal)) fx->ledCount = std::max(1, intVal);
    if (getBool(doc, "addressable", boolVal)) fx->addressable = boolVal;
    if (getInt(doc, "gridColumn", intVal)) fx->grid.column = std::max(0, intVal);
    if (getInt(doc, "gridRow", intVal)) fx->grid.row = std::max(0, intVal);
    if (getDouble(doc, "posX", numVal)) fx->position.x = numVal;
    if (getDouble(doc, "posY", numVal)) fx->position.y = numVal;
    if (getDouble(doc, "posZ", numVal)) fx->position.z = numVal;
    if (getDouble(doc, "rotationYDeg", numVal)) fx->rotation.y = numVal;
    if (getBool(doc, "mountedHorizontally", boolVal)) fx->mountedHorizontally = boolVal;
    if (getInt(doc, "dmxUniverse", intVal)) fx->dmx.universe = intVal;
    if (getInt(doc, "dmxStartChannel", intVal)) fx->dmx.startChannel = intVal;
    if (getInt(doc, "dmxChannelCount", intVal)) fx->dmx.channelCount = intVal;
    // Cosmetic-only strings (see LightFixture's doc comment) -- the engine
    // never branches on either, so no allowlist to keep in sync here; the
    // web UI owns the canonical set of known values.
    if (getString(doc, "shape", strVal)) fx->shape = strVal;
    // A Ring is always uniform-color (no per-pixel control) -- enforced
    // here too, not just by the web UI hiding the checkbox, so a direct
    // API call or a hand-edited project file can't leave a Ring fixture
    // stuck addressable.
    if (fx->shape == "ring") fx->addressable = false;
    if (getInt(doc, "matrixCols", intVal)) fx->matrixColumns = std::max(0, intVal);
    if (getString(doc, "channelProfile", strVal)) fx->channelProfile = strVal;
    if (getDouble(doc, "tiltDeg", numVal)) fx->tiltDegrees = numVal;
    // 0 = inherit the project default; otherwise clamp to LightEngine's
    // internal tick rate (60Hz, see LightEngine.h's kFrameRateHz) at the
    // top -- a deliberately slow override for a glitchy fixture is exactly
    // the point, so the low end stays wide open.
    if (getDouble(doc, "refreshRateHz", numVal))
        fx->refreshRateHz = numVal <= 0.0 ? 0.0 : std::clamp(numVal, 1.0, 60.0);
    // "" is the valid, meaningful "no hardware attached, preview only"
    // value -- see LightFixture::networkHost's doc comment. Port is not
    // user-configurable: both sides always use resolight::kDefaultBoardPort.
    if (getString(doc, "networkHost", strVal))
        fx->networkHost = strVal;

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
    glz::generic doc;
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
    glz::generic doc;
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
    glz::generic doc;
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

    if (const auto* fxIdsArr = getArray(doc, "fixtureIds")) {
        lt.fixtureIds.clear();
        for (const auto& idEl : *fxIdsArr) {
            std::string v;
            if (asString(idEl, v))
                lt.fixtureIds.push_back(std::move(v));
        }
    }

    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    engine.notifyLightEngineProjectChanged();
}

void MainComponent::lightingCueAdd(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string trackId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "trackId", trackId)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    LightCue cue;
    cue.id = generateUuidV7();
    cue.trackId = trackId;
    double startSeconds = 0.0;
    getDouble(doc, "startSeconds", startSeconds);
    cue.startSeconds = std::max(0.0, startSeconds);
    double durationSeconds = 2.0;
    getDouble(doc, "durationSeconds", durationSeconds);
    cue.durationSeconds = std::max(0.1, durationSeconds);

    int intVal = 0;
    if (getInt(doc, "colorR", intVal)) cue.color.r = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "colorG", intVal)) cue.color.g = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "colorB", intVal)) cue.color.b = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    double numVal = 0.0;
    if (getDouble(doc, "intensity", numVal)) cue.intensity = std::clamp(numVal, 0.0, 1.0);
    if (getDouble(doc, "fadeInSeconds", numVal)) cue.fade.inSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "fadeOutSeconds", numVal)) cue.fade.outSeconds = std::max(0.0, numVal);
    std::string strVal;
    if (getString(doc, "label", strVal)) cue.label = strVal;
    if (getString(doc, "effectType", strVal)) cue.effect.type = strVal;
    if (getString(doc, "effectSourceType", strVal)) cue.effect.sourceType = strVal;
    if (getString(doc, "effectSourceId", strVal)) cue.effect.sourceId = strVal;
    if (getDouble(doc, "effectIntensity", numVal)) cue.effect.intensity = static_cast<float>(std::clamp(numVal, 0.0, 1.0));
    bool boolVal = false;
    if (getBool(doc, "tempoSync", boolVal)) cue.effect.tempoSync = boolVal;
    if (getString(doc, "tempoSubdiv", strVal)) cue.effect.tempoSubdivision = strVal;
    if (getDouble(doc, "effectRateHz", numVal)) cue.effect.rateHz = static_cast<float>(std::max(0.01, numVal));
    if (getString(doc, "gradientPreset", strVal)) cue.gradient.preset = strVal;
    if (getString(doc, "gradientColors", strVal)) cue.gradient.colors = strVal;
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
    glz::generic doc;
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
    glz::generic doc;
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
    if (getString(doc, "trackId", strVal)) cue->trackId = strVal;
    if (getDouble(doc, "startSeconds", numVal)) cue->startSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "durationSeconds", numVal)) cue->durationSeconds = std::max(0.1, numVal);
    if (getInt(doc, "colorR", intVal)) cue->color.r = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "colorG", intVal)) cue->color.g = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getInt(doc, "colorB", intVal)) cue->color.b = static_cast<uint8_t>(std::clamp(intVal, 0, 255));
    if (getDouble(doc, "intensity", numVal)) cue->intensity = std::clamp(numVal, 0.0, 1.0);
    if (getDouble(doc, "fadeInSeconds", numVal)) cue->fade.inSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "fadeOutSeconds", numVal)) cue->fade.outSeconds = std::max(0.0, numVal);
    if (getString(doc, "label", strVal)) cue->label = strVal;

    // Audio-reactive effect fields.
    if (getString(doc, "effectType", strVal)) cue->effect.type = strVal;
    if (getString(doc, "effectSourceType", strVal)) cue->effect.sourceType = strVal;
    if (getString(doc, "effectSourceId", strVal)) cue->effect.sourceId = strVal;
    if (getDouble(doc, "effectIntensity", numVal))
        cue->effect.intensity = static_cast<float>(std::clamp(numVal, 0.0, 1.0));
    bool boolVal = false;
    if (getBool(doc, "tempoSync", boolVal)) cue->effect.tempoSync = boolVal;
    if (getString(doc, "tempoSubdiv", strVal)) cue->effect.tempoSubdivision = strVal;
    if (getDouble(doc, "effectRateHz", numVal))
        cue->effect.rateHz = static_cast<float>(std::max(0.01, numVal));
    if (getString(doc, "gradientPreset", strVal)) cue->gradient.preset = strVal;
    if (getString(doc, "gradientColors", strVal)) cue->gradient.colors = strVal;
    if (getString(doc, "blendMode", strVal)) cue->blendMode = strVal;

    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();

    // Push an updated snapshot to LightEngine so changes take effect on the
    // next DMX frame without waiting for a project reload.
    engine.notifyLightEngineProjectChanged();
}

} // namespace resostage
