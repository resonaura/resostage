#pragma once

// Shared helpers for web-parity commands: WebServer passes raw JSON bodies
// through untouched (see WebCommand::json), and MainComponent* handlers need
// the same field accessors and EventType<->wire-string mapping. Header-only.
//
// Dynamic command/settings parse uses Glaze's glz::generic (DOM-like tree).
// Project files use typed Glaze DTOs in ProjectJson.cpp instead.

#include "project/ProjectSchema.h"
#include "project/Uuid.h"

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

// A fresh id for a song / track / region / section / event.
//
// UUIDv7, not the counter this used to be. A counter looks tidier in a JSON
// file and is wrong in two ways that both bite: "reg_3" is only unique
// against the ids that happen to be in the list handed to it, so a region
// deleted and re-added reuses the id of the one before it -- and undo history,
// peak caches and the streaming engine's per-region buffers are all keyed by
// region id, so the new region silently inherits the old one's state. The
// second is ordering: v7 is time-prefixed, so ids sort by creation, which is
// what makes a split's two halves stay in the order they were cut.
//
// `used` is still consulted, even though a v7 collision needs the same thread
// to produce two ids in one millisecond AND match 74 random bits -- it costs
// one linear scan on an operation that already touches the whole project.
//
// Deliberately NOT used for send busses: those are "audio::send:N" and the
// number IS parsed (see MainComponentBuilder's kSendPrefix) because routing
// targets are addressed by it.
inline std::string makeUniqueId(const std::string& prefix, const std::vector<std::string>& used) {
    (void)prefix; // kept so call sites still read as "an id for a <thing>"
    for (int attempt = 0; attempt < 8; ++attempt) {
        std::string id = generateUuidV7();
        if (std::find(used.begin(), used.end(), id) == used.end())
            return id;
    }
    return generateUuidV7();
}

} // namespace resostage::builder_json
