#include "ProjectJson.h"

#include "glaze/glaze.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace resostage {

std::string jsonEscapeString(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

const char* eventTypeToString(EventType type) {
    switch (type) {
        case EventType::MidiNoteOn: return "midiNoteOn";
        case EventType::MidiNoteOff: return "midiNoteOff";
        case EventType::MidiCC: return "midiCC";
        case EventType::MidiProgramChange: return "midiProgramChange";
        case EventType::Http: return "http";
        case EventType::Dmx: return "dmx";
    }
    return "midiProgramChange";
}

const char* songEndToString(SongEnd mode) {
    return mode == SongEnd::Next ? "next" : "stop";
}

SongEnd songEndFromString(const std::string& s) {
    return s == "next" ? SongEnd::Next : SongEnd::Stop;
}

// Fixture/rig kinds are namespaced values ("<vendor-or-protocol>::<model>")
// so a second ResoLight product or a second protocol slots in without
// re-reading like a compound word. `resolight` is one word, never `resoLight`.
const char* lightFixtureKindToString(LightFixture::Kind kind) {
    return kind == LightFixture::Kind::DmxGeneric ? "dmx::generic" : "resolight::bar";
}

const char* lightingKindToString(LightingKind kind) {
    switch (kind) {
        case LightingKind::ResoLight: return "resolight";
        case LightingKind::DmxGeneric: return "dmx::generic";
        case LightingKind::None: return "none";
    }
    return "none";
}

const char* outputTypeToString(OutputType type) {
    switch (type) {
        case OutputType::Main: return "main";
        case OutputType::SendsOnly: return "sends-only";
        case OutputType::ExtOut: return "ext-out";
    }
    return "sends-only";
}

// Unrecognized/malformed type falls back to SendsOnly: audible nowhere by a
// main route, but a track's sends still work -- never guess a physical
// target or silently redirect into Main.
OutputType outputTypeFromString(const std::string& s) {
    if (s == "main") return OutputType::Main;
    if (s == "ext-out") return OutputType::ExtOut;
    return OutputType::SendsOnly;
}

std::string extOutTarget(int startChannel0Based, int channels) {
    const int a = std::max(0, startChannel0Based) + 1; // 1-based
    if (channels >= 2)
        return "audio::out:" + std::to_string(a) + ",audio::out:" + std::to_string(a + 1);
    return "audio::out:" + std::to_string(a);
}

void parseExtOutTarget(const std::string& target, int& startChannel0Based, int& channelCount) {
    startChannel0Based = 0;
    channelCount = 1;
    std::vector<int> nums;
    size_t pos = 0;
    while (pos <= target.size()) {
        const size_t end = target.find(',', pos);
        const std::string tok = target.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
        pos = (end == std::string::npos) ? target.size() + 1 : end + 1;
        constexpr std::string_view prefix = "audio::out:";
        if (tok.rfind(prefix, 0) == 0) {
            try {
                nums.push_back(std::stoi(tok.substr(prefix.size())));
            } catch (...) {
                // ignore unparseable token
            }
        }
        if (end == std::string::npos)
            break;
    }
    if (nums.empty())
        return;
    startChannel0Based = std::max(0, nums.front() - 1);
    channelCount = static_cast<int>(nums.size());
}

// Wire DTOs need external linkage for Glaze reflection (anonymous-namespace
// types fail get_name). Names match project.json keys exactly.
namespace project_json_wire {

struct WFormat {
    // 0 = absent from the JSON (tolerant parsing leaves missing keys at their
    // DTO default) -- deliberately NOT kCurrentFormatVersion, so an old-shape
    // file with no "format" key at all is unambiguously detected as needing
    // LegacyProjectMigration.h rather than silently "succeeding" a tolerant
    // parse with every other field at its new-schema default. See
    // ProjectLoader::reparseProject()'s format.version gate.
    int version = 0;
};

struct WSendConfig {
    std::string bus;
    double level = 100.0;
    bool preFader = false;
    bool enabled = true;
};

struct WSourceOutput {
    std::string type = "main";
    std::optional<std::string> target;
    std::vector<WSendConfig> sends;
};

struct WBusOutput {
    std::string type = "ext-out";
    std::optional<std::string> target;
};

struct WClick {
    bool enabled = false;
    std::string name = "Click";
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    WSourceOutput output;
};

struct WMaster {
    bool enabled = true;
    std::string name = "Main";
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    WBusOutput output;
};

struct WSendBus {
    std::string id;
    std::string name;
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    WBusOutput output;
};

struct WTrack {
    std::string id;
    std::string name;
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    WSourceOutput output;
};

struct WFixtureGrid {
    int column = 0;
    int row = 0;
};

struct WFixturePosition {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

struct WFixtureRotation {
    double y = 0.0;
};

struct WFixtureDmx {
    int universe = 0;
    int startChannel = 1;
    int channelCount = 3;
};

struct WFixture {
    std::string id;
    std::string name;
    std::string kind;
    WFixtureGrid grid;
    int ledCount = 0;
    bool addressable = false;
    WFixturePosition position;
    WFixtureRotation rotation;
    bool mountedHorizontally = false;
    WFixtureDmx dmx;
    std::string shape;
    int matrixColumns = 0;
    std::string channelProfile;
    double tiltDegrees = 0.0;
    double refreshRateHz = 0.0;
    std::optional<std::string> networkHost;
};

struct WColor {
    int r = 255;
    int g = 255;
    int b = 255;
};

struct WLightGradient {
    std::string preset = "solid";
    std::optional<std::string> colors;
};

struct WLightingIdleEffect {
    std::string type = "none";
    double rateHz = 2.0;
};

struct WLightingIdle {
    std::string behavior = "hold";
    WColor color;
    double intensity = 1.0;
    WLightingIdleEffect effect;
    WLightGradient gradient;
};

struct WLightingResoLight {
    int columns = 2;
    int rows = 1;
};

struct WLightTrack {
    std::string id;
    std::string name;
    std::vector<std::string> fixtureIds;
};

struct WLighting {
    bool enabled = false;
    std::string kind = "none";
    WLightingResoLight resolight;
    WLightingIdle idle;
    double defaultRefreshRateHz = 44.0;
    std::optional<std::string> artNetTargetHost;
    std::vector<WFixture> fixtures;
    std::vector<WLightTrack> tracks;
};

struct WTimeSig {
    int numerator = 4;
    int denominator = 4;
};

struct WRegionSource {
    std::string file;
    double offsetSeconds = 0.0;
};

struct WRegionFade {
    double inSeconds = 0.0;
    double outSeconds = 0.0;
    double inCurve = 0.0;
    double outCurve = 0.0;
};

struct WRegionLoop {
    bool enabled = false;
    double lengthSeconds = 0.0;
};

struct WRegion {
    std::string id;
    std::string trackId;
    double startSeconds = 0.0;
    double durationSeconds = 0.0;
    double gainDb = 0.0;
    WRegionSource source;
    WRegionFade fade;
    WRegionLoop loop;
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
    std::optional<std::string> httpUrl;
    std::string httpMethod;
    std::optional<std::string> httpBody;
    int dmxUniverse = 0;
    std::vector<int> dmxData;
};

struct WSection {
    std::string id;
    std::string name;
    double startSeconds = 0.0;
    int colorIndex = 0;
};

struct WLightCueFade {
    double inSeconds = 0.0;
    double outSeconds = 0.0;
};

struct WLightEffect {
    std::optional<std::string> type;
    std::string sourceType = "bus";
    std::optional<std::string> sourceId;
    double intensity = 0.8;
    bool tempoSync = false;
    std::string tempoSubdivision = "1/4";
    double rateHz = 2.0;
};

struct WLightCue {
    std::string id;
    std::string trackId;
    double startSeconds = 0.0;
    double durationSeconds = 1.0;
    std::optional<std::string> label;
    WColor color;
    double intensity = 1.0;
    WLightCueFade fade;
    WLightEffect effect;
    WLightGradient gradient;
    std::string blendMode = "normal";
};

struct WSong {
    std::string id;
    std::string name;
    double bpm = 120.0;
    WTimeSig timeSignature;
    std::string onEnded = "stop";
    std::vector<WRegion> regions;
    std::vector<WEvent> events;
    std::vector<WSection> sections;
    std::vector<WLightCue> lightCues;
};

struct WCycle {
    bool active = false;
    bool skip = false;
    double startSeconds = 0.0;
    double endSeconds = 4.0;
    int songIndex = -1;
};

struct WMidiMapping {
    std::string action;
    int channel = 0;
    std::string triggerType;
    int number = 0;
};

struct WMidi {
    std::vector<WMidiMapping> mappings;
};

// Standalone (needs external linkage for Glaze reflection, same as every
// other wire DTO) -- used only to peek format.version before deciding
// current-shape vs. legacy-shape parsing.
struct WFormatOnly {
    WFormat format;
};

struct WProject {
    WFormat format;
    std::string name;
    double sampleRate = 48000.0;
    WClick click;
    WMaster main;
    std::vector<WSendBus> sends;
    std::vector<WTrack> tracks;
    WLighting lighting;
    std::vector<WSong> songs;
    WCycle cycle;
    WMidi midi;
};

double finiteOrZero(double v) {
    return std::isfinite(v) ? v : 0.0;
}

WSendConfig toWireSend(const SendConfig& s) {
    WSendConfig w;
    w.bus = s.bus;
    w.level = std::clamp(finiteOrZero(s.level), 0.0, 100.0);
    w.preFader = s.preFader;
    w.enabled = s.enabled;
    return w;
}

SendConfig fromWireSend(const WSendConfig& w) {
    SendConfig s;
    s.bus = w.bus;
    s.level = std::clamp(finiteOrZero(w.level), 0.0, 100.0);
    s.preFader = w.preFader;
    s.enabled = w.enabled;
    return s;
}

WSourceOutput toWireSourceOutput(const SourceOutput& o) {
    WSourceOutput w;
    w.type = outputTypeToString(o.type);
    w.target = o.target;
    w.sends.reserve(o.sends.size());
    for (const auto& s : o.sends)
        w.sends.push_back(toWireSend(s));
    return w;
}

SourceOutput fromWireSourceOutput(const WSourceOutput& w) {
    SourceOutput o;
    o.type = outputTypeFromString(w.type);
    o.target = w.target;
    o.sends.reserve(w.sends.size());
    for (const auto& s : w.sends)
        o.sends.push_back(fromWireSend(s));
    return o;
}

WBusOutput toWireBusOutput(const BusRoute& o) {
    WBusOutput w;
    w.type = outputTypeToString(o.type);
    w.target = o.target;
    return w;
}

BusRoute fromWireBusOutput(const WBusOutput& w) {
    BusRoute o;
    o.type = outputTypeFromString(w.type);
    o.target = w.target;
    return o;
}

WColor toWireColor(const RgbColor& c) {
    return WColor{c.r, c.g, c.b};
}

RgbColor fromWireColor(const WColor& w) {
    RgbColor c;
    c.r = static_cast<uint8_t>(std::clamp(w.r, 0, 255));
    c.g = static_cast<uint8_t>(std::clamp(w.g, 0, 255));
    c.b = static_cast<uint8_t>(std::clamp(w.b, 0, 255));
    return c;
}

WLightGradient toWireGradient(const LightGradient& g) {
    WLightGradient w;
    w.preset = g.preset;
    w.colors = g.colors;
    return w;
}

LightGradient fromWireGradient(const WLightGradient& w) {
    LightGradient g;
    g.preset = w.preset;
    g.colors = w.colors;
    return g;
}

WProject toWire(const Project& p) {
    WProject w;
    w.format.version = p.format.version;
    w.name = p.name;
    w.sampleRate = finiteOrZero(p.sampleRate);

    w.click.enabled = p.click.enabled;
    w.click.name = p.click.name.empty() ? "Click" : p.click.name;
    w.click.channels = std::clamp(p.click.channels, 1, 2);
    w.click.gainDb = finiteOrZero(p.click.gainDb);
    w.click.pan = finiteOrZero(p.click.pan);
    w.click.mute = p.click.mute;
    w.click.solo = p.click.solo;
    w.click.output = toWireSourceOutput(p.click.output);

    w.main.enabled = p.main.enabled;
    w.main.name = p.main.name.empty() ? "Main" : p.main.name;
    w.main.channels = std::clamp(p.main.channels, 1, 2);
    w.main.gainDb = finiteOrZero(p.main.gainDb);
    w.main.pan = finiteOrZero(p.main.pan);
    w.main.mute = p.main.mute;
    w.main.solo = p.main.solo;
    w.main.output = toWireBusOutput(p.main.output);

    w.sends.reserve(p.sends.size());
    for (const auto& b : p.sends) {
        WSendBus wb;
        wb.id = b.id;
        wb.name = b.name;
        wb.channels = std::clamp(b.channels, 1, 2);
        wb.gainDb = finiteOrZero(b.gainDb);
        wb.pan = finiteOrZero(b.pan);
        wb.mute = b.mute;
        wb.solo = b.solo;
        wb.output = toWireBusOutput(b.output);
        w.sends.push_back(std::move(wb));
    }

    w.tracks.reserve(p.tracks.size());
    for (const auto& t : p.tracks) {
        WTrack wt;
        wt.id = t.id;
        wt.name = t.name;
        wt.channels = std::clamp(t.channels, 1, 2);
        wt.gainDb = finiteOrZero(t.gainDb);
        wt.pan = finiteOrZero(t.pan);
        wt.mute = t.mute;
        wt.solo = t.solo;
        wt.output = toWireSourceOutput(t.output);
        w.tracks.push_back(std::move(wt));
    }

    w.lighting.enabled = p.lighting.enabled;
    w.lighting.kind = lightingKindToString(p.lighting.kind);
    w.lighting.resolight.columns = p.lighting.resolight.columns;
    w.lighting.resolight.rows = p.lighting.resolight.rows;
    w.lighting.idle.behavior = p.lighting.idle.behavior;
    w.lighting.idle.color = toWireColor(p.lighting.idle.color);
    w.lighting.idle.intensity = finiteOrZero(p.lighting.idle.intensity);
    w.lighting.idle.effect.type = p.lighting.idle.effect.type;
    w.lighting.idle.effect.rateHz = finiteOrZero(p.lighting.idle.effect.rateHz);
    w.lighting.idle.gradient = toWireGradient(p.lighting.idle.gradient);
    w.lighting.defaultRefreshRateHz = finiteOrZero(p.lighting.defaultRefreshRateHz);
    w.lighting.artNetTargetHost = p.lighting.artNetTargetHost;
    w.lighting.fixtures.reserve(p.lighting.fixtures.size());
    for (const auto& f : p.lighting.fixtures) {
        WFixture wf;
        wf.id = f.id;
        wf.name = f.name;
        wf.kind = lightFixtureKindToString(f.kind);
        wf.grid.column = f.grid.column;
        wf.grid.row = f.grid.row;
        wf.ledCount = f.ledCount;
        wf.addressable = f.addressable;
        wf.position.x = finiteOrZero(f.position.x);
        wf.position.y = finiteOrZero(f.position.y);
        wf.position.z = finiteOrZero(f.position.z);
        wf.rotation.y = finiteOrZero(f.rotation.y);
        wf.mountedHorizontally = f.mountedHorizontally;
        wf.dmx.universe = f.dmx.universe;
        wf.dmx.startChannel = f.dmx.startChannel;
        wf.dmx.channelCount = f.dmx.channelCount;
        wf.shape = f.shape;
        wf.matrixColumns = f.matrixColumns;
        wf.channelProfile = f.channelProfile;
        wf.tiltDegrees = finiteOrZero(f.tiltDegrees);
        wf.refreshRateHz = finiteOrZero(f.refreshRateHz);
        wf.networkHost = f.networkHost;
        w.lighting.fixtures.push_back(std::move(wf));
    }

    w.lighting.tracks.reserve(p.lighting.tracks.size());
    for (const auto& lt : p.lighting.tracks) {
        WLightTrack wlt;
        wlt.id = lt.id;
        wlt.name = lt.name;
        wlt.fixtureIds = lt.fixtureIds;
        w.lighting.tracks.push_back(std::move(wlt));
    }

    w.songs.reserve(p.songs.size());
    for (const auto& s : p.songs) {
        WSong ws;
        ws.id = s.id;
        ws.name = s.name;
        ws.bpm = finiteOrZero(s.bpm);
        ws.timeSignature.numerator = s.timeSignature.numerator;
        ws.timeSignature.denominator = s.timeSignature.denominator;
        ws.onEnded = songEndToString(s.onEnded);

        for (const auto& r : s.regions) {
            if (r.source.file.empty())
                continue;
            WRegion wr;
            wr.id = r.id;
            wr.trackId = r.trackId;
            wr.startSeconds = finiteOrZero(r.startSeconds);
            wr.durationSeconds = finiteOrZero(r.durationSeconds);
            wr.gainDb = finiteOrZero(r.gainDb);
            wr.source.file = r.source.file;
            wr.source.offsetSeconds = finiteOrZero(r.source.offsetSeconds);
            wr.fade.inSeconds = finiteOrZero(r.fade.inSeconds);
            wr.fade.outSeconds = finiteOrZero(r.fade.outSeconds);
            wr.fade.inCurve = finiteOrZero(r.fade.inCurve);
            wr.fade.outCurve = finiteOrZero(r.fade.outCurve);
            wr.loop.enabled = r.loop.enabled;
            wr.loop.lengthSeconds = finiteOrZero(r.loop.lengthSeconds);
            ws.regions.push_back(std::move(wr));
        }

        for (const auto& e : s.events) {
            WEvent we;
            we.id = e.id;
            we.type = eventTypeToString(e.type);
            we.timeSeconds = finiteOrZero(e.timeSeconds);
            we.triggerOnLoad = e.triggerOnLoad;
            we.latencyCompensationMs = finiteOrZero(e.latencyCompensationMs);
            we.midiChannel = e.midiChannel;
            we.midiNote = e.midiNote;
            we.midiVelocity = e.midiVelocity;
            we.midiCC = e.midiCC;
            we.midiCCValue = e.midiCCValue;
            we.midiProgram = e.midiProgram;
            we.httpUrl = e.httpUrl;
            we.httpMethod = e.httpMethod;
            we.httpBody = e.httpBody;
            we.dmxUniverse = e.dmxUniverse;
            we.dmxData.reserve(e.dmxData.size());
            for (uint8_t b : e.dmxData)
                we.dmxData.push_back(static_cast<int>(b));
            ws.events.push_back(std::move(we));
        }

        for (const auto& sec : s.sections) {
            WSection wsec;
            wsec.id = sec.id;
            wsec.name = sec.name;
            wsec.startSeconds = finiteOrZero(sec.startSeconds);
            wsec.colorIndex = sec.colorIndex;
            ws.sections.push_back(std::move(wsec));
        }

        for (const auto& lc : s.lightCues) {
            WLightCue wlc;
            wlc.id = lc.id;
            wlc.trackId = lc.trackId;
            wlc.startSeconds = finiteOrZero(lc.startSeconds);
            wlc.durationSeconds = finiteOrZero(lc.durationSeconds);
            wlc.label = lc.label;
            wlc.color = toWireColor(lc.color);
            wlc.intensity = finiteOrZero(lc.intensity);
            wlc.fade.inSeconds = finiteOrZero(lc.fade.inSeconds);
            wlc.fade.outSeconds = finiteOrZero(lc.fade.outSeconds);
            wlc.effect.type = lc.effect.type;
            wlc.effect.sourceType = lc.effect.sourceType;
            wlc.effect.sourceId = lc.effect.sourceId;
            wlc.effect.intensity = finiteOrZero(lc.effect.intensity);
            wlc.effect.tempoSync = lc.effect.tempoSync;
            wlc.effect.tempoSubdivision = lc.effect.tempoSubdivision;
            wlc.effect.rateHz = finiteOrZero(lc.effect.rateHz);
            wlc.gradient = toWireGradient(lc.gradient);
            wlc.blendMode = lc.blendMode;
            ws.lightCues.push_back(std::move(wlc));
        }

        w.songs.push_back(std::move(ws));
    }

    w.cycle.active = p.cycle.active;
    w.cycle.skip = p.cycle.skip;
    w.cycle.startSeconds = finiteOrZero(p.cycle.startSeconds);
    w.cycle.endSeconds = finiteOrZero(p.cycle.endSeconds);
    w.cycle.songIndex = p.cycle.songIndex;

    w.midi.mappings.reserve(p.midi.mappings.size());
    for (const auto& m : p.midi.mappings) {
        WMidiMapping wm;
        wm.action = m.action;
        wm.channel = m.channel;
        wm.triggerType =
            m.triggerType == MidiTriggerType::ControlChange ? "controlChange" : "noteOn";
        wm.number = m.number;
        w.midi.mappings.push_back(std::move(wm));
    }

    return w;
}

} // namespace project_json_wire

int peekProjectFormatVersion(std::string_view json) {
    project_json_wire::WFormatOnly w{};
    constexpr glz::opts opts{
        .error_on_unknown_keys = false,
        .error_on_missing_keys = false,
    };
    if (glz::read<opts>(w, json))
        return 0;
    return w.format.version;
}

std::string serializeProjectJson(const Project& project) {
    using project_json_wire::toWire;
    const auto wire = toWire(project);
    std::string buffer;
    // Pretty JSON for human-readable archives (loader ignores whitespace).
    // indentation_width is not on base glz::opts in Glaze v5+; carry it on a
    // derived options struct (see glaze/core/opts.hpp "OTHER AVAILABLE OPTIONS").
    //
    // skip_null_members = false is deliberate: an absent optional is written
    // as an explicit `null`, never omitted. "This cue has no label" and "this
    // file predates labels" are different facts, and a reader shouldn't have
    // to know the schema by heart to tell a missing key from an empty value.
    // It also keeps every object in the file the same shape, which is what
    // makes the format diffable and hand-editable.
    struct pretty_opts : glz::opts {
        bool prettify = true;
        uint8_t indentation_width = 2;
        bool skip_null_members = false;
    };
    const auto ec = glz::write<pretty_opts{}>(wire, buffer);
    if (ec) {
        // Should not fail for well-formed wire DTOs; fall back to compact.
        buffer.clear();
        (void)glz::write_json(wire, buffer);
    }
    if (!buffer.empty() && buffer.back() != '\n')
        buffer.push_back('\n');
    return buffer;
}

namespace {

using namespace project_json_wire;

EventType eventTypeFromString(const std::string& s) {
    if (s == "midiNoteOn") return EventType::MidiNoteOn;
    if (s == "midiNoteOff") return EventType::MidiNoteOff;
    if (s == "midiCC") return EventType::MidiCC;
    if (s == "midiProgramChange") return EventType::MidiProgramChange;
    if (s == "http") return EventType::Http;
    if (s == "dmx") return EventType::Dmx;
    return EventType::MidiProgramChange;
}

LightingKind lightingKindFromString(const std::string& s) {
    if (s == "resolight") return LightingKind::ResoLight;
    if (s == "dmx::generic") return LightingKind::DmxGeneric;
    return LightingKind::None;
}

LightFixture::Kind fixtureKindFromString(const std::string& s) {
    if (s == "dmx::generic") return LightFixture::Kind::DmxGeneric;
    return LightFixture::Kind::ResoLightBar;
}

Project fromWire(const WProject& w) {
    Project p;
    p.format.version = w.format.version;
    p.name = w.name;
    p.sampleRate = w.sampleRate;

    p.click.enabled = w.click.enabled;
    p.click.name = w.click.name.empty() ? "Click" : w.click.name;
    p.click.channels = std::clamp(w.click.channels, 1, 2);
    p.click.gainDb = w.click.gainDb;
    p.click.pan = std::clamp(w.click.pan, -1.0, 1.0);
    p.click.mute = w.click.mute;
    p.click.solo = w.click.solo;
    p.click.output = fromWireSourceOutput(w.click.output);

    p.main.enabled = w.main.enabled;
    p.main.name = w.main.name.empty() ? "Main" : w.main.name;
    p.main.channels = std::clamp(w.main.channels, 1, 2);
    p.main.gainDb = w.main.gainDb;
    p.main.pan = std::clamp(w.main.pan, -1.0, 1.0);
    p.main.mute = w.main.mute;
    p.main.solo = w.main.solo;
    p.main.output = fromWireBusOutput(w.main.output);

    p.sends.reserve(w.sends.size());
    for (const auto& b : w.sends) {
        SendBus bus;
        bus.id = b.id;
        bus.name = b.name;
        bus.channels = std::clamp(b.channels, 1, 2);
        bus.gainDb = b.gainDb;
        bus.pan = std::clamp(b.pan, -1.0, 1.0);
        bus.mute = b.mute;
        bus.solo = b.solo;
        bus.output = fromWireBusOutput(b.output);
        p.sends.push_back(std::move(bus));
    }

    p.tracks.reserve(w.tracks.size());
    for (const auto& t : w.tracks) {
        TrackDef tr;
        tr.id = t.id;
        tr.name = t.name;
        tr.channels = std::clamp(t.channels, 1, 2);
        tr.gainDb = t.gainDb;
        tr.pan = t.pan;
        tr.mute = t.mute;
        tr.solo = t.solo;
        tr.output = fromWireSourceOutput(t.output);
        p.tracks.push_back(std::move(tr));
    }

    p.lighting.enabled = w.lighting.enabled;
    p.lighting.kind = lightingKindFromString(w.lighting.kind);
    p.lighting.resolight.columns = w.lighting.resolight.columns;
    p.lighting.resolight.rows = w.lighting.resolight.rows;
    p.lighting.idle.behavior = w.lighting.idle.behavior.empty() ? "hold" : w.lighting.idle.behavior;
    p.lighting.idle.color = fromWireColor(w.lighting.idle.color);
    p.lighting.idle.intensity = w.lighting.idle.intensity;
    p.lighting.idle.effect.type = w.lighting.idle.effect.type;
    p.lighting.idle.effect.rateHz = w.lighting.idle.effect.rateHz;
    p.lighting.idle.gradient = fromWireGradient(w.lighting.idle.gradient);
    p.lighting.defaultRefreshRateHz = w.lighting.defaultRefreshRateHz;
    p.lighting.artNetTargetHost = w.lighting.artNetTargetHost;
    p.lighting.fixtures.reserve(w.lighting.fixtures.size());
    for (const auto& f : w.lighting.fixtures) {
        LightFixture fx;
        fx.id = f.id;
        fx.name = f.name;
        fx.kind = fixtureKindFromString(f.kind);
        fx.grid.column = f.grid.column;
        fx.grid.row = f.grid.row;
        fx.ledCount = f.ledCount;
        fx.addressable = f.addressable;
        fx.position.x = f.position.x;
        fx.position.y = f.position.y;
        fx.position.z = f.position.z;
        fx.rotation.y = f.rotation.y;
        fx.mountedHorizontally = f.mountedHorizontally;
        fx.dmx.universe = f.dmx.universe;
        fx.dmx.startChannel = f.dmx.startChannel;
        fx.dmx.channelCount = f.dmx.channelCount;
        fx.shape = f.shape;
        fx.matrixColumns = f.matrixColumns;
        fx.channelProfile = f.channelProfile;
        fx.tiltDegrees = f.tiltDegrees;
        fx.refreshRateHz = f.refreshRateHz;
        fx.networkHost = f.networkHost;
        p.lighting.fixtures.push_back(std::move(fx));
    }

    p.lighting.tracks.reserve(w.lighting.tracks.size());
    for (const auto& lt : w.lighting.tracks) {
        LightTrack t;
        t.id = lt.id;
        t.name = lt.name;
        t.fixtureIds = lt.fixtureIds;
        p.lighting.tracks.push_back(std::move(t));
    }

    p.songs.reserve(w.songs.size());
    for (const auto& s : w.songs) {
        SongDef song;
        song.id = s.id;
        song.name = s.name;
        song.bpm = s.bpm;
        song.timeSignature.numerator = s.timeSignature.numerator;
        song.timeSignature.denominator = s.timeSignature.denominator;
        song.onEnded = songEndFromString(s.onEnded);

        for (const auto& r : s.regions) {
            if (r.source.file.empty())
                continue;
            Region reg;
            reg.id = r.id;
            reg.trackId = r.trackId;
            reg.startSeconds = r.startSeconds;
            reg.durationSeconds = r.durationSeconds;
            reg.gainDb = r.gainDb;
            reg.source.file = r.source.file;
            reg.source.offsetSeconds = r.source.offsetSeconds;
            reg.fade.inSeconds = r.fade.inSeconds;
            reg.fade.outSeconds = r.fade.outSeconds;
            reg.fade.inCurve = r.fade.inCurve;
            reg.fade.outCurve = r.fade.outCurve;
            reg.loop.enabled = r.loop.enabled;
            reg.loop.lengthSeconds = r.loop.lengthSeconds;
            song.regions.push_back(std::move(reg));
        }

        for (const auto& e : s.events) {
            TimelineEvent ev;
            ev.id = e.id;
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
            ev.httpUrl = e.httpUrl;
            ev.httpMethod = e.httpMethod.empty() ? "POST" : e.httpMethod;
            ev.httpBody = e.httpBody;
            ev.dmxUniverse = e.dmxUniverse;
            for (int b : e.dmxData)
                ev.dmxData.push_back(static_cast<uint8_t>(std::clamp(b, 0, 255)));
            song.events.push_back(std::move(ev));
        }

        for (const auto& sec : s.sections) {
            SongSection section;
            section.id = sec.id;
            section.name = sec.name;
            section.startSeconds = sec.startSeconds;
            section.colorIndex = sec.colorIndex;
            song.sections.push_back(std::move(section));
        }

        for (const auto& lc : s.lightCues) {
            LightCue cue;
            cue.id = lc.id;
            cue.trackId = lc.trackId;
            cue.startSeconds = lc.startSeconds;
            cue.durationSeconds = lc.durationSeconds;
            cue.label = lc.label;
            cue.color = fromWireColor(lc.color);
            cue.intensity = lc.intensity;
            cue.fade.inSeconds = lc.fade.inSeconds;
            cue.fade.outSeconds = lc.fade.outSeconds;
            cue.effect.type = lc.effect.type;
            cue.effect.sourceType = lc.effect.sourceType;
            cue.effect.sourceId = lc.effect.sourceId;
            cue.effect.intensity = lc.effect.intensity;
            cue.effect.tempoSync = lc.effect.tempoSync;
            cue.effect.tempoSubdivision = lc.effect.tempoSubdivision;
            cue.effect.rateHz = lc.effect.rateHz;
            cue.gradient = fromWireGradient(lc.gradient);
            cue.blendMode = lc.blendMode;
            song.lightCues.push_back(std::move(cue));
        }

        p.songs.push_back(std::move(song));
    }

    p.cycle.active = w.cycle.active;
    p.cycle.skip = w.cycle.skip;
    p.cycle.startSeconds = std::max(0.0, w.cycle.startSeconds);
    p.cycle.endSeconds = std::max(0.0, w.cycle.endSeconds);
    if (p.cycle.endSeconds < p.cycle.startSeconds)
        std::swap(p.cycle.startSeconds, p.cycle.endSeconds);
    p.cycle.songIndex = w.cycle.songIndex;
    if (p.cycle.songIndex >= static_cast<int>(p.songs.size()))
        p.cycle.songIndex = p.songs.empty() ? -1 : 0;

    p.midi.mappings.reserve(w.midi.mappings.size());
    for (const auto& m : w.midi.mappings) {
        MidiMapping mm;
        mm.action = m.action;
        mm.channel = m.channel;
        mm.triggerType = (m.triggerType == "controlChange")
                             ? MidiTriggerType::ControlChange
                             : MidiTriggerType::NoteOn;
        mm.number = m.number;
        p.midi.mappings.push_back(std::move(mm));
    }

    return p;
}

} // namespace

bool parseProjectJson(std::string_view json, Project& out, std::string& error) {
    project_json_wire::WProject wire{};
    // Tolerate unknown keys (forward-compat); missing keys keep DTO defaults.
    constexpr glz::opts opts{
        .error_on_unknown_keys = false,
        .error_on_missing_keys = false,
    };
    const auto ec = glz::read<opts>(wire, json);
    if (ec) {
        error = std::string("project.json parse error: ") + glz::format_error(ec, json);
        return false;
    }
    // Strict event types (no silent fallback to program-change).
    for (const auto& s : wire.songs) {
        for (const auto& e : s.events) {
            if (e.type != "midiNoteOn" && e.type != "midiNoteOff" && e.type != "midiCC"
                && e.type != "midiProgramChange" && e.type != "http" && e.type != "dmx") {
                error = "Unknown event type '" + e.type + "'";
                return false;
            }
        }
    }
    out = fromWire(wire);
    return true;
}

} // namespace resostage
