#include "MixGraph.h"

#include "MixMath.h"

#include <algorithm>
#include <string_view>

namespace resostage {

namespace {

using mix_math::dbToGain;

float clampPan(double pan) {
    return static_cast<float>(std::clamp(pan, -1.0, 1.0));
}

int clampChannels(int channels) {
    return channels <= 1 ? 1 : 2;
}

float sendLevelToGain(double level) {
    return static_cast<float>(std::clamp(level, 0.0, 100.0) / 100.0);
}

// Splits an ext-out target ("audio::out:3,audio::out:4") into its lane ids.
// A target is always a list of MONO lanes -- one for a mono destination, two
// for a stereo pair. Anything unparseable yields an empty list, which the
// caller treats as "not routed anywhere", never as "guess a channel".
std::vector<std::string> splitLaneIds(const std::string& target) {
    std::vector<std::string> lanes;
    std::size_t pos = 0;
    while (pos <= target.size()) {
        const std::size_t end = target.find(',', pos);
        std::string token =
            target.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
        pos = (end == std::string::npos) ? target.size() + 1 : end + 1;
        if (outputLaneChannel(token) >= 0)
            lanes.push_back(std::move(token));
        if (end == std::string::npos)
            break;
    }
    return lanes;
}

// Every lane id the project references, in any routing slot. Used to keep a
// shadow lane alive for a channel the device isn't currently offering.
void collectReferencedLanes(const Project& project, std::vector<std::string>& out) {
    const auto addTarget = [&out](const std::optional<std::string>& target) {
        if (!target.has_value())
            return;
        for (auto& lane : splitLaneIds(*target))
            out.push_back(std::move(lane));
    };

    for (const TrackDef& track : project.tracks)
        addTarget(track.output.target);
    addTarget(project.click.output.target);
    addTarget(project.main.output.target);
    for (const SendBus& send : project.sends)
        addTarget(send.output.target);
}

} // namespace

bool OutputLaneConfig::isActive(int channel) const {
    if (channel < 0 || channel >= totalChannels)
        return false;
    // Nothing configured yet: assume every channel the device offers is live.
    if (active.empty())
        return true;
    return channel < static_cast<int>(active.size()) && active[static_cast<size_t>(channel)];
}

const char* soloGroupName(SoloGroup group) {
    switch (group) {
        case SoloGroup::Sources: return "sources";
        case SoloGroup::Sends: return "sends";
        case SoloGroup::Main: return "main";
        case SoloGroup::None: return "none";
    }
    return "none";
}

std::string outputLaneId(int physicalChannel0Based) {
    return "audio::out:" + std::to_string(physicalChannel0Based + 1);
}

int outputLaneChannel(const std::string& id) {
    constexpr std::string_view kPrefix = "audio::out:";
    if (id.size() <= kPrefix.size() || id.compare(0, kPrefix.size(), kPrefix) != 0)
        return -1;
    int channel = 0;
    for (std::size_t i = kPrefix.size(); i < id.size(); ++i) {
        const char c = id[i];
        if (c < '0' || c > '9')
            return -1;
        channel = channel * 10 + (c - '0');
        if (channel > 4096) // absurd channel number; treat as malformed
            return -1;
    }
    return channel >= 1 ? channel - 1 : -1;
}

uint32_t MixGraph::find(const std::string& id) const {
    const auto it = indexById.find(id);
    return it == indexById.end() ? kNoStrip : it->second;
}

bool MixGraph::anySoloIn(SoloGroup group) const {
    for (const MixStrip& strip : strips)
        if (strip.soloGroup == group && strip.solo)
            return true;
    return false;
}

MixGraph buildMixGraph(const Project& project, const OutputLaneConfig& outputs) {
    MixGraph graph;

    const auto addStrip = [&graph](MixStrip strip) -> uint32_t {
        const auto index = static_cast<uint32_t>(graph.strips.size());
        graph.indexById[strip.id] = index;
        graph.strips.push_back(std::move(strip));
        return index;
    };

    // ── Sources: tracks, then the metronome ─────────────────────────────────
    // The click is deliberately the last source rather than a thing off to the
    // side: it shares the Sources solo group, the same fader/pan/mono law and
    // the same meter path as a track, because to the mixer it IS a track that
    // happens to be generated instead of streamed.
    for (uint32_t i = 0; i < project.tracks.size(); ++i) {
        const TrackDef& track = project.tracks[i];
        MixStrip strip;
        strip.id = track.id;
        strip.name = track.name;
        strip.kind = StripKind::Track;
        strip.soloGroup = SoloGroup::Sources;
        strip.channels = clampChannels(track.channels);
        strip.gainLinear = dbToGain(track.gainDb);
        strip.pan = clampPan(track.pan);
        strip.mute = track.mute;
        strip.solo = track.solo;
        strip.projectIndex = i;
        addStrip(std::move(strip));
    }

    const uint32_t clickStrip = [&] {
        MixStrip strip;
        strip.id = "audio::click";
        strip.name = project.click.name;
        strip.kind = StripKind::Click;
        strip.soloGroup = SoloGroup::Sources;
        strip.channels = clampChannels(project.click.channels);
        strip.gainLinear = dbToGain(project.click.gainDb);
        strip.pan = clampPan(project.click.pan);
        // "Metronome off" is a mute, not a separate concept -- so a disabled
        // click still meters (you can see the beat you are about to unmute)
        // and still feeds nothing, through the one audibility rule.
        strip.mute = project.click.mute || !project.click.enabled;
        strip.solo = project.click.solo;
        return addStrip(std::move(strip));
    }();

    // ── Busses: sends, then main ────────────────────────────────────────────
    graph.firstBusStrip = static_cast<uint32_t>(graph.strips.size());

    for (uint32_t i = 0; i < project.sends.size(); ++i) {
        const SendBus& send = project.sends[i];
        MixStrip strip;
        strip.id = send.id;
        strip.name = send.name;
        strip.kind = StripKind::Send;
        strip.soloGroup = SoloGroup::Sends;
        strip.channels = clampChannels(send.channels);
        strip.gainLinear = dbToGain(send.gainDb);
        strip.pan = clampPan(send.pan);
        strip.mute = send.mute;
        strip.solo = send.solo;
        strip.projectIndex = i;
        addStrip(std::move(strip));
    }

    const uint32_t mainStrip = [&] {
        MixStrip strip;
        strip.id = "audio::main";
        strip.name = project.main.name;
        strip.kind = StripKind::Main;
        strip.soloGroup = SoloGroup::Main;
        strip.channels = clampChannels(project.main.channels);
        strip.gainLinear = dbToGain(project.main.gainDb);
        strip.pan = clampPan(project.main.pan);
        strip.mute = project.main.mute || !project.main.enabled;
        strip.solo = project.main.solo;
        return addStrip(std::move(strip));
    }();

    // ── Output lanes: one mono strip per physical channel ───────────────────
    graph.firstLaneStrip = static_cast<uint32_t>(graph.strips.size());

    const auto addLane = [&](int physicalChannel, bool available) {
        const std::string id = outputLaneId(physicalChannel);
        if (graph.indexById.count(id) != 0)
            return;
        MixStrip strip;
        strip.id = id;
        strip.name = "Out " + std::to_string(physicalChannel + 1);
        strip.kind = StripKind::OutputLane;
        strip.soloGroup = SoloGroup::None;
        strip.channels = 1;
        strip.physicalChannel = available ? physicalChannel : -1;
        addStrip(std::move(strip));
    };

    for (int channel = 0; channel < outputs.totalChannels; ++channel)
        if (outputs.isActive(channel))
            addLane(channel, /*available=*/true);

    // Shadow lanes for channels the project still points at. Without these a
    // project authored on a 16-out interface would lose its routing the
    // moment it opened on a laptop's built-in stereo out.
    {
        std::vector<std::string> referenced;
        collectReferencedLanes(project, referenced);
        std::sort(referenced.begin(), referenced.end());
        referenced.erase(std::unique(referenced.begin(), referenced.end()), referenced.end());
        for (const std::string& laneId : referenced) {
            const int channel = outputLaneChannel(laneId);
            // A channel the owner explicitly switched OFF in Settings is not a
            // temporary device drop -- do not resurrect it as a lane.
            if (channel < 0 || (channel < outputs.totalChannels && !outputs.isActive(channel)))
                continue;
            addLane(channel, /*available=*/false);
        }
    }

    // ── Audibility, once, for every strip ───────────────────────────────────
    const bool soloInSources = graph.anySoloIn(SoloGroup::Sources);
    const bool soloInSends = graph.anySoloIn(SoloGroup::Sends);
    const bool soloInMain = graph.anySoloIn(SoloGroup::Main);
    const auto anySoloFor = [&](SoloGroup group) {
        switch (group) {
            case SoloGroup::Sources: return soloInSources;
            case SoloGroup::Sends: return soloInSends;
            case SoloGroup::Main: return soloInMain;
            case SoloGroup::None: return false;
        }
        return false;
    };
    for (MixStrip& strip : graph.strips) {
        if (strip.mute)
            strip.audible = false;
        else if (anySoloFor(strip.soloGroup) && !strip.solo)
            strip.audible = false;
        else
            strip.audible = true;
    }

    // ── Edges ───────────────────────────────────────────────────────────────
    const auto edgeActive = [&](uint32_t from, bool preFader) {
        const MixStrip& source = graph.strips[from];
        // Pre-fader ignores the source's own mute but still respects solo:
        // muting a channel at FOH should not take it out of the performer's
        // monitor mix, but soloing something else should.
        if (preFader)
            return !(anySoloFor(source.soloGroup) && !source.solo);
        return source.audible;
    };

    const auto addEdge = [&](uint32_t from, uint32_t to, float gain, bool preFader,
                             int8_t sourceChannel) {
        if (from == MixGraph::kNoStrip || to == MixGraph::kNoStrip)
            return;
        MixEdge edge;
        edge.from = from;
        edge.to = to;
        edge.gainLinear = gain;
        edge.preFader = preFader;
        edge.sourceChannel = sourceChannel;
        edge.active = edgeActive(from, preFader);
        graph.edges.push_back(edge);
    };

    // Routes a strip into an ext-out target. Two lanes carry true stereo (L to
    // the first, R to the second); one lane sums. This is the ONLY place that
    // decides how a strip meets physical channels -- tracks, sends, the click
    // and Main all come through here.
    const auto addExtOutEdges = [&](uint32_t from, const std::optional<std::string>& target,
                                    float gain, bool preFader) {
        if (!target.has_value())
            return;
        const std::vector<std::string> lanes = splitLaneIds(*target);
        for (std::size_t i = 0; i < lanes.size(); ++i) {
            const int8_t sourceChannel =
                lanes.size() >= 2 ? static_cast<int8_t>(i == 0 ? 0 : 1) : static_cast<int8_t>(-1);
            addEdge(from, graph.find(lanes[i]), gain, preFader, sourceChannel);
        }
    };

    // A source's main route + its aux sends. Identical for tracks and click.
    const auto addSourceEdges = [&](uint32_t from, const SourceOutput& output) {
        switch (output.type) {
            case OutputType::Main:
                addEdge(from, mainStrip, 1.0f, /*preFader=*/false, /*sourceChannel=*/-1);
                break;
            case OutputType::ExtOut:
                addExtOutEdges(from, output.target, 1.0f, /*preFader=*/false);
                break;
            case OutputType::SendsOnly:
                break; // audible only through the send rows below
        }
        for (const SendConfig& send : output.sends) {
            if (!send.enabled)
                continue;
            addEdge(from, graph.find(send.bus), sendLevelToGain(send.level), send.preFader,
                    /*sourceChannel=*/-1);
        }
    };

    for (uint32_t i = 0; i < project.tracks.size(); ++i)
        addSourceEdges(i, project.tracks[i].output);
    addSourceEdges(clickStrip, project.click.output);

    // A bus either folds into Main (inheriting Main's fader/pan/mute -- the
    // "same outs as Main" routing) or owns physical channels outright. It
    // never fans out to further sends: send -> send would be a cycle waiting
    // to happen, and the schema has no way to express it.
    for (uint32_t i = 0; i < project.sends.size(); ++i) {
        const SendBus& send = project.sends[i];
        const uint32_t from = graph.firstBusStrip + i;
        switch (send.output.type) {
            case OutputType::Main:
                addEdge(from, mainStrip, 1.0f, /*preFader=*/false, /*sourceChannel=*/-1);
                break;
            case OutputType::ExtOut:
                addExtOutEdges(from, send.output.target, 1.0f, /*preFader=*/false);
                break;
            case OutputType::SendsOnly:
                break; // not a valid bus destination; renders silent
        }
    }

    // Main always owns its physical channels; it is the one strip that can
    // never fold into anything else.
    addExtOutEdges(mainStrip, project.main.output.target, 1.0f, /*preFader=*/false);

    // Group edges by destination so the render pass can walk strips and edges
    // together in one forward sweep. Legal because the strip ordering above
    // guarantees `from < to` for every edge -- sources come before busses,
    // busses before lanes, and nothing routes backwards.
    std::stable_sort(graph.edges.begin(), graph.edges.end(),
                     [](const MixEdge& a, const MixEdge& b) { return a.to < b.to; });

    return graph;
}

} // namespace resostage
