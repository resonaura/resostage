#include "ProjectJson.h"

#include <cmath>
#include <cstdio>
#include <sstream>

namespace resoset {

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
        o << "      \"builtInClickEnabled\": " << (s.builtInClickEnabled ? "true" : "false") << ",\n";
        o << "      \"builtInClickBusId\": \"" << jsonEscapeString(s.builtInClickBusId) << "\",\n";
        o << "      \"builtInClickGainDb\": ";
        writeNumber(o, s.builtInClickGainDb);
        o << ",\n";
        o << "      \"builtInClickSends\": [\n";
        for (size_t csi = 0; csi < s.builtInClickSends.size(); ++csi) {
            const TrackSendDef& cs = s.builtInClickSends[csi];
            o << "        {\n";
            o << "          \"bus\": \"" << jsonEscapeString(cs.busId) << "\",\n";
            o << "          \"gainDb\": ";
            writeNumber(o, cs.gainDb);
            o << ",\n";
            o << "          \"preFader\": " << (cs.preFader ? "true" : "false") << ",\n";
            o << "          \"enabled\": " << (cs.enabled ? "true" : "false") << "\n";
            o << "        }" << (csi + 1 < s.builtInClickSends.size() ? "," : "") << "\n";
        }
        o << "      ],\n";

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
            o << "\n";
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

} // namespace resoset
