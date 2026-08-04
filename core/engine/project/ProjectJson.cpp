#include "ProjectJson.h"

#include <cmath>
#include <cstdio>
#include <sstream>

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

namespace {

void writeNumber(std::ostringstream& o, double v) {
    if (!std::isfinite(v))
        v = 0.0;
    o.setf(std::ios::fixed);
    o.precision(6);
    o << v;
    // Trim trailing zeros for readability without breaking parse.
    // Keep simple: always fixed with up to 6 decimals is fine for simdjson.
}

} // namespace

std::string serializeProjectJson(const Project& project) {
    std::ostringstream o;
    o << "{\n";
    o << "  \"formatVersion\": " << project.formatVersion << ",\n";
    o << "  \"name\": \"" << jsonEscapeString(project.name) << "\",\n";
    o << "  \"sampleRate\": ";
    writeNumber(o, project.sampleRate);
    o << ",\n";
    o << "  \"builtInClickEnabled\": " << (project.builtInClickEnabled ? "true" : "false") << ",\n";
    o << "  \"builtInClickBusId\": \"" << jsonEscapeString(project.builtInClickBusId) << "\",\n";
    o << "  \"builtInClickGainDb\": ";
    writeNumber(o, project.builtInClickGainDb);
    o << ",\n";
    o << "  \"builtInClickPan\": ";
    writeNumber(o, project.builtInClickPan);
    o << ",\n";
    o << "  \"builtInClickSolo\": " << (project.builtInClickSolo ? "true" : "false") << ",\n";
    o << "  \"builtInClickSends\": [\n";
    for (size_t csi = 0; csi < project.builtInClickSends.size(); ++csi) {
        const TrackSendDef& cs = project.builtInClickSends[csi];
        o << "    {\n";
        o << "      \"bus\": \"" << jsonEscapeString(cs.busId) << "\",\n";
        o << "      \"gainDb\": ";
        writeNumber(o, cs.gainDb);
        o << ",\n";
        o << "      \"preFader\": " << (cs.preFader ? "true" : "false") << ",\n";
        o << "      \"enabled\": " << (cs.enabled ? "true" : "false") << "\n";
        o << "    }" << (csi + 1 < project.builtInClickSends.size() ? "," : "") << "\n";
    }
    o << "  ],\n";

    o << "  \"busses\": [\n";
    for (size_t i = 0; i < project.busses.size(); ++i) {
        const BusDef& b = project.busses[i];
        o << "    {\n";
        o << "      \"id\": \"" << jsonEscapeString(b.id) << "\",\n";
        o << "      \"name\": \"" << jsonEscapeString(b.name) << "\",\n";
        o << "      \"channels\": " << b.channels << ",\n";
        o << "      \"output\": { \"startChannel\": " << b.output.startChannel << " },\n";
        o << "      \"gainDb\": ";
        writeNumber(o, b.gainDb);
        o << ",\n";
        o << "      \"mute\": " << (b.mute ? "true" : "false") << ",\n";
        o << "      \"solo\": " << (b.solo ? "true" : "false") << ",\n";
        o << "      \"isAux\": " << (b.isAux ? "true" : "false") << "\n";
        o << "    }" << (i + 1 < project.busses.size() ? "," : "") << "\n";
    }
    o << "  ],\n";

    o << "  \"tracks\": [\n";
    for (size_t i = 0; i < project.tracks.size(); ++i) {
        const TrackDef& t = project.tracks[i];
        o << "    {\n";
        o << "      \"id\": \"" << jsonEscapeString(t.id) << "\",\n";
        o << "      \"name\": \"" << jsonEscapeString(t.name) << "\",\n";
        o << "      \"bus\": \"" << jsonEscapeString(t.busId) << "\",\n";
        o << "      \"gainDb\": ";
        writeNumber(o, t.gainDb);
        o << ",\n";
        o << "      \"pan\": ";
        writeNumber(o, t.pan);
        o << ",\n";
        o << "      \"mute\": " << (t.mute ? "true" : "false") << ",\n";
        o << "      \"solo\": " << (t.solo ? "true" : "false") << ",\n";
        o << "      \"mono\": " << (t.mono ? "true" : "false") << ",\n";
        o << "      \"sends\": [\n";
        for (size_t si = 0; si < t.sends.size(); ++si) {
            const TrackSendDef& send = t.sends[si];
            o << "        {\n";
            o << "          \"bus\": \"" << jsonEscapeString(send.busId) << "\",\n";
            o << "          \"gainDb\": ";
            writeNumber(o, send.gainDb);
            o << ",\n";
            o << "          \"preFader\": " << (send.preFader ? "true" : "false") << ",\n";
            o << "          \"enabled\": " << (send.enabled ? "true" : "false") << "\n";
            o << "        }" << (si + 1 < t.sends.size() ? "," : "") << "\n";
        }
        o << "      ]\n";
        o << "    }" << (i + 1 < project.tracks.size() ? "," : "") << "\n";
    }
    o << "  ],\n";

    o << "  \"lighting\": {\n";
    o << "    \"enabled\": " << (project.lighting.enabled ? "true" : "false") << ",\n";
    o << "    \"kind\": \"" << lightingKindToString(project.lighting.kind) << "\",\n";
    o << "    \"resoLightColumns\": " << project.lighting.resoLightColumns << ",\n";
    o << "    \"resoLightRows\": " << project.lighting.resoLightRows << ",\n";
    o << "    \"idleBehavior\": \"" << jsonEscapeString(project.lighting.idleBehavior) << "\",\n";
    o << "    \"idleColorR\": " << static_cast<int>(project.lighting.idleColorR) << ",\n";
    o << "    \"idleColorG\": " << static_cast<int>(project.lighting.idleColorG) << ",\n";
    o << "    \"idleColorB\": " << static_cast<int>(project.lighting.idleColorB) << ",\n";
    o << "    \"idleIntensity\": " << project.lighting.idleIntensity << ",\n";
    o << "    \"idleEffectType\": \"" << jsonEscapeString(project.lighting.idleEffectType) << "\",\n";
    o << "    \"idleEffectRateHz\": "; writeNumber(o, project.lighting.idleEffectRateHz); o << ",\n";
    o << "    \"idleGradientPreset\": \"" << jsonEscapeString(project.lighting.idleGradientPreset) << "\",\n";
    o << "    \"idleGradientColors\": \"" << jsonEscapeString(project.lighting.idleGradientColors) << "\",\n";
    o << "    \"defaultRefreshRateHz\": "; writeNumber(o, project.lighting.defaultRefreshRateHz); o << ",\n";
    o << "    \"fixtures\": [\n";
    for (size_t i = 0; i < project.lighting.fixtures.size(); ++i) {
        const LightFixture& f = project.lighting.fixtures[i];
        o << "      {\n";
        o << "        \"id\": \"" << jsonEscapeString(f.id) << "\",\n";
        o << "        \"name\": \"" << jsonEscapeString(f.name) << "\",\n";
        o << "        \"kind\": \"" << lightFixtureKindToString(f.kind) << "\",\n";
        o << "        \"gridColumn\": " << f.gridColumn << ",\n";
        o << "        \"gridRow\": " << f.gridRow << ",\n";
        o << "        \"ledCount\": " << f.ledCount << ",\n";
        o << "        \"addressable\": " << (f.addressable ? "true" : "false") << ",\n";
        o << "        \"posX\": "; writeNumber(o, f.posX); o << ",\n";
        o << "        \"posY\": "; writeNumber(o, f.posY); o << ",\n";
        o << "        \"posZ\": "; writeNumber(o, f.posZ); o << ",\n";
        o << "        \"rotationYDeg\": "; writeNumber(o, f.rotationYDeg); o << ",\n";
        o << "        \"mountedHorizontally\": " << (f.mountedHorizontally ? "true" : "false") << ",\n";
        o << "        \"dmxUniverse\": " << f.dmxUniverse << ",\n";
        o << "        \"dmxStartChannel\": " << f.dmxStartChannel << ",\n";
        o << "        \"dmxChannelCount\": " << f.dmxChannelCount << ",\n";
        o << "        \"shape\": \"" << jsonEscapeString(f.shape) << "\",\n";
        o << "        \"matrixCols\": " << f.matrixCols << ",\n";
        o << "        \"channelProfile\": \"" << jsonEscapeString(f.channelProfile) << "\",\n";
        o << "        \"tiltDeg\": "; writeNumber(o, f.tiltDeg); o << ",\n";
        o << "        \"refreshRateHz\": "; writeNumber(o, f.refreshRateHz); o << "\n";
        o << "      }" << (i + 1 < project.lighting.fixtures.size() ? "," : "") << "\n";
    }
    o << "    ]\n";
    o << "  },\n";

    o << "  \"lightTracks\": [\n";
    for (size_t i = 0; i < project.lightTracks.size(); ++i) {
        const LightTrack& lt = project.lightTracks[i];
        o << "    {\n";
        o << "      \"id\": \"" << jsonEscapeString(lt.id) << "\",\n";
        o << "      \"name\": \"" << jsonEscapeString(lt.name) << "\",\n";
        o << "      \"fixtureIds\": [";
        for (size_t fi = 0; fi < lt.fixtureIds.size(); ++fi) {
            if (fi) o << ", ";
            o << "\"" << jsonEscapeString(lt.fixtureIds[fi]) << "\"";
        }
        o << "]\n";
        o << "    }" << (i + 1 < project.lightTracks.size() ? "," : "") << "\n";
    }
    o << "  ],\n";

    o << "  \"songs\": [\n";
    for (size_t si = 0; si < project.songs.size(); ++si) {
        const SongDef& s = project.songs[si];
        o << "    {\n";
        o << "      \"id\": \"" << jsonEscapeString(s.id) << "\",\n";
        o << "      \"name\": \"" << jsonEscapeString(s.name) << "\",\n";
        o << "      \"bpm\": ";
        writeNumber(o, s.bpm);
        o << ",\n";
        o << "      \"timeSignature\": { \"numerator\": " << s.timeSignature.numerator
          << ", \"denominator\": " << s.timeSignature.denominator << " },\n";
        o << "      \"playbackMode\": \"" << playbackModeToString(s.playbackMode) << "\",\n";
        // Metronome is project-global -- not re-serialized per song.

        std::vector<const Region*> validRegions;
        for (const auto& r : s.regions) {
            if (!r.file.empty())
                validRegions.push_back(&r);
        }

        o << "      \"regions\": [\n";
        for (size_t ri = 0; ri < validRegions.size(); ++ri) {
            const Region& r = *validRegions[ri];
            o << "        {\n";
            o << "          \"id\": \"" << jsonEscapeString(r.id) << "\",\n";
            o << "          \"trackId\": \"" << jsonEscapeString(r.trackId) << "\",\n";
            o << "          \"file\": \"" << jsonEscapeString(r.file) << "\",\n";
            o << "          \"startSeconds\": ";
            writeNumber(o, r.startSeconds);
            o << ",\n";
            o << "          \"sourceOffsetSeconds\": ";
            writeNumber(o, r.sourceOffsetSeconds);
            o << ",\n";
            o << "          \"durationSeconds\": ";
            writeNumber(o, r.durationSeconds);
            o << ",\n";
            o << "          \"gainDb\": ";
            writeNumber(o, r.gainDb);
            o << ",\n";
            o << "          \"fadeInSeconds\": ";
            writeNumber(o, r.fadeInSeconds);
            o << ",\n";
            o << "          \"fadeOutSeconds\": ";
            writeNumber(o, r.fadeOutSeconds);
            o << ",\n";
            o << "          \"fadeInCurve\": ";
            writeNumber(o, r.fadeInCurve);
            o << ",\n";
            o << "          \"fadeOutCurve\": ";
            writeNumber(o, r.fadeOutCurve);
            o << ",\n";
            o << "          \"loop\": " << (r.loop ? "true" : "false") << "\n";
            o << "        }" << (ri + 1 < validRegions.size() ? "," : "") << "\n";
        }
        o << "      ],\n";

        o << "      \"events\": [\n";
        for (size_t ei = 0; ei < s.events.size(); ++ei) {
            const TimelineEvent& e = s.events[ei];
            o << "        {\n";
            o << "          \"id\": \"" << jsonEscapeString(e.id) << "\",\n";
            o << "          \"type\": \"" << eventTypeToString(e.type) << "\",\n";
            o << "          \"timeSeconds\": ";
            writeNumber(o, e.timeSeconds);
            o << ",\n";
            o << "          \"triggerOnLoad\": " << (e.triggerOnLoad ? "true" : "false") << ",\n";
            o << "          \"latencyCompensationMs\": ";
            writeNumber(o, e.latencyCompensationMs);
            o << ",\n";
            o << "          \"midiChannel\": " << e.midiChannel << ",\n";
            o << "          \"midiNote\": " << e.midiNote << ",\n";
            o << "          \"midiVelocity\": " << e.midiVelocity << ",\n";
            o << "          \"midiCC\": " << e.midiCC << ",\n";
            o << "          \"midiCCValue\": " << e.midiCCValue << ",\n";
            o << "          \"midiProgram\": " << e.midiProgram << ",\n";
            o << "          \"httpUrl\": \"" << jsonEscapeString(e.httpUrl) << "\",\n";
            o << "          \"httpMethod\": \"" << jsonEscapeString(e.httpMethod) << "\",\n";
            o << "          \"httpBody\": \"" << jsonEscapeString(e.httpBody) << "\",\n";
            o << "          \"dmxUniverse\": " << e.dmxUniverse << ",\n";
            o << "          \"dmxData\": [";
            for (size_t di = 0; di < e.dmxData.size(); ++di) {
                if (di)
                    o << ", ";
                o << static_cast<int>(e.dmxData[di]);
            }
            o << "]\n";
            o << "        }" << (ei + 1 < s.events.size() ? "," : "") << "\n";
        }
        o << "      ],\n";

        o << "      \"sections\": [\n";
        for (size_t sci = 0; sci < s.sections.size(); ++sci) {
            const SongSection& sec = s.sections[sci];
            o << "        {\n";
            o << "          \"id\": \"" << jsonEscapeString(sec.id) << "\",\n";
            o << "          \"name\": \"" << jsonEscapeString(sec.name) << "\",\n";
            o << "          \"startSeconds\": ";
            writeNumber(o, sec.startSeconds);
            o << ",\n";
            o << "          \"colorIndex\": " << sec.colorIndex << "\n";
            o << "        }" << (sci + 1 < s.sections.size() ? "," : "") << "\n";
        }
        o << "      ],\n";

        o << "      \"lightCues\": [\n";
        for (size_t lci = 0; lci < s.lightCues.size(); ++lci) {
            const LightCue& lc = s.lightCues[lci];
            o << "        {\n";
            o << "          \"id\": \"" << jsonEscapeString(lc.id) << "\",\n";
            o << "          \"trackId\": \"" << jsonEscapeString(lc.trackId) << "\",\n";
            o << "          \"startSeconds\": "; writeNumber(o, lc.startSeconds); o << ",\n";
            o << "          \"durationSeconds\": "; writeNumber(o, lc.durationSeconds); o << ",\n";
            o << "          \"colorR\": " << static_cast<int>(lc.colorR) << ",\n";
            o << "          \"colorG\": " << static_cast<int>(lc.colorG) << ",\n";
            o << "          \"colorB\": " << static_cast<int>(lc.colorB) << ",\n";
            o << "          \"intensity\": "; writeNumber(o, lc.intensity); o << ",\n";
            o << "          \"fadeInSeconds\": "; writeNumber(o, lc.fadeInSeconds); o << ",\n";
            o << "          \"fadeOutSeconds\": "; writeNumber(o, lc.fadeOutSeconds); o << ",\n";
            o << "          \"label\": \"" << jsonEscapeString(lc.label) << "\",\n";
            o << "          \"effectType\": \"" << jsonEscapeString(lc.effectType) << "\",\n";
            o << "          \"effectSourceType\": \"" << jsonEscapeString(lc.effectSourceType) << "\",\n";
            o << "          \"effectSourceId\": \"" << jsonEscapeString(lc.effectSourceId) << "\",\n";
            o << "          \"effectIntensity\": "; writeNumber(o, lc.effectIntensity); o << ",\n";
            o << "          \"tempoSync\": " << (lc.tempoSync ? "true" : "false") << ",\n";
            o << "          \"tempoSubdiv\": \"" << jsonEscapeString(lc.tempoSubdiv) << "\",\n";
            o << "          \"effectRateHz\": "; writeNumber(o, lc.effectRateHz); o << ",\n";
            o << "          \"gradientPreset\": \"" << jsonEscapeString(lc.gradientPreset) << "\",\n";
            o << "          \"gradientColors\": \"" << jsonEscapeString(lc.gradientColors) << "\",\n";
            o << "          \"blendMode\": \"" << jsonEscapeString(lc.blendMode) << "\"\n";
            o << "        }" << (lci + 1 < s.lightCues.size() ? "," : "") << "\n";
        }
        o << "      ]\n";
        o << "    }" << (si + 1 < project.songs.size() ? "," : "") << "\n";
    }
    o << "  ],\n";

    o << "  \"keybindings\": {\n";
    size_t kbCount = 0;
    for (const auto& [k, v] : project.keybindings) {
        if (kbCount++)
            o << ",\n";
        o << "    \"" << jsonEscapeString(k) << "\": \"" << jsonEscapeString(v) << "\"";
    }
    if (kbCount)
        o << "\n";
    o << "  },\n";

    o << "  \"midiMappings\": [\n";
    for (size_t i = 0; i < project.midiMappings.size(); ++i) {
        const MidiMapping& m = project.midiMappings[i];
        o << "    {\n";
        o << "      \"action\": \"" << jsonEscapeString(m.action) << "\",\n";
        o << "      \"channel\": " << m.channel << ",\n";
        o << "      \"triggerType\": \""
          << (m.triggerType == MidiTriggerType::ControlChange ? "controlChange" : "noteOn")
          << "\",\n";
        o << "      \"number\": " << m.number << "\n";
        o << "    }" << (i + 1 < project.midiMappings.size() ? "," : "") << "\n";
    }
    o << "  ]\n";
    o << "}\n";
    return o.str();
}

} // namespace resostage
