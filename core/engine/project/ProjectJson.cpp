#include "ProjectJson.h"

#include "glaze/glaze.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
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

const char* playbackModeToString(PlaybackMode mode) {
    return mode == PlaybackMode::AutoplayNext ? "autoplayNext" : "waitForTrigger";
}

const char* lightFixtureKindToString(LightFixture::Kind kind) {
    return kind == LightFixture::Kind::DmxGeneric ? "dmxGeneric" : "resoLightBar";
}

const char* lightingKindToString(LightingKind kind) {
    switch (kind) {
        case LightingKind::ResoLight: return "resoLight";
        case LightingKind::DmxGeneric: return "dmxGeneric";
        case LightingKind::None: return "none";
    }
    return "none";
}

// Wire DTOs need external linkage for Glaze reflection (anonymous-namespace
// types fail get_name). Names match project.json keys exactly.
namespace project_json_wire {

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
    std::string builtInClickBusId;
    double builtInClickGainDb = -6.0;
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
    std::map<std::string, std::string> keybindings;
    std::vector<WMidiMapping> midiMappings;
};

double finiteOrZero(double v) {
    return std::isfinite(v) ? v : 0.0;
}

WSend toWireSend(const TrackSendDef& s) {
    return WSend{s.busId, finiteOrZero(s.gainDb), s.preFader, s.enabled};
}

WProject toWire(const Project& p) {
    WProject w;
    w.formatVersion = p.formatVersion;
    w.name = p.name;
    w.sampleRate = finiteOrZero(p.sampleRate);
    w.builtInClickEnabled = p.builtInClickEnabled;
    w.builtInClickBusId = p.builtInClickBusId;
    w.builtInClickGainDb = finiteOrZero(p.builtInClickGainDb);
    w.builtInClickPan = finiteOrZero(p.builtInClickPan);
    w.builtInClickMono = p.builtInClickMono;
    w.builtInClickSolo = p.builtInClickSolo;
    w.builtInClickSends.reserve(p.builtInClickSends.size());
    for (const auto& s : p.builtInClickSends)
        w.builtInClickSends.push_back(toWireSend(s));

    w.busses.reserve(p.busses.size());
    for (const auto& b : p.busses) {
        WBus wb;
        wb.id = b.id;
        wb.name = b.name;
        wb.channels = b.channels;
        wb.output.startChannel = b.output.startChannel;
        wb.gainDb = finiteOrZero(b.gainDb);
        wb.pan = finiteOrZero(b.pan);
        wb.mute = b.mute;
        wb.solo = b.solo;
        wb.isAux = b.isAux;
        w.busses.push_back(std::move(wb));
    }

    w.tracks.reserve(p.tracks.size());
    for (const auto& t : p.tracks) {
        WTrack wt;
        wt.id = t.id;
        wt.name = t.name;
        wt.bus = t.busId;
        wt.gainDb = finiteOrZero(t.gainDb);
        wt.pan = finiteOrZero(t.pan);
        wt.mute = t.mute;
        wt.solo = t.solo;
        wt.mono = t.mono;
        wt.sends.reserve(t.sends.size());
        for (const auto& s : t.sends)
            wt.sends.push_back(toWireSend(s));
        w.tracks.push_back(std::move(wt));
    }

    w.lighting.enabled = p.lighting.enabled;
    w.lighting.kind = lightingKindToString(p.lighting.kind);
    w.lighting.resoLightColumns = p.lighting.resoLightColumns;
    w.lighting.resoLightRows = p.lighting.resoLightRows;
    w.lighting.idleBehavior = p.lighting.idleBehavior;
    w.lighting.idleColorR = static_cast<int>(p.lighting.idleColorR);
    w.lighting.idleColorG = static_cast<int>(p.lighting.idleColorG);
    w.lighting.idleColorB = static_cast<int>(p.lighting.idleColorB);
    w.lighting.idleIntensity = finiteOrZero(p.lighting.idleIntensity);
    w.lighting.idleEffectType = p.lighting.idleEffectType;
    w.lighting.idleEffectRateHz = finiteOrZero(p.lighting.idleEffectRateHz);
    w.lighting.idleGradientPreset = p.lighting.idleGradientPreset;
    w.lighting.idleGradientColors = p.lighting.idleGradientColors;
    w.lighting.defaultRefreshRateHz = finiteOrZero(p.lighting.defaultRefreshRateHz);
    w.lighting.artNetTargetHost = p.lighting.artNetTargetHost;
    w.lighting.fixtures.reserve(p.lighting.fixtures.size());
    for (const auto& f : p.lighting.fixtures) {
        WFixture wf;
        wf.id = f.id;
        wf.name = f.name;
        wf.kind = lightFixtureKindToString(f.kind);
        wf.gridColumn = f.gridColumn;
        wf.gridRow = f.gridRow;
        wf.ledCount = f.ledCount;
        wf.addressable = f.addressable;
        wf.posX = finiteOrZero(f.posX);
        wf.posY = finiteOrZero(f.posY);
        wf.posZ = finiteOrZero(f.posZ);
        wf.rotationYDeg = finiteOrZero(f.rotationYDeg);
        wf.mountedHorizontally = f.mountedHorizontally;
        wf.dmxUniverse = f.dmxUniverse;
        wf.dmxStartChannel = f.dmxStartChannel;
        wf.dmxChannelCount = f.dmxChannelCount;
        wf.shape = f.shape;
        wf.matrixCols = f.matrixCols;
        wf.channelProfile = f.channelProfile;
        wf.tiltDeg = finiteOrZero(f.tiltDeg);
        wf.refreshRateHz = finiteOrZero(f.refreshRateHz);
        wf.networkHost = f.networkHost;
        w.lighting.fixtures.push_back(std::move(wf));
    }

    w.lightTracks.reserve(p.lightTracks.size());
    for (const auto& lt : p.lightTracks) {
        WLightTrack wlt;
        wlt.id = lt.id;
        wlt.name = lt.name;
        wlt.fixtureIds = lt.fixtureIds;
        w.lightTracks.push_back(std::move(wlt));
    }

    w.songs.reserve(p.songs.size());
    for (const auto& s : p.songs) {
        WSong ws;
        ws.id = s.id;
        ws.name = s.name;
        ws.bpm = finiteOrZero(s.bpm);
        ws.timeSignature.numerator = s.timeSignature.numerator;
        ws.timeSignature.denominator = s.timeSignature.denominator;
        ws.playbackMode = playbackModeToString(s.playbackMode);

        for (const auto& r : s.regions) {
            if (r.file.empty())
                continue;
            WRegion wr;
            wr.id = r.id;
            wr.trackId = r.trackId;
            wr.file = r.file;
            wr.startSeconds = finiteOrZero(r.startSeconds);
            wr.sourceOffsetSeconds = finiteOrZero(r.sourceOffsetSeconds);
            wr.durationSeconds = finiteOrZero(r.durationSeconds);
            wr.gainDb = finiteOrZero(r.gainDb);
            wr.fadeInSeconds = finiteOrZero(r.fadeInSeconds);
            wr.fadeOutSeconds = finiteOrZero(r.fadeOutSeconds);
            wr.fadeInCurve = finiteOrZero(r.fadeInCurve);
            wr.fadeOutCurve = finiteOrZero(r.fadeOutCurve);
            wr.loop = r.loop;
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
            wlc.colorR = static_cast<int>(lc.colorR);
            wlc.colorG = static_cast<int>(lc.colorG);
            wlc.colorB = static_cast<int>(lc.colorB);
            wlc.intensity = finiteOrZero(lc.intensity);
            wlc.fadeInSeconds = finiteOrZero(lc.fadeInSeconds);
            wlc.fadeOutSeconds = finiteOrZero(lc.fadeOutSeconds);
            wlc.label = lc.label;
            wlc.effectType = lc.effectType;
            wlc.effectSourceType = lc.effectSourceType;
            wlc.effectSourceId = lc.effectSourceId;
            wlc.effectIntensity = finiteOrZero(lc.effectIntensity);
            wlc.tempoSync = lc.tempoSync;
            wlc.tempoSubdiv = lc.tempoSubdiv;
            wlc.effectRateHz = finiteOrZero(lc.effectRateHz);
            wlc.gradientPreset = lc.gradientPreset;
            wlc.gradientColors = lc.gradientColors;
            wlc.blendMode = lc.blendMode;
            ws.lightCues.push_back(std::move(wlc));
        }

        w.songs.push_back(std::move(ws));
    }

    w.cycle.active = p.cycle.active;
    w.cycle.skip = p.cycle.skip;
    w.cycle.leftSec = finiteOrZero(p.cycle.leftSec);
    w.cycle.rightSec = finiteOrZero(p.cycle.rightSec);
    w.cycle.songIndex = p.cycle.songIndex;

    for (const auto& [k, v] : p.keybindings)
        w.keybindings[k] = v;

    w.midiMappings.reserve(p.midiMappings.size());
    for (const auto& m : p.midiMappings) {
        WMidiMapping wm;
        wm.action = m.action;
        wm.channel = m.channel;
        wm.triggerType =
            m.triggerType == MidiTriggerType::ControlChange ? "controlChange" : "noteOn";
        wm.number = m.number;
        w.midiMappings.push_back(std::move(wm));
    }

    return w;
}

} // namespace project_json_wire

std::string serializeProjectJson(const Project& project) {
    using project_json_wire::toWire;
    const auto wire = toWire(project);
    std::string buffer;
    // Pretty JSON for human-readable archives (loader ignores whitespace).
    // indentation_width is not on base glz::opts in Glaze v5+; carry it on a
    // derived options struct (see glaze/core/opts.hpp "OTHER AVAILABLE OPTIONS").
    struct pretty_opts : glz::opts {
        bool prettify = true;
        uint8_t indentation_width = 2;
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
    if (s == "resoLight") return LightingKind::ResoLight;
    if (s == "dmxGeneric") return LightingKind::DmxGeneric;
    return LightingKind::None;
}

LightFixture::Kind fixtureKindFromString(const std::string& s) {
    if (s == "dmxGeneric") return LightFixture::Kind::DmxGeneric;
    return LightFixture::Kind::ResoLightBar;
}

TrackSendDef fromWireSend(const WSend& s) {
    TrackSendDef t;
    t.busId = s.bus;
    t.gainDb = s.gainDb;
    t.preFader = s.preFader;
    t.enabled = s.enabled;
    return t;
}

Project fromWire(const WProject& w) {
    Project p;
    p.formatVersion = w.formatVersion;
    p.name = w.name;
    p.sampleRate = w.sampleRate;
    p.builtInClickEnabled = w.builtInClickEnabled;
    p.builtInClickBusId = w.builtInClickBusId;
    p.builtInClickGainDb = w.builtInClickGainDb;
    p.builtInClickPan = std::clamp(w.builtInClickPan, -1.0, 1.0);
    p.builtInClickMono = w.builtInClickMono;
    p.builtInClickSolo = w.builtInClickSolo;
    p.builtInClickSends.reserve(w.builtInClickSends.size());
    for (const auto& s : w.builtInClickSends)
        p.builtInClickSends.push_back(fromWireSend(s));

    p.busses.reserve(w.busses.size());
    for (const auto& b : w.busses) {
        BusDef bus;
        bus.id = b.id;
        bus.name = b.name;
        bus.channels = b.channels;
        bus.output.startChannel = b.output.startChannel;
        bus.gainDb = b.gainDb;
        bus.pan = std::clamp(b.pan, -1.0, 1.0);
        bus.mute = b.mute;
        bus.solo = b.solo;
        bus.isAux = b.isAux;
        p.busses.push_back(std::move(bus));
    }

    p.tracks.reserve(w.tracks.size());
    for (const auto& t : w.tracks) {
        TrackDef tr;
        tr.id = t.id;
        tr.name = t.name;
        // Empty bus = sends-only track (no main route). Do not invent "main".
        tr.busId = t.bus;
        tr.gainDb = t.gainDb;
        tr.pan = t.pan;
        tr.mute = t.mute;
        tr.solo = t.solo;
        tr.mono = t.mono;
        tr.sends.reserve(t.sends.size());
        for (const auto& s : t.sends)
            tr.sends.push_back(fromWireSend(s));
        p.tracks.push_back(std::move(tr));
    }

    p.lighting.enabled = w.lighting.enabled;
    p.lighting.kind = lightingKindFromString(w.lighting.kind);
    p.lighting.resoLightColumns = w.lighting.resoLightColumns;
    p.lighting.resoLightRows = w.lighting.resoLightRows;
    p.lighting.idleBehavior = w.lighting.idleBehavior.empty() ? "holdLast" : w.lighting.idleBehavior;
    p.lighting.idleColorR = static_cast<uint8_t>(std::clamp(w.lighting.idleColorR, 0, 255));
    p.lighting.idleColorG = static_cast<uint8_t>(std::clamp(w.lighting.idleColorG, 0, 255));
    p.lighting.idleColorB = static_cast<uint8_t>(std::clamp(w.lighting.idleColorB, 0, 255));
    p.lighting.idleIntensity = w.lighting.idleIntensity;
    p.lighting.idleEffectType = w.lighting.idleEffectType;
    p.lighting.idleEffectRateHz = static_cast<float>(w.lighting.idleEffectRateHz);
    p.lighting.idleGradientPreset = w.lighting.idleGradientPreset;
    p.lighting.idleGradientColors = w.lighting.idleGradientColors;
    p.lighting.defaultRefreshRateHz = w.lighting.defaultRefreshRateHz;
    p.lighting.artNetTargetHost = w.lighting.artNetTargetHost;
    p.lighting.fixtures.reserve(w.lighting.fixtures.size());
    for (const auto& f : w.lighting.fixtures) {
        LightFixture fx;
        fx.id = f.id;
        fx.name = f.name;
        fx.kind = fixtureKindFromString(f.kind);
        fx.gridColumn = f.gridColumn;
        fx.gridRow = f.gridRow;
        fx.ledCount = f.ledCount;
        fx.addressable = f.addressable;
        fx.posX = f.posX;
        fx.posY = f.posY;
        fx.posZ = f.posZ;
        fx.rotationYDeg = f.rotationYDeg;
        fx.mountedHorizontally = f.mountedHorizontally;
        fx.dmxUniverse = f.dmxUniverse;
        fx.dmxStartChannel = f.dmxStartChannel;
        fx.dmxChannelCount = f.dmxChannelCount;
        fx.shape = f.shape;
        fx.matrixCols = f.matrixCols;
        fx.channelProfile = f.channelProfile;
        fx.tiltDeg = f.tiltDeg;
        fx.refreshRateHz = f.refreshRateHz;
        fx.networkHost = f.networkHost;
        p.lighting.fixtures.push_back(std::move(fx));
    }

    p.lightTracks.reserve(w.lightTracks.size());
    for (const auto& lt : w.lightTracks) {
        LightTrack t;
        t.id = lt.id;
        t.name = lt.name;
        t.fixtureIds = lt.fixtureIds;
        p.lightTracks.push_back(std::move(t));
    }

    p.songs.reserve(w.songs.size());
    for (const auto& s : w.songs) {
        SongDef song;
        song.id = s.id;
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
            reg.id = r.id;
            reg.trackId = r.trackId;
            reg.file = r.file;
            reg.startSeconds = r.startSeconds;
            reg.sourceOffsetSeconds = r.sourceOffsetSeconds;
            reg.durationSeconds = r.durationSeconds;
            reg.gainDb = r.gainDb;
            reg.fadeInSeconds = r.fadeInSeconds;
            reg.fadeOutSeconds = r.fadeOutSeconds;
            reg.fadeInCurve = r.fadeInCurve;
            reg.fadeOutCurve = r.fadeOutCurve;
            reg.loop = r.loop;
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
            cue.colorR = static_cast<uint8_t>(std::clamp(lc.colorR, 0, 255));
            cue.colorG = static_cast<uint8_t>(std::clamp(lc.colorG, 0, 255));
            cue.colorB = static_cast<uint8_t>(std::clamp(lc.colorB, 0, 255));
            cue.intensity = lc.intensity;
            cue.fadeInSeconds = lc.fadeInSeconds;
            cue.fadeOutSeconds = lc.fadeOutSeconds;
            cue.label = lc.label;
            cue.effectType = lc.effectType;
            cue.effectSourceType = lc.effectSourceType;
            cue.effectSourceId = lc.effectSourceId;
            cue.effectIntensity = static_cast<float>(lc.effectIntensity);
            cue.tempoSync = lc.tempoSync;
            cue.tempoSubdiv = lc.tempoSubdiv;
            cue.effectRateHz = static_cast<float>(lc.effectRateHz);
            cue.gradientPreset = lc.gradientPreset;
            cue.gradientColors = lc.gradientColors;
            cue.blendMode = lc.blendMode;
            song.lightCues.push_back(std::move(cue));
        }

        p.songs.push_back(std::move(song));
    }

    p.cycle.active = w.cycle.active;
    p.cycle.skip = w.cycle.skip;
    p.cycle.leftSec = std::max(0.0, w.cycle.leftSec);
    p.cycle.rightSec = std::max(0.0, w.cycle.rightSec);
    if (p.cycle.rightSec < p.cycle.leftSec)
        std::swap(p.cycle.leftSec, p.cycle.rightSec);
    p.cycle.songIndex = w.cycle.songIndex;
    if (p.cycle.songIndex >= static_cast<int>(p.songs.size()))
        p.cycle.songIndex = p.songs.empty() ? -1 : 0;

    for (const auto& [k, v] : w.keybindings)
        p.keybindings[k] = v;

    p.midiMappings.reserve(w.midiMappings.size());
    for (const auto& m : w.midiMappings) {
        MidiMapping mm;
        mm.action = m.action;
        mm.channel = m.channel;
        mm.triggerType = (m.triggerType == "controlChange")
                             ? MidiTriggerType::ControlChange
                             : MidiTriggerType::NoteOn;
        mm.number = m.number;
        p.midiMappings.push_back(std::move(mm));
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
