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
        case OutputType::Bus: return "bus";
    }
    return "sends-only";
}

// Unrecognized/malformed type falls back to SendsOnly: audible nowhere by a
// main route, but a track's sends still work -- never guess a physical
// target or silently redirect into Main.
OutputType outputTypeFromString(const std::string& s) {
    if (s == "main") return OutputType::Main;
    if (s == "ext-out") return OutputType::ExtOut;
    if (s == "bus") return OutputType::Bus;
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
    bool lowLatencySafe = false;
    std::string tap = "post-pan";
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

struct WPluginReference {
    std::string identifier;
    std::string format;
    std::string name;
    std::string manufacturer;
    std::string fileOrIdentifier;
    bool instrument = false;
};

struct WPluginSlot {
    std::string id;
    WPluginReference plugin;
    bool bypassed = false;
    std::optional<std::string> stateResource;
    bool keepAwake = false;
};

struct WClick {
    bool enabled = false;
    std::string name = "Click";
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    bool soloSafe = false;
    WSourceOutput output;
    std::vector<WPluginSlot> plugins;
};

struct WMaster {
    bool enabled = true;
    std::string name = "Main";
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    bool soloSafe = false;
    WBusOutput output;
    std::vector<WPluginSlot> plugins;
};

struct WSendBus {
    std::string id;
    std::string name;
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    bool soloSafe = false;
    WBusOutput output;
    std::vector<WPluginSlot> plugins;
};

struct WTrack {
    std::string id;
    std::string name;
    std::string kind = "audio";
    std::optional<std::string> stripId;
    std::string target = "local";
    std::optional<std::string> peerNodeId;
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    bool soloSafe = false;
    WSourceOutput output;
    std::vector<WPluginSlot> plugins;
    bool recordArmed = false;
    bool inputMonitoring = false;
    std::string inputSource = "none";
    int midiInputChannel = 0;
    std::string midiInputDevice = "all";
    double inputTrimDb = 0.0;
    bool phaseInvert = false;
    std::string polarity = "none";
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

struct WRegionPlayback {
    double speed = 1.0;
    double semitones = 0.0;
    bool reverse = false;
};

struct WAutomationTarget {
    std::string domain = "strip";
    std::string entityId;
    std::string parameterId;
    std::string valueType = "floatNormalized";
    double defaultValue = 0.0;
    double minValue = 0.0;
    double maxValue = 1.0;
};

struct WAutomationPoint {
    double timeBeats = 0.0;
    double value = 0.0;
    double curve = 0.0;
};

struct WAutomationLane {
    std::string id;
    WAutomationTarget target;
    std::string scope = "track";
    bool enabled = true;
    bool muted = false;
    std::string writeMode = "read";
    std::vector<WAutomationPoint> points;
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
    WRegionPlayback playback;
    std::vector<WAutomationLane> automationLanes;
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

struct WMidiNote {
    uint64_t id = 0;
    int pitch = 60;
    double startBeats = 0.0;
    double durationBeats = 1.0;
    double velocity = 0.8;
    double releaseVelocity = 0.5;
    double probability = 1.0;
    int pan = -1;
    int tuningOffsetCents = 0;
    bool muted = false;
};

struct WMidiRegion {
    std::string id;
    std::string trackId;
    std::string name;
    double startBeats = 0.0;
    double durationBeats = 16.0;
    double clipOffsetBeats = 0.0;
    bool loop = false;
    double loopLengthBeats = 16.0;
    bool muted = false;
    std::string color = "#3b82f6";
    std::vector<WMidiNote> notes;
    std::vector<WAutomationLane> automationLanes;
};

struct WTempoPoint {
    double beat = 0.0;
    double bpm = 120.0;
    double timeSeconds = 0.0;
    double curve = 0.0;
};

struct WSignaturePoint {
    double beat = 0.0;
    int numerator = 4;
    int denominator = 4;
    int bar = 1;
};

struct WSong {
    std::string id;
    std::string name;
    double bpm = 120.0;
    WTimeSig timeSignature;
    std::string onEnded = "stop";
    // 0 = derive from content; see SongDef::endSeconds. Absent in projects
    // written before the field existed, which read back as 0 -- i.e. exactly
    // the behaviour they had. Unknown keys are ignored on read (see the
    // glz::opts below), so this needs no format-version bump either way.
    double endSeconds = 0.0;
    std::vector<WRegion> regions;
    std::vector<WMidiRegion> midiRegions;
    std::vector<WAutomationLane> automationLanes;
    std::vector<WTempoPoint> tempoPoints;
    std::vector<WSignaturePoint> signaturePoints;
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
    w.preFader = s.preFader || (s.tap == SendTap::PreFader);
    w.enabled = s.enabled;
    w.lowLatencySafe = s.lowLatencySafe;
    w.tap = sendTapToString(s.tap != SendTap::PostPan ? s.tap : (s.preFader ? SendTap::PreFader : SendTap::PostPan));
    return w;
}

SendConfig fromWireSend(const WSendConfig& w) {
    SendConfig s;
    s.bus = w.bus;
    s.level = std::clamp(finiteOrZero(w.level), 0.0, 100.0);
    s.tap = sendTapFromString(w.tap, w.preFader);
    s.preFader = (s.tap == SendTap::PreFader);
    s.enabled = w.enabled;
    s.lowLatencySafe = w.lowLatencySafe;
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

WPluginSlot toWirePluginSlot(const PluginSlot& slot) {
    WPluginSlot wire;
    wire.id = slot.id;
    wire.plugin.identifier = slot.plugin.identifier;
    wire.plugin.format = slot.plugin.format;
    wire.plugin.name = slot.plugin.name;
    wire.plugin.manufacturer = slot.plugin.manufacturer;
    wire.plugin.fileOrIdentifier = slot.plugin.fileOrIdentifier;
    wire.plugin.instrument = slot.plugin.instrument;
    wire.bypassed = slot.bypassed;
    wire.stateResource = slot.stateResource;
    wire.keepAwake = slot.keepAwake;
    return wire;
}

PluginSlot fromWirePluginSlot(const WPluginSlot& wire) {
    PluginSlot slot;
    slot.id = wire.id;
    slot.plugin.identifier = wire.plugin.identifier;
    slot.plugin.format = wire.plugin.format;
    slot.plugin.name = wire.plugin.name;
    slot.plugin.manufacturer = wire.plugin.manufacturer;
    slot.plugin.fileOrIdentifier = wire.plugin.fileOrIdentifier;
    slot.plugin.instrument = wire.plugin.instrument;
    slot.bypassed = wire.bypassed;
    slot.stateResource = wire.stateResource;
    slot.keepAwake = wire.keepAwake;
    return slot;
}

template <typename WireContainer>
std::vector<PluginSlot> fromWirePluginSlots(const WireContainer& wire) {
    std::vector<PluginSlot> slots;
    slots.reserve(wire.size());
    for (const auto& item : wire) {
        if (!item.id.empty() && !item.plugin.identifier.empty())
            slots.push_back(fromWirePluginSlot(item));
    }
    return slots;
}

template <typename SlotContainer>
std::vector<WPluginSlot> toWirePluginSlots(const SlotContainer& slots) {
    std::vector<WPluginSlot> wire;
    wire.reserve(slots.size());
    for (const auto& slot : slots)
        wire.push_back(toWirePluginSlot(slot));
    return wire;
}

WAutomationTarget toWireAutomationTarget(const AutomationTarget& t) {
    WAutomationTarget wt;
    wt.domain = automationDomainToString(t.domain);
    wt.entityId = t.entityId;
    wt.parameterId = t.parameterId;
    wt.valueType = parameterValueTypeToString(t.valueType);
    wt.defaultValue = finiteOrZero(t.defaultValue);
    wt.minValue = finiteOrZero(t.minValue);
    wt.maxValue = finiteOrZero(t.maxValue);
    return wt;
}

AutomationTarget fromWireAutomationTarget(const WAutomationTarget& wt) {
    AutomationTarget t;
    t.domain = automationDomainFromString(wt.domain);
    t.entityId = wt.entityId;
    t.parameterId = wt.parameterId;
    t.valueType = parameterValueTypeFromString(wt.valueType);
    t.defaultValue = static_cast<float>(wt.defaultValue);
    t.minValue = static_cast<float>(wt.minValue);
    t.maxValue = static_cast<float>(wt.maxValue);
    return t;
}

WAutomationPoint toWireAutomationPoint(const AutomationPoint& p) {
    WAutomationPoint wp;
    wp.timeBeats = finiteOrZero(p.timeBeats);
    wp.value = finiteOrZero(p.value);
    wp.curve = std::clamp(static_cast<double>(p.curve), -1.0, 1.0);
    return wp;
}

AutomationPoint fromWireAutomationPoint(const WAutomationPoint& wp) {
    AutomationPoint p;
    p.timeBeats = finiteOrZero(wp.timeBeats);
    p.value = static_cast<float>(finiteOrZero(wp.value));
    p.curve = static_cast<float>(std::clamp(wp.curve, -1.0, 1.0));
    return p;
}

WAutomationLane toWireAutomationLane(const AutomationLane& l) {
    WAutomationLane wl;
    wl.id = l.id;
    wl.target = toWireAutomationTarget(l.target);
    wl.scope = automationScopeToString(l.scope);
    wl.enabled = l.enabled;
    wl.muted = l.muted;
    wl.writeMode = automationWriteModeToString(l.writeMode);
    wl.points.reserve(l.points.size());
    for (const auto& p : l.points)
        wl.points.push_back(toWireAutomationPoint(p));
    return wl;
}

AutomationLane fromWireAutomationLane(const WAutomationLane& wl) {
    AutomationLane l;
    l.id = wl.id;
    l.target = fromWireAutomationTarget(wl.target);
    l.scope = automationScopeFromString(wl.scope);
    l.enabled = wl.enabled;
    l.muted = wl.muted;
    l.writeMode = automationWriteModeFromString(wl.writeMode);
    l.points.reserve(wl.points.size());
    for (const auto& wp : wl.points)
        l.points.push_back(fromWireAutomationPoint(wp));
    return l;
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
    w.click.soloSafe = p.click.soloSafe;
    w.click.output = toWireSourceOutput(p.click.output);
    w.click.plugins = toWirePluginSlots(p.click.plugins);

    w.main.enabled = p.main.enabled;
    w.main.name = p.main.name.empty() ? "Main" : p.main.name;
    w.main.channels = std::clamp(p.main.channels, 1, 2);
    w.main.gainDb = finiteOrZero(p.main.gainDb);
    w.main.pan = finiteOrZero(p.main.pan);
    w.main.mute = p.main.mute;
    w.main.solo = p.main.solo;
    w.main.soloSafe = p.main.soloSafe;
    w.main.output = toWireBusOutput(p.main.output);
    w.main.plugins = toWirePluginSlots(p.main.plugins);

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
        wb.soloSafe = b.soloSafe;
        wb.output = toWireBusOutput(b.output);
        wb.plugins = toWirePluginSlots(b.plugins);
        w.sends.push_back(std::move(wb));
    }

    w.tracks.reserve(p.tracks.size());
    for (const auto& t : p.tracks) {
        WTrack wt;
        wt.id = t.id;
        wt.name = t.name;
        wt.kind = trackKindToString(t.kind);
        wt.stripId = t.stripId;
        wt.target = executionTargetToString(t.target);
        wt.peerNodeId = t.peerNodeId;
        wt.channels = std::clamp(t.channels, 1, 2);
        wt.gainDb = finiteOrZero(t.gainDb);
        wt.pan = finiteOrZero(t.pan);
        wt.mute = t.mute;
        wt.solo = t.solo;
        wt.soloSafe = t.soloSafe;
        wt.output = toWireSourceOutput(t.output);
        wt.plugins = toWirePluginSlots(t.plugins);
        wt.recordArmed = t.recordArmed;
        wt.inputMonitoring = t.inputMonitoring;
        wt.inputSource = t.inputSource;
        wt.midiInputChannel = t.midiInputChannel;
        wt.midiInputDevice = t.midiInputDevice;
        wt.inputTrimDb = finiteOrZero(t.inputTrimDb);
        wt.phaseInvert = t.phaseInvert || (t.polarity != PolarityMask::None);
        wt.polarity = polarityToString(t.polarity);
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
        ws.endSeconds = finiteOrZero(s.endSeconds);

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
            wr.playback.speed = r.playback.speed;
            wr.playback.semitones = finiteOrZero(r.playback.semitones);
            wr.playback.reverse = r.playback.reverse;
            for (const auto& al : r.automationLanes)
                wr.automationLanes.push_back(toWireAutomationLane(al));
            ws.regions.push_back(std::move(wr));
        }

        for (const auto& mr : s.midiRegions) {
            WMidiRegion wmr;
            wmr.id = mr.id;
            wmr.trackId = mr.trackId;
            wmr.name = mr.name;
            wmr.startBeats = finiteOrZero(mr.startBeats);
            wmr.durationBeats = finiteOrZero(mr.durationBeats);
            wmr.clipOffsetBeats = finiteOrZero(mr.clipOffsetBeats);
            wmr.loop = mr.loop;
            wmr.loopLengthBeats = finiteOrZero(mr.loopLengthBeats);
            wmr.muted = mr.muted;
            wmr.color = mr.color;
            wmr.notes.reserve(mr.notes.size());
            for (const auto& n : mr.notes) {
                WMidiNote wn;
                wn.id = n.id;
                wn.pitch = n.pitch;
                wn.startBeats = finiteOrZero(n.startBeats);
                wn.durationBeats = finiteOrZero(n.durationBeats);
                wn.velocity = std::clamp(n.velocity, 0.0f, 1.0f);
                wn.releaseVelocity = std::clamp(n.releaseVelocity, 0.0f, 1.0f);
                wn.probability = std::clamp(n.probability, 0.0f, 1.0f);
                wn.pan = n.pan;
                wn.tuningOffsetCents = n.tuningOffsetCents;
                wn.muted = n.muted;
                wmr.notes.push_back(std::move(wn));
            }
            for (const auto& al : mr.automationLanes)
                wmr.automationLanes.push_back(toWireAutomationLane(al));
            ws.midiRegions.push_back(std::move(wmr));
        }

        for (const auto& al : s.automationLanes)
            ws.automationLanes.push_back(toWireAutomationLane(al));

        for (const auto& tp : s.tempoPoints) {
            WTempoPoint wtp;
            wtp.beat = finiteOrZero(tp.beat);
            wtp.bpm = finiteOrZero(tp.bpm);
            wtp.timeSeconds = finiteOrZero(tp.timeSeconds);
            wtp.curve = finiteOrZero(tp.curve);
            ws.tempoPoints.push_back(std::move(wtp));
        }

        for (const auto& sp : s.signaturePoints) {
            WSignaturePoint wsp;
            wsp.beat = finiteOrZero(sp.beat);
            wsp.numerator = sp.numerator;
            wsp.denominator = sp.denominator;
            wsp.bar = sp.bar;
            ws.signaturePoints.push_back(std::move(wsp));
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
    p.click.plugins = fromWirePluginSlots(w.click.plugins);

    p.main.enabled = w.main.enabled;
    p.main.name = w.main.name.empty() ? "Main" : w.main.name;
    p.main.channels = std::clamp(w.main.channels, 1, 2);
    p.main.gainDb = w.main.gainDb;
    p.main.pan = std::clamp(w.main.pan, -1.0, 1.0);
    p.main.mute = w.main.mute;
    p.main.solo = w.main.solo;
    p.main.soloSafe = w.main.soloSafe;
    p.main.output = fromWireBusOutput(w.main.output);
    p.main.plugins = fromWirePluginSlots(w.main.plugins);

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
        bus.soloSafe = b.soloSafe;
        bus.output = fromWireBusOutput(b.output);
        bus.plugins = fromWirePluginSlots(b.plugins);
        p.sends.push_back(std::move(bus));
    }

    p.tracks.reserve(w.tracks.size());
    for (const auto& t : w.tracks) {
        TrackDef tr;
        tr.id = t.id;
        tr.name = t.name;
        tr.kind = trackKindFromString(t.kind);
        tr.stripId = t.stripId;
        tr.target = executionTargetFromString(t.target);
        tr.peerNodeId = t.peerNodeId;
        tr.channels = std::clamp(t.channels, 1, 2);
        tr.gainDb = t.gainDb;
        tr.pan = t.pan;
        tr.mute = t.mute;
        tr.solo = t.solo;
        tr.soloSafe = t.soloSafe;
        tr.output = fromWireSourceOutput(t.output);
        tr.plugins = fromWirePluginSlots(t.plugins);
        tr.recordArmed = t.recordArmed;
        tr.inputMonitoring = t.inputMonitoring;
        tr.inputSource = t.inputSource.empty() ? "none" : t.inputSource;
        tr.midiInputChannel = t.midiInputChannel;
        tr.midiInputDevice = t.midiInputDevice.empty() ? "all" : t.midiInputDevice;
        tr.inputTrimDb = t.inputTrimDb;
        tr.phaseInvert = t.phaseInvert;
        tr.polarity = polarityFromString(t.polarity, t.phaseInvert);
        tr.phaseInvert = tr.phaseInvert || (tr.polarity != PolarityMask::None);
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
        // Negative or non-finite is not a length; fall back to "derive".
        song.endSeconds = s.endSeconds > 0.0 && std::isfinite(s.endSeconds)
                              ? s.endSeconds
                              : 0.0;

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
            // Guarded: a corrupt or hand-edited speed of 0 (or negative)
            // would divide by zero in the resampler and silence the region.
            reg.playback.speed =
                (std::isfinite(r.playback.speed) && r.playback.speed > 0.01
                 && r.playback.speed < 100.0)
                    ? r.playback.speed
                    : 1.0;
            reg.playback.semitones =
                std::isfinite(r.playback.semitones) ? r.playback.semitones : 0.0;
            reg.playback.reverse = r.playback.reverse;
            for (const auto& wal : r.automationLanes)
                reg.automationLanes.push_back(fromWireAutomationLane(wal));
            song.regions.push_back(std::move(reg));
        }

        for (const auto& mr : s.midiRegions) {
            MidiRegion reg;
            reg.id = mr.id;
            reg.trackId = mr.trackId;
            reg.name = mr.name;
            reg.startBeats = mr.startBeats;
            reg.durationBeats = mr.durationBeats;
            reg.clipOffsetBeats = mr.clipOffsetBeats;
            reg.loop = mr.loop;
            reg.loopLengthBeats = mr.loopLengthBeats;
            reg.muted = mr.muted;
            reg.color = mr.color.empty() ? "#3b82f6" : mr.color;
            reg.notes.reserve(mr.notes.size());
            for (const auto& n : mr.notes) {
                MidiNote note;
                note.id = n.id;
                note.pitch = static_cast<uint8_t>(std::clamp(n.pitch, 0, 127));
                note.startBeats = n.startBeats;
                note.durationBeats = std::max(0.0, n.durationBeats);
                note.velocity = std::clamp(static_cast<float>(n.velocity), 0.0f, 1.0f);
                note.releaseVelocity = std::clamp(static_cast<float>(n.releaseVelocity), 0.0f, 1.0f);
                note.probability = std::clamp(static_cast<float>(n.probability), 0.0f, 1.0f);
                note.pan = static_cast<int8_t>(n.pan);
                note.tuningOffsetCents = static_cast<int8_t>(std::clamp(n.tuningOffsetCents, -100, 100));
                note.muted = n.muted;
                reg.notes.push_back(std::move(note));
            }
            for (const auto& wal : mr.automationLanes)
                reg.automationLanes.push_back(fromWireAutomationLane(wal));
            song.midiRegions.push_back(std::move(reg));
        }

        for (const auto& wal : s.automationLanes)
            song.automationLanes.push_back(fromWireAutomationLane(wal));

        for (const auto& tp : s.tempoPoints) {
            TempoPoint pt;
            pt.beat = tp.beat;
            pt.bpm = (tp.bpm > 0.0 && std::isfinite(tp.bpm)) ? tp.bpm : 120.0;
            pt.timeSeconds = tp.timeSeconds;
            pt.curve = tp.curve;
            song.tempoPoints.push_back(std::move(pt));
        }

        for (const auto& sp : s.signaturePoints) {
            SignaturePoint pt;
            pt.beat = sp.beat;
            pt.numerator = sp.numerator > 0 ? sp.numerator : 4;
            pt.denominator = sp.denominator > 0 ? sp.denominator : 4;
            pt.bar = sp.bar > 0 ? sp.bar : 1;
            song.signaturePoints.push_back(std::move(pt));
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
