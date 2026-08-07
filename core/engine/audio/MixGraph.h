// The mixer, as data.
//
// Everything that can carry audio in a ResoStage project -- a track, the
// metronome, an aux send, the FOH master, a physical output lane -- is the
// SAME thing here: a MixStrip with a channel count, a fader, a pan, a mute, a
// solo and a resolved audibility. There is no "the master is special" branch,
// no "the click has its own gain path", no parallel arrays of bus indices.
// That symmetry is the entire point of this file: the old routing spread the
// same four rules across AudioEngineRouting.cpp, the render callback and
// refreshClickState(), and every one of those copies drifted -- which is why
// Mute/mono/balance/gain worked on tracks and silently did nothing on Main.
//
// A MixGraph is a DAG, flattened into two arrays:
//
//   strips  topologically ordered: sources (tracks, click), then busses
//           (sends, then main), then one output lane per physical channel.
//           Processing them front-to-back is therefore always legal.
//   edges   (from -> to) with a send level. Ordered by destination, and a
//           destination always sits later in `strips` than its sources.
//
// Signal model, identical for every strip:
//
//   pre    everything routed into it (for a track/click: the decoded audio)
//   post   pre * fader * pan, with a mono fold first when channels == 1
//   meter  reads post -- so gain, pan and mixed-in sends all show, and mute
//          or someone else's solo never does (that is what happens to the
//          signal AFTER this strip, not on it)
//   out    post if audible, silence otherwise; pre-fader sends read `pre`
//
// Nothing in here knows about JUCE, devices or real time, so the exact rules
// the audio thread runs are unit-testable headlessly -- see
// core/tests/test_mix_graph.cpp.
#pragma once

#include "../project/ProjectSchema.h"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace resostage {

// Which strips silence each other when one of them is soloed. Solo is always
// scoped to a group: soloing a track must not mute the aux sends carrying it
// to the drummer's in-ears, and soloing an aux must not mute the tracks.
enum class SoloGroup : uint8_t {
    // Project tracks + the metronome. One group on purpose: soloing a track
    // during a show is "let me hear this against the click", not "kill the click".
    Sources,
    // Aux / monitor / FX sends, independent of Sources.
    Sends,
    // FOH master. A group of one today, so solo on it is inert -- kept as a
    // real group anyway so that adding a second master later is a data
    // change, not another special case in the render path.
    Main,
    // Physical output lanes: owned by the device, not authorable, never soloed.
    None,
};

enum class StripKind : uint8_t {
    Track,
    Click,
    Send,
    Main,
    // One per physical output channel. Always mono -- a "stereo output" is a
    // pair of these, which is what makes an arbitrary channel map (Main on
    // 1/2, a mono wedge send on 11, a stereo IEM on 13/14) expressible
    // without inventing stereo-pair bus objects.
    OutputLane,
};

struct MixStrip {
    std::string id; // "audio::track:1", "audio::send:2", "audio::main", "audio::out:11"
    std::string name;
    StripKind kind = StripKind::Track;
    SoloGroup soloGroup = SoloGroup::None;

    int channels = 2;        // 1 = fold L+R to mono before pan
    float gainLinear = 1.0f; // fader, already converted from dB
    float pan = 0.0f;        // -1..+1 balance law

    bool mute = false;
    bool solo = false;
    // Resolved from mute + solo + "is anyone soloed in my group". The render
    // path reads only this, never re-derives it.
    bool audible = true;

    // OutputLane only: 0-based device channel, or -1 for a "shadow" lane --
    // an id the project still references whose physical channel is currently
    // gone (device unplugged, channel switched off). Shadow lanes stay in the
    // graph so routing ids never dangle; they simply swallow their input and
    // re-attach automatically when the channel comes back, because the lane
    // id is derived from the channel number.
    int physicalChannel = -1;

    // Index into the project's own tracks/sends vector, so callers can line
    // meters and telemetry up with project rows without re-parsing ids.
    // Meaningless for Main/OutputLane.
    uint32_t projectIndex = 0;
};

struct MixEdge {
    uint32_t from = 0;
    uint32_t to = 0;
    // Send level (1.0 for a plain main route). The source's own fader and pan
    // are NOT in here -- they were already applied once when `from` was
    // processed, which is exactly why the meter and the mix can never disagree.
    float gainLinear = 1.0f;
    // Pre-fader sends read the source's `pre` buffer and ignore its fader and
    // its mute -- a monitor mix the performer keeps hearing when FOH mutes them.
    bool preFader = false;
    // Which source channel feeds a ONE-channel destination:
    //   -1  sum L+R (a single mono lane, or a mono collapse)
    //    0  left only, 1 right only
    // This is what routes a stereo strip into a PAIR of mono lanes as true
    // stereo (L to the first, R to the second) instead of collapsing it.
    // Ignored when the destination has 2 channels.
    int8_t sourceChannel = -1;
    // Resolved audibility of this edge: false when the source is muted or
    // silenced by someone else's solo. Pre-fader edges ignore mute but still
    // respect solo. Inactive edges are skipped entirely on the audio thread.
    bool active = true;
};

// The device side of the graph -- everything buildMixGraph needs to know
// about the sound card, with no JUCE types involved.
struct OutputLaneConfig {
    // Channels the device exposes.
    int totalChannels = 2;
    // Per-channel enable, as configured in Settings. Empty = "nothing
    // configured yet", i.e. treat every device channel as active.
    std::vector<bool> active;

    bool isActive(int channel) const;
};

struct MixGraph {
    std::vector<MixStrip> strips;
    std::vector<MixEdge> edges;

    // Section boundaries in `strips` (sources < busses < lanes).
    uint32_t firstBusStrip = 0;
    uint32_t firstLaneStrip = 0;

    std::unordered_map<std::string, uint32_t> indexById;

    // Returns the strip index for `id`, or kNoStrip.
    static constexpr uint32_t kNoStrip = 0xFFFFFFFFu;
    uint32_t find(const std::string& id) const;

    // True when at least one strip in the group is soloed -- the thing that
    // makes every OTHER strip in that group look and sound muted. Published
    // to the SPA so a strip can be drawn dimmed without the frontend
    // re-implementing the rule.
    bool anySoloIn(SoloGroup group) const;
};

// Builds the whole graph from project data + the current device channel map.
// Pure: same inputs, same graph, no allocation-free guarantees needed because
// this only ever runs on the message thread (the result is then published to
// the audio thread through RoutingEngine).
MixGraph buildMixGraph(const Project& project, const OutputLaneConfig& outputs);

// Wire name for a strip kind: "track" | "click" | "send" | "main" | "output".
const char* stripKindName(StripKind kind);

// Wire name for a solo group. Published per mixer row so the SPA can grey out
// exactly the strips the engine is silencing, instead of re-deriving the
// grouping rule (and drifting from it) in TypeScript.
// "sources" | "sends" | "main" | "none".
const char* soloGroupName(SoloGroup group);

// Canonical lane id for a 0-based physical channel: channel 0 -> "audio::out:1".
// Lane ids are 1-based so nothing in the UI ever shows a zero-based output.
std::string outputLaneId(int physicalChannel0Based);

// Inverse of outputLaneId; returns -1 when `id` is not a lane id.
int outputLaneChannel(const std::string& id);

} // namespace resostage
