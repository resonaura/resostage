// See LegacyProjectMigration.h for the "delete this wholesale" rationale.
#include "LegacyProjectMigration.h"
#include "ProjectJson.h"
#include "Uuid.h"

#include "glaze/glaze.hpp"

#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <vector>

namespace resostage {

namespace legacy_wire {

// Mirrors the OLD (pre-v2) project.json shape exactly -- do not "clean up"
// field names here, this must keep parsing real old files forever (for as
// long as this file exists at all).

struct WSend {
    std::string bus;
    double gainDb = 0.0;
    bool preFader = false;
    bool enabled = true;
};

struct WBusOutput {
    int startChannel = 0;
};

struct WBus {
    std::string id;
    std::string name;
    int channels = 2;
    WBusOutput output;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    bool isAux = false;
};

struct WTrack {
    std::string id;
    std::string name;
    std::string bus;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    bool mono = false;
    std::vector<WSend> sends;
};

struct WFixture {
    std::string id;
    std::string name;
    std::string kind;
    int gridColumn = 0;
    int gridRow = 0;
    int ledCount = 0;
    bool addressable = false;
    double posX = 0.0;
    double posY = 0.0;
    double posZ = 0.0;
    double rotationYDeg = 0.0;
    bool mountedHorizontally = false;
    int dmxUniverse = 0;
    int dmxStartChannel = 0;
    int dmxChannelCount = 0;
    std::string shape;
    int matrixCols = 0;
    std::string channelProfile;
    double tiltDeg = 0.0;
    double refreshRateHz = 0.0;
    std::string networkHost;
};

struct WLighting {
    bool enabled = false;
    std::string kind;
    int resoLightColumns = 0;
    int resoLightRows = 0;
    std::string idleBehavior;
    int idleColorR = 0;
    int idleColorG = 0;
    int idleColorB = 0;
    double idleIntensity = 1.0;
    std::string idleEffectType;
    double idleEffectRateHz = 2.0;
    std::string idleGradientPreset;
    std::string idleGradientColors;
    double defaultRefreshRateHz = 0.0;
    std::string artNetTargetHost;
    std::vector<WFixture> fixtures;
};

struct WLightTrack {
    std::string id;
    std::string name;
    std::vector<std::string> fixtureIds;
};

struct WTimeSig {
    int numerator = 4;
    int denominator = 4;
};

struct WRegion {
    std::string id;
    std::string trackId;
    std::string file;
    double startSeconds = 0.0;
    double sourceOffsetSeconds = 0.0;
    double durationSeconds = 0.0;
    double gainDb = 0.0;
    double fadeInSeconds = 0.0;
    double fadeOutSeconds = 0.0;
    double fadeInCurve = 0.0;
    double fadeOutCurve = 0.0;
    bool loop = false;
    double loopLengthSeconds = 0.0;
};

struct WEvent {
    std::string id;
    std::string type;
    double timeSeconds = 0.0;
    bool triggerOnLoad = false;
    double latencyCompensationMs = 0.0;
    int midiChannel = 1;
    int midiNote = 60;
    int midiVelocity = 100;
    int midiCC = 0;
    int midiCCValue = 0;
    int midiProgram = 0;
    std::string httpUrl;
    std::string httpMethod;
    std::string httpBody;
    int dmxUniverse = 0;
    std::vector<int> dmxData;
};

struct WSection {
    std::string id;
    std::string name;
    double startSeconds = 0.0;
    int colorIndex = 0;
};

struct WLightCue {
    std::string id;
    std::string trackId;
    double startSeconds = 0.0;
    double durationSeconds = 1.0;
    int colorR = 255;
    int colorG = 255;
    int colorB = 255;
    double intensity = 1.0;
    double fadeInSeconds = 0.0;
    double fadeOutSeconds = 0.0;
    std::string label;
    std::string effectType;
    std::string effectSourceType;
    std::string effectSourceId;
    double effectIntensity = 0.8;
    bool tempoSync = false;
    std::string tempoSubdiv;
    double effectRateHz = 2.0;
    std::string gradientPreset;
    std::string gradientColors;
    std::string blendMode;
};

struct WSong {
    std::string id;
    std::string name;
    double bpm = 120.0;
    WTimeSig timeSignature;
    std::string playbackMode;
    std::vector<WRegion> regions;
    std::vector<WEvent> events;
    std::vector<WSection> sections;
    std::vector<WLightCue> lightCues;
};

struct WCycle {
    bool active = false;
    bool skip = false;
    double leftSec = 0.0;
    double rightSec = 4.0;
    int songIndex = -1;
};

struct WMidiMapping {
    std::string action;
    int channel = 0;
    std::string triggerType;
    int number = 0;
};

struct WProject {
    int formatVersion = 1;
    std::string name;
    double sampleRate = 48000.0;
    bool builtInClickEnabled = false;
    std::string builtInClickName = "Click";
    std::string builtInClickBusId;
    double builtInClickGainDb = 0.0;
    double builtInClickPan = 0.0;
    bool builtInClickMono = false;
    bool builtInClickSolo = false;
    std::vector<WSend> builtInClickSends;
    std::vector<WBus> busses;
    std::vector<WTrack> tracks;
    WLighting lighting;
    std::vector<WLightTrack> lightTracks;
    std::vector<WSong> songs;
    WCycle cycle;
    std::vector<WMidiMapping> midiMappings;
    // keybindings intentionally not mirrored: dropped by the new schema.
};

} // namespace legacy_wire

namespace {

using namespace legacy_wire;

double finiteOrZero(double v) { return std::isfinite(v) ? v : 0.0; }

// dB -> 0-100% linear send level (100% = unity / 0 dB). Boost past unity is
// no longer expressible through a send (only via the source's own gainDb),
// so a legacy send above 0 dB clamps down to 100% -- a deliberate, approved
// lossy step (see the "Send level curve" decision in the routing rewrite
// plan), not a bug.
double dbToLevelPercent(double db) {
    if (!std::isfinite(db))
        return 0.0;
    const double gain = std::pow(10.0, db / 20.0);
    return std::clamp(gain * 100.0, 0.0, 100.0);
}

// "direct:5" -> "audio::out:5"; passes compound ids through token-by-token
// ("direct:1,direct:2" -> "audio::out:1,audio::out:2"). Numbering is
// unchanged (both schemes are 1-based physical channel indices).
std::string renameDirectToken(const std::string& id) {
    std::string out;
    size_t pos = 0;
    while (pos <= id.size()) {
        const size_t end = id.find(',', pos);
        std::string tok = id.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
        pos = (end == std::string::npos) ? id.size() + 1 : end + 1;
        if (tok.rfind("direct:", 0) == 0) {
            if (!out.empty()) out += ',';
            out += "audio::out:" + tok.substr(7);
        } else if (!tok.empty()) {
            if (!out.empty()) out += ',';
            out += tok; // already-new-style or unrecognized: pass through
        }
        if (end == std::string::npos) break;
    }
    return out;
}

// Classification of every legacy bus id, built once per migration.
struct BusRemap {
    // Legacy "Out N[/M]" fabricated busses (isAux == false, name prefix
    // "Out ", id != "main"): migrate to a raw ext-out target string, not a
    // persisted bus at all -- this subsumes the old reparseProject() Ext-out
    // heuristic.
    std::map<std::string, std::string> directTarget;
    // Aux busses (isAux == true): migrate to a new SendBus with a
    // sequential "audio::send:N" id.
    std::map<std::string, std::string> auxNewId;
    // Rare edge case: a non-aux, non-main, NOT "Out "-prefixed bus (a
    // genuine second FOH-like bus from a very old project). The new schema
    // only supports one master (`main`), so this is folded into `sends` as
    // a best-effort SendBus too rather than silently dropped.
    std::map<std::string, std::string> strayNewId;
};

SourceOutput migrateSourceOutput(const std::string& legacyBusId,
                                  const std::vector<WSend>& legacySends,
                                  const BusRemap& remap) {
    SourceOutput out;
    out.sends.reserve(legacySends.size());
    for (const auto& s : legacySends) {
        SendConfig sc;
        // A send's target is always an aux/stray bus (never "main" or a raw
        // direct id in the old model).
        if (auto it = remap.auxNewId.find(s.bus); it != remap.auxNewId.end())
            sc.bus = it->second;
        else if (auto it2 = remap.strayNewId.find(s.bus); it2 != remap.strayNewId.end())
            sc.bus = it2->second;
        else
            continue; // dangling reference: drop rather than guess
        sc.level = dbToLevelPercent(s.gainDb);
        sc.preFader = s.preFader;
        sc.enabled = s.enabled;
        out.sends.push_back(std::move(sc));
    }

    if (legacyBusId.empty()) {
        out.type = OutputType::SendsOnly;
        return out;
    }
    if (legacyBusId == "main") {
        out.type = OutputType::Main;
        return out;
    }
    if (legacyBusId.rfind("direct:", 0) == 0 || legacyBusId.find(",direct:") != std::string::npos) {
        out.type = OutputType::ExtOut;
        out.target = renameDirectToken(legacyBusId);
        return out;
    }
    if (auto it = remap.directTarget.find(legacyBusId); it != remap.directTarget.end()) {
        out.type = OutputType::ExtOut;
        out.target = it->second;
        return out;
    }
    // Edge case: main route pointed directly at an aux/stray bus id (the UI
    // never produced this, but nothing in the old schema forbade it). The
    // new track output model has no "route main into an arbitrary bus"
    // variant, so approximate as a 100%-level send into that bus instead of
    // dropping the connection.
    std::string target;
    if (auto it = remap.auxNewId.find(legacyBusId); it != remap.auxNewId.end())
        target = it->second;
    else if (auto it2 = remap.strayNewId.find(legacyBusId); it2 != remap.strayNewId.end())
        target = it2->second;
    if (!target.empty()) {
        SendConfig sc;
        sc.bus = target;
        sc.level = 100.0;
        out.sends.push_back(std::move(sc));
    }
    out.type = OutputType::SendsOnly;
    return out;
}

EventType eventTypeFromString(const std::string& s) {
    if (s == "midiNoteOn") return EventType::MidiNoteOn;
    if (s == "midiNoteOff") return EventType::MidiNoteOff;
    if (s == "midiCC") return EventType::MidiCC;
    if (s == "http") return EventType::Http;
    if (s == "dmx") return EventType::Dmx;
    return EventType::MidiProgramChange;
}

LightingKind lightingKindFromString(const std::string& s) {
    if (s == "resoLight") return LightingKind::ResoLight;
    if (s == "dmxGeneric") return LightingKind::DmxGeneric;
    return LightingKind::None;
}

LightFixture::Kind fixtureKindFromString(const std::string& s) {
    if (s == "dmxGeneric") return LightFixture::Kind::DmxGeneric;
    return LightFixture::Kind::ResoLightBar;
}

} // namespace

bool migrateLegacyProject(std::string_view rawJson, Project& out, std::string& error) {
    legacy_wire::WProject w{};
    constexpr glz::opts opts{
        .error_on_unknown_keys = false,
        .error_on_missing_keys = false,
    };
    const auto ec = glz::read<opts>(w, rawJson);
    if (ec) {
        error = std::string("legacy project.json parse error: ") + glz::format_error(ec, rawJson);
        return false;
    }

    Project p;
    p.format.version = kCurrentFormatVersion;
    p.name = w.name;
    p.sampleRate = finiteOrZero(w.sampleRate);

    // ---- Classify busses (see BusRemap) ----
    // Aux busses and "stray" (non-aux, non-main, non-fabricated) busses both
    // migrate to SendBus entries and share one "audio::send:N" counter so
    // the result is contiguously numbered regardless of which bucket a bus
    // fell into.
    BusRemap remap;
    int sendCounter = 1;
    for (const auto& b : w.busses) {
        if (b.id == "main")
            continue;
        if (!b.isAux && b.name.rfind("Out ", 0) == 0) {
            remap.directTarget[b.id] = extOutTarget(b.output.startChannel, b.channels);
            continue;
        }
        const std::string newId = "audio::send:" + std::to_string(sendCounter++);
        if (b.isAux)
            remap.auxNewId[b.id] = newId;
        else
            remap.strayNewId[b.id] = newId;
    }

    // ---- Master ----
    p.main.enabled = true;
    p.main.name = "Main";
    p.main.output.type = OutputType::ExtOut;
    for (const auto& b : w.busses) {
        if (b.id != "main")
            continue;
        p.main.name = b.name.empty() ? "Main" : b.name;
        p.main.channels = std::clamp(b.channels, 1, 2);
        p.main.gainDb = b.gainDb;
        p.main.pan = std::clamp(b.pan, -1.0, 1.0);
        p.main.mute = b.mute;
        p.main.solo = b.solo;
        p.main.output.target = extOutTarget(b.output.startChannel, b.channels);
        break;
    }
    if (!p.main.output.target.has_value())
        p.main.output.target = "audio::out:1,audio::out:2"; // no "main" bus at all: fall back to the new-project default

    // ---- Send busses (aux + stray, in the same order/numbering as remap) ----
    for (const auto& b : w.busses) {
        if (b.id == "main")
            continue;
        std::string newId;
        if (auto it = remap.auxNewId.find(b.id); it != remap.auxNewId.end())
            newId = it->second;
        else if (auto it2 = remap.strayNewId.find(b.id); it2 != remap.strayNewId.end())
            newId = it2->second;
        else
            continue; // folded into a direct ext-out target, not a persisted bus

        SendBus sb;
        sb.id = newId;
        sb.name = b.name;
        sb.channels = std::clamp(b.channels, 1, 2);
        sb.gainDb = b.gainDb;
        sb.pan = std::clamp(b.pan, -1.0, 1.0);
        sb.mute = b.mute;
        sb.solo = b.solo;
        sb.output.type = OutputType::ExtOut;
        sb.output.target = extOutTarget(b.output.startChannel, b.channels);
        p.sends.push_back(std::move(sb));
    }
    // (p.sends is already in the same order the "audio::send:N" ids were
    // assigned in, since both loops walk w.busses in the same order.)

    // ---- Tracks ----
    std::map<std::string, std::string> trackIdMap; // old id -> new id
    int trackCounter = 1;
    for (const auto& t : w.tracks)
        trackIdMap[t.id] = "audio::track:" + std::to_string(trackCounter++);

    p.tracks.reserve(w.tracks.size());
    for (const auto& t : w.tracks) {
        TrackDef tr;
        tr.id = trackIdMap[t.id];
        tr.name = t.name;
        tr.channels = t.mono ? 1 : 2;
        tr.gainDb = t.gainDb;
        tr.pan = t.pan;
        tr.mute = t.mute;
        tr.solo = t.solo;
        tr.output = migrateSourceOutput(t.bus, t.sends, remap);
        p.tracks.push_back(std::move(tr));
    }

    // ---- Click ----
    p.click.enabled = w.builtInClickEnabled;
    p.click.name = w.builtInClickName.empty() ? "Click" : w.builtInClickName;
    p.click.channels = w.builtInClickMono ? 1 : 2;
    p.click.gainDb = w.builtInClickGainDb;
    p.click.pan = std::clamp(w.builtInClickPan, -1.0, 1.0);
    p.click.mute = false;
    p.click.solo = w.builtInClickSolo;
    p.click.output = migrateSourceOutput(w.builtInClickBusId, w.builtInClickSends, remap);
    // Click has no persisted ExtOut equivalent in the old OR new schema
    // (the metronome was never routable to its own physical pair) --
    // collapse an (unreachable in practice) ExtOut result to SendsOnly.
    if (p.click.output.type == OutputType::ExtOut) {
        p.click.output.type = OutputType::SendsOnly;
        p.click.output.target.reset();
    }

    // ---- Lighting ----
    p.lighting.enabled = w.lighting.enabled;
    p.lighting.kind = lightingKindFromString(w.lighting.kind);
    p.lighting.resoLight.columns = w.lighting.resoLightColumns;
    p.lighting.resoLight.rows = w.lighting.resoLightRows;
    p.lighting.idle.behavior = w.lighting.idleBehavior.empty() ? "holdLast" : w.lighting.idleBehavior;
    p.lighting.idle.color.r = static_cast<uint8_t>(std::clamp(w.lighting.idleColorR, 0, 255));
    p.lighting.idle.color.g = static_cast<uint8_t>(std::clamp(w.lighting.idleColorG, 0, 255));
    p.lighting.idle.color.b = static_cast<uint8_t>(std::clamp(w.lighting.idleColorB, 0, 255));
    p.lighting.idle.intensity = w.lighting.idleIntensity;
    p.lighting.idle.effect.type = w.lighting.idleEffectType.empty() ? "none" : w.lighting.idleEffectType;
    p.lighting.idle.effect.rateHz = w.lighting.idleEffectRateHz;
    p.lighting.idle.gradient.preset = w.lighting.idleGradientPreset.empty() ? "solid" : w.lighting.idleGradientPreset;
    if (!w.lighting.idleGradientColors.empty())
        p.lighting.idle.gradient.colors = w.lighting.idleGradientColors;
    p.lighting.defaultRefreshRateHz = w.lighting.defaultRefreshRateHz;
    if (!w.lighting.artNetTargetHost.empty())
        p.lighting.artNetTargetHost = w.lighting.artNetTargetHost;

    std::map<std::string, std::string> fixtureIdMap;
    int fixtureCounter = 1;
    for (const auto& f : w.lighting.fixtures)
        fixtureIdMap[f.id] = "light::bar:" + std::to_string(fixtureCounter++);

    p.lighting.fixtures.reserve(w.lighting.fixtures.size());
    for (const auto& f : w.lighting.fixtures) {
        LightFixture fx;
        fx.id = fixtureIdMap[f.id];
        fx.name = f.name;
        fx.kind = fixtureKindFromString(f.kind);
        fx.grid.column = f.gridColumn;
        fx.grid.row = f.gridRow;
        fx.ledCount = f.ledCount;
        fx.addressable = f.addressable;
        fx.position.x = f.posX;
        fx.position.y = f.posY;
        fx.position.z = f.posZ;
        fx.rotation.y = f.rotationYDeg;
        fx.mountedHorizontally = f.mountedHorizontally;
        fx.dmx.universe = f.dmxUniverse;
        fx.dmx.startChannel = f.dmxStartChannel;
        fx.dmx.channelCount = f.dmxChannelCount;
        fx.shape = f.shape.empty() ? "bar" : f.shape;
        fx.matrixColumns = f.matrixCols;
        fx.channelProfile = f.channelProfile.empty() ? "rgb" : f.channelProfile;
        fx.tiltDegrees = f.tiltDeg;
        fx.refreshRateHz = f.refreshRateHz;
        if (!f.networkHost.empty())
            fx.networkHost = f.networkHost;
        p.lighting.fixtures.push_back(std::move(fx));
    }

    std::map<std::string, std::string> lightTrackIdMap;
    int lightTrackCounter = 1;
    for (const auto& lt : w.lightTracks)
        lightTrackIdMap[lt.id] = "light::track:" + std::to_string(lightTrackCounter++);

    p.lightTracks.reserve(w.lightTracks.size());
    for (const auto& lt : w.lightTracks) {
        LightTrack nt;
        nt.id = lightTrackIdMap[lt.id];
        nt.name = lt.name;
        nt.fixtureIds.reserve(lt.fixtureIds.size());
        for (const auto& fid : lt.fixtureIds) {
            if (auto it = fixtureIdMap.find(fid); it != fixtureIdMap.end())
                nt.fixtureIds.push_back(it->second);
        }
        p.lightTracks.push_back(std::move(nt));
    }

    // ---- Songs ----
    p.songs.reserve(w.songs.size());
    int songCounter = 1;
    for (const auto& s : w.songs) {
        SongDef song;
        song.id = "meta::song:" + std::to_string(songCounter++);
        song.name = s.name;
        song.bpm = s.bpm;
        song.timeSignature.numerator = s.timeSignature.numerator;
        song.timeSignature.denominator = s.timeSignature.denominator;
        song.playbackMode = (s.playbackMode == "autoplayNext")
                                ? PlaybackMode::AutoplayNext
                                : PlaybackMode::WaitForTrigger;

        for (const auto& r : s.regions) {
            if (r.file.empty())
                continue;
            Region reg;
            reg.id = generateUuidV7();
            reg.trackId = trackIdMap.count(r.trackId) ? trackIdMap[r.trackId] : r.trackId;
            reg.startSeconds = r.startSeconds;
            reg.durationSeconds = r.durationSeconds;
            reg.gainDb = r.gainDb;
            reg.source.file = r.file;
            reg.source.offsetSeconds = r.sourceOffsetSeconds;
            reg.fade.inSeconds = r.fadeInSeconds;
            reg.fade.outSeconds = r.fadeOutSeconds;
            reg.fade.inCurve = r.fadeInCurve;
            reg.fade.outCurve = r.fadeOutCurve;
            reg.loop.enabled = r.loop;
            reg.loop.lengthSeconds = r.loopLengthSeconds;
            song.regions.push_back(std::move(reg));
        }

        for (const auto& e : s.events) {
            TimelineEvent ev;
            ev.id = generateUuidV7();
            ev.type = eventTypeFromString(e.type);
            ev.timeSeconds = e.timeSeconds;
            ev.triggerOnLoad = e.triggerOnLoad;
            ev.latencyCompensationMs = e.latencyCompensationMs;
            ev.midiChannel = e.midiChannel;
            ev.midiNote = e.midiNote;
            ev.midiVelocity = e.midiVelocity;
            ev.midiCC = e.midiCC;
            ev.midiCCValue = e.midiCCValue;
            ev.midiProgram = e.midiProgram;
            if (!e.httpUrl.empty()) ev.httpUrl = e.httpUrl;
            ev.httpMethod = e.httpMethod.empty() ? "POST" : e.httpMethod;
            if (!e.httpBody.empty()) ev.httpBody = e.httpBody;
            ev.dmxUniverse = e.dmxUniverse;
            for (int b : e.dmxData)
                ev.dmxData.push_back(static_cast<uint8_t>(std::clamp(b, 0, 255)));
            song.events.push_back(std::move(ev));
        }

        int sectionCounter = 1;
        for (const auto& sec : s.sections) {
            SongSection section;
            section.id = "meta::section:" + std::to_string(sectionCounter++);
            section.name = sec.name;
            section.startSeconds = sec.startSeconds;
            section.colorIndex = sec.colorIndex;
            song.sections.push_back(std::move(section));
        }

        for (const auto& lc : s.lightCues) {
            LightCue cue;
            cue.id = generateUuidV7();
            cue.trackId = lightTrackIdMap.count(lc.trackId) ? lightTrackIdMap[lc.trackId] : lc.trackId;
            cue.startSeconds = lc.startSeconds;
            cue.durationSeconds = lc.durationSeconds;
            if (!lc.label.empty()) cue.label = lc.label;
            cue.color.r = static_cast<uint8_t>(std::clamp(lc.colorR, 0, 255));
            cue.color.g = static_cast<uint8_t>(std::clamp(lc.colorG, 0, 255));
            cue.color.b = static_cast<uint8_t>(std::clamp(lc.colorB, 0, 255));
            cue.intensity = lc.intensity;
            cue.fade.inSeconds = lc.fadeInSeconds;
            cue.fade.outSeconds = lc.fadeOutSeconds;
            if (!lc.effectType.empty()) cue.effect.type = lc.effectType;
            cue.effect.sourceType = lc.effectSourceType.empty() ? "bus" : lc.effectSourceType;
            if (!lc.effectSourceId.empty()) {
                cue.effect.sourceId = lc.effectSourceType == "track" && trackIdMap.count(lc.effectSourceId)
                                           ? trackIdMap[lc.effectSourceId]
                                           : lc.effectSourceId;
            }
            cue.effect.intensity = lc.effectIntensity;
            cue.effect.tempoSync = lc.tempoSync;
            cue.effect.tempoSubdivision = lc.tempoSubdiv.empty() ? "1/4" : lc.tempoSubdiv;
            cue.effect.rateHz = lc.effectRateHz;
            cue.gradient.preset = lc.gradientPreset.empty() ? "solid" : lc.gradientPreset;
            if (!lc.gradientColors.empty())
                cue.gradient.colors = lc.gradientColors;
            cue.blendMode = lc.blendMode.empty() ? "normal" : lc.blendMode;
            song.lightCues.push_back(std::move(cue));
        }

        p.songs.push_back(std::move(song));
    }

    // ---- Cycle ----
    p.cycle.active = w.cycle.active;
    p.cycle.skip = w.cycle.skip;
    p.cycle.startSeconds = std::max(0.0, w.cycle.leftSec);
    p.cycle.endSeconds = std::max(0.0, w.cycle.rightSec);
    if (p.cycle.endSeconds < p.cycle.startSeconds)
        std::swap(p.cycle.startSeconds, p.cycle.endSeconds);
    p.cycle.songIndex = w.cycle.songIndex;
    if (p.cycle.songIndex >= static_cast<int>(p.songs.size()))
        p.cycle.songIndex = p.songs.empty() ? -1 : 0;

    // ---- MIDI (untouched semantics, just re-nested) ----
    p.midi.mappings.reserve(w.midiMappings.size());
    for (const auto& m : w.midiMappings) {
        MidiMapping mm;
        mm.action = m.action;
        mm.channel = m.channel;
        mm.triggerType = (m.triggerType == "controlChange")
                             ? MidiTriggerType::ControlChange
                             : MidiTriggerType::NoteOn;
        mm.number = m.number;
        p.midi.mappings.push_back(std::move(mm));
    }

    // keybindings: intentionally dropped (now rig-wide, see AppSettings).

    out = std::move(p);
    return true;
}

} // namespace resostage
