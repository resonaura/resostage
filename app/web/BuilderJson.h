#pragma once

// Shared helpers for the Builder web-parity commands: WebServer.cpp passes
// raw JSON bodies through untouched (see WebCommand::json), and both
// MainComponent.cpp (state serialization) and MainComponentBuilder.cpp
// (command handling) need the same simdjson field accessors and
// EventType<->wire-string mapping. Header-only, inline, no .cpp needed.

#include "project/ProjectSchema.h"

#include "simdjson.h"

#include <algorithm>
#include <string>
#include <string_view>
#include <vector>

namespace resostage::builder_json {

// simdjson's `.get(out)` returns an error_code that's truthy on FAILURE
// (mirrors the convention already used in engine/project/ProjectLoader.cpp).
// These wrap that into a more ergonomic "did we get a value" bool, and leave
// `out` untouched when the field is absent -- callers rely on that to mean
// "the web client didn't send this field, don't touch the existing value".

inline bool getInt(const simdjson::dom::element& el, const char* key, int& out) {
    int64_t v;
    if (el[key].get(v))
        return false;
    out = static_cast<int>(v);
    return true;
}

inline bool getDouble(const simdjson::dom::element& el, const char* key, double& out) {
    double d;
    if (!el[key].get(d)) {
        out = d;
        return true;
    }
    int64_t i;
    if (!el[key].get(i)) {
        out = static_cast<double>(i);
        return true;
    }
    return false;
}

inline bool getBool(const simdjson::dom::element& el, const char* key, bool& out) {
    return !el[key].get(out);
}

inline bool getString(const simdjson::dom::element& el, const char* key, std::string& out) {
    std::string_view sv;
    if (el[key].get(sv))
        return false;
    out = std::string(sv);
    return true;
}

inline std::string eventTypeToWebString(EventType type) {
    switch (type) {
        case EventType::MidiCC: return "cc";
        case EventType::MidiNoteOn: return "noteOn";
        case EventType::MidiNoteOff: return "noteOff";
        case EventType::Http: return "http";
        case EventType::Dmx: return "dmx";
        case EventType::MidiProgramChange: return "programChange";
    }
    return "programChange";
}

inline EventType eventTypeFromWebString(const std::string& s) {
    if (s == "cc") return EventType::MidiCC;
    if (s == "noteOn") return EventType::MidiNoteOn;
    if (s == "noteOff") return EventType::MidiNoteOff;
    if (s == "http") return EventType::Http;
    if (s == "dmx") return EventType::Dmx;
    return EventType::MidiProgramChange;
}

// Matches BuilderPanel::makeUniqueId() exactly (kept here instead of made
// reusable from BuilderPanel.h, since that class doesn't otherwise need a
// public dependency from the web command path).
inline std::string makeUniqueId(const std::string& prefix, const std::vector<std::string>& used) {
    for (int n = 1; n < 10000; ++n) {
        const std::string id = prefix + "_" + std::to_string(n);
        if (std::find(used.begin(), used.end(), id) == used.end())
            return id;
    }
    return prefix + "_x";
}

} // namespace resostage::builder_json
