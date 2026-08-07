// The flat "route id" string, and the only two functions that translate it.
//
// A SourceOutput is a tagged union (type + optional target). The SPA, the
// Builder and the metronome all address a source's MAIN destination with a
// single flat string instead, because that is what fits in one <select>:
//
//   ""                              Sends Only -- no main destination at all
//   "audio::main"                   the FOH master
//   "audio::send:2"                 an aux/group bus
//   "audio::out:11"                 one mono physical channel
//   "audio::out:3,audio::out:4"     a stereo pair of physical channels
//
// Both directions live here because they have to agree exactly. They did not:
// the destination <select> offered aux busses, but the code applying the pick
// only knew about "", "audio::main" and lanes, so choosing an aux stored it as
// an ext-out target. buildMixGraph() then found no lanes in "audio::send:2",
// produced no edges, and the track went silent with the UI still showing it
// routed. One function, one rule.
#pragma once

#include "ProjectSchema.h"

#include <string>

namespace resostage {

// SourceOutput -> flat route id.
inline std::string routeIdOf(const SourceOutput& output) {
    switch (output.type) {
        case OutputType::Main:
            return "audio::main";
        case OutputType::Bus:
        case OutputType::ExtOut:
            return output.target.value_or("");
        case OutputType::SendsOnly:
            break;
    }
    return "";
}

// Flat route id -> SourceOutput. `project` is needed to tell an aux bus id
// from anything else; an id that matches no known send falls through to
// ext-out, where a currently-absent lane is dropped to silence and re-wires
// itself when the output returns (so a device change never mangles routing).
inline void applyRouteId(SourceOutput& output, const std::string& routeId,
                         const Project& project) {
    if (routeId.empty()) {
        output.type = OutputType::SendsOnly;
        output.target.reset();
        return;
    }
    if (routeId == "audio::main") {
        output.type = OutputType::Main;
        output.target.reset();
        return;
    }
    for (const SendBus& send : project.sends) {
        if (send.id == routeId) {
            output.type = OutputType::Bus;
            output.target = routeId;
            return;
        }
    }
    output.type = OutputType::ExtOut;
    output.target = routeId;
}

} // namespace resostage
