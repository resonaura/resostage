#pragma once

// Shared helpers for web-parity commands: WebServer passes raw JSON bodies
// through untouched (see WebCommand::json), and MainComponent* handlers need
// the same field accessors and EventType<->wire-string mapping. Header-only.
//
// Dynamic command/settings parse uses Glaze's glz::generic (DOM-like tree).
// Project files use typed Glaze DTOs in ProjectJson.cpp instead.

#include "project/ProjectSchema.h"

#include "glaze/glaze.hpp"

#include <algorithm>
#include <string>
#include <string_view>
#include <vector>

namespace resostage::builder_json {

// glz::read_json returns error_ctx that is truthy on failure. Leave `out`
// undefined on failure -- callers must not use it when this returns false.
// Field accessors leave `out` untouched when the key is absent so callers can
// mean "web client didn't send this field, keep the existing value".

inline bool parseJson(const std::string& json, glz::generic& out) {
    return !glz::read_json(out, json);
}

inline bool getInt(const glz::generic& el, const char* key, int& out) {
    if (!el.contains(key))
        return false;
    const glz::generic& v = el[key];
    if (!v.is_number())
        return false;
    out = static_cast<int>(v.get_number());
    return true;
}

inline bool getDouble(const glz::generic& el, const char* key, double& out) {
    if (!el.contains(key))
        return false;
    const glz::generic& v = el[key];
    if (!v.is_number())
        return false;
    out = v.get_number();
    return true;
}

inline bool getBool(const glz::generic& el, const char* key, bool& out) {
    if (!el.contains(key))
        return false;
    const glz::generic& v = el[key];
    if (!v.is_boolean())
        return false;
    out = v.get_boolean();
    return true;
}

inline bool getString(const glz::generic& el, const char* key, std::string& out) {
    if (!el.contains(key))
        return false;
    const glz::generic& v = el[key];
    if (!v.is_string())
        return false;
    out = v.get_string();
    return true;
}

// Array/object children (nullptr if missing or wrong type).
inline const glz::generic::array_t* getArray(const glz::generic& el, const char* key) {
    if (!el.contains(key))
        return nullptr;
    const glz::generic& v = el[key];
    if (!v.is_array())
        return nullptr;
    return &v.get_array();
}

inline const glz::generic::object_t* getObject(const glz::generic& el, const char* key) {
    if (!el.contains(key))
        return nullptr;
    const glz::generic& v = el[key];
    if (!v.is_object())
        return nullptr;
    return &v.get_object();
}

inline bool asInt(const glz::generic& v, int& out) {
    if (!v.is_number())
        return false;
    out = static_cast<int>(v.get_number());
    return true;
}

inline bool asString(const glz::generic& v, std::string& out) {
    if (!v.is_string())
        return false;
    out = v.get_string();
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
