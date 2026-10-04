/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "MixGraph.h"

#include "MixMath.h"

#include <algorithm>
#include <functional>
#include <queue>
#include <string_view>

namespace resostage {

namespace {

using mix_math::dbToGain;

constexpr uint64_t kFnvOffset = 14695981039346656037ull;
constexpr uint64_t kFnvPrime = 1099511628211ull;

void hashBytes(uint64_t& hash, std::string_view value) {
    for (const unsigned char byte : value) {
        hash ^= byte;
        hash *= kFnvPrime;
    }
    hash ^= 0xffu; // field delimiter
    hash *= kFnvPrime;
}

void hashByte(uint64_t& hash, uint8_t value) {
    hash ^= value;
    hash *= kFnvPrime;
}

void hashU32(uint64_t& hash, uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8)
        hashByte(hash, static_cast<uint8_t>((value >> shift) & 0xffu));
}

void hashU64(uint64_t& hash, uint64_t value) {
    for (int shift = 0; shift < 64; shift += 8)
        hashByte(hash, static_cast<uint8_t>((value >> shift) & 0xffu));
}

void hashSlots(uint64_t& hash, const std::vector<PluginSlot>& slots) {
    hashByte(hash, static_cast<uint8_t>(std::min<size_t>(slots.size(), 255)));
    for (const auto& slot : slots) {
        hashBytes(hash, slot.id);
        hashBytes(hash, slot.plugin.identifier);
        hashByte(hash, slot.plugin.instrument ? 1u : 0u);
        hashByte(hash, slot.stateResource.has_value() ? 1u : 0u);
        if (slot.stateResource.has_value())
            hashBytes(hash, *slot.stateResource);
        hashByte(hash, slot.sidechain.has_value() ? 1u : 0u);
        if (slot.sidechain.has_value()) {
            hashU32(hash, slot.sidechain->inputBusIndex);
        }
    }
}

uint64_t processorLayoutKey(const Project& project, const MixGraph& graph) {
    uint64_t hash = kFnvOffset;
    // Processor tables are indexed by the published graph, but changing only
    // a sidechain source may topologically reorder strips. Hash each chain in
    // stable project order and include its current graph index: a route edit
    // that changes order must rebuild the lightweight processor table, while
    // PluginProcessorBank may still reuse each unchanged chain/helper by ID.
    // The input-bus index remains in hashSlots because it changes the
    // processor's prepared bus layout.
    const auto hashChain = [&hash](const MixGraph& graph, const std::string& id,
                                   StripKind kind,
                                   const std::vector<PluginSlot>& slots) {
        hashBytes(hash, id);
        hashByte(hash, static_cast<uint8_t>(kind));
        hashU32(hash, graph.find(id));
        hashSlots(hash, slots);
    };
    for (const auto& track : project.tracks)
        hashChain(graph, track.id, StripKind::Track, track.plugins);
    hashChain(graph, "audio::click", StripKind::Click, project.click.plugins);
    for (const auto& send : project.sends)
        hashChain(graph, send.id, StripKind::Send, send.plugins);
    hashChain(graph, "audio::main", StripKind::Main, project.main.plugins);
    return hash;
}

uint64_t routingLayoutKey(const MixGraph& graph) {
    uint64_t hash = kFnvOffset;
    for (const auto& strip : graph.strips) {
        hashBytes(hash, strip.id);
        hashByte(hash, static_cast<uint8_t>(strip.kind));
    }
    for (const auto& edge : graph.edges) {
        hashU32(hash, edge.from);
        hashU32(hash, edge.to);
        hashU32(hash, edge.sendIndex);
        hashByte(hash, static_cast<uint8_t>(edge.tap));
        hashByte(hash, static_cast<uint8_t>(edge.sourceChannel));
    }
    for (const auto& edge : graph.sidechainEdges) {
        hashU32(hash, edge.from);
        hashU32(hash, edge.to);
        hashU32(hash, edge.pluginSlotIndex);
        hashBytes(hash, edge.pluginSlotId);
        hashU32(hash, edge.inputBusIndex);
        hashByte(hash, static_cast<uint8_t>(edge.channelMode));
    }
    return hash;
}

const std::vector<PluginSlot>* pluginSlotsForStrip(
    const Project& project, const MixStrip& strip) {
    switch (strip.kind) {
        case StripKind::Track:
            return strip.projectIndex < project.tracks.size()
                ? &project.tracks[strip.projectIndex].plugins : nullptr;
        case StripKind::Click:
            return &project.click.plugins;
        case StripKind::Send:
            return strip.projectIndex < project.sends.size()
                ? &project.sends[strip.projectIndex].plugins : nullptr;
        case StripKind::Main:
            return &project.main.plugins;
        case StripKind::OutputLane:
            return nullptr;
    }
    return nullptr;
}

bool hasPath(const std::vector<std::vector<uint32_t>>& adjacency,
             uint32_t start, uint32_t target) {
    if (start >= adjacency.size() || target >= adjacency.size())
        return false;
    std::vector<uint8_t> visited(adjacency.size(), 0);
    std::vector<uint32_t> pending{start};
    visited[start] = 1;
    while (!pending.empty()) {
        const uint32_t current = pending.back();
        pending.pop_back();
        if (current == target)
            return true;
        for (const uint32_t next : adjacency[current]) {
            if (next >= adjacency.size() || visited[next] != 0)
                continue;
            visited[next] = 1;
            pending.push_back(next);
        }
    }
    return false;
}

void orderStripsTopologically(MixGraph& graph, uint32_t processableCount) {
    if (graph.sidechainEdges.empty()
        || std::all_of(graph.sidechainEdges.begin(), graph.sidechainEdges.end(),
                       [](const MixSidechainEdge& edge) {
                           return edge.from < edge.to;
                       }))
        return;
    const size_t count = graph.strips.size();
    std::vector<std::vector<uint32_t>> adjacency(processableCount);
    std::vector<uint32_t> indegree(processableCount, 0);
    const auto addDependency = [&adjacency, &indegree, processableCount](
                                  uint32_t from, uint32_t to) {
        if (from >= processableCount || to >= processableCount)
            return;
        adjacency[from].push_back(to);
        ++indegree[to];
    };
    for (const auto& edge : graph.edges)
        addDependency(edge.from, edge.to);
    for (const auto& edge : graph.sidechainEdges)
        addDependency(edge.from, edge.to);

    // The original strip order is the stable tie-breaker. Projects without
    // sidechains therefore retain their exact historical processing order.
    std::priority_queue<uint32_t, std::vector<uint32_t>, std::greater<>> ready;
    for (uint32_t index = 0; index < processableCount; ++index)
        if (indegree[index] == 0)
            ready.push(index);

    std::vector<uint32_t> oldOrder;
    oldOrder.reserve(count);
    while (!ready.empty()) {
        const uint32_t current = ready.top();
        ready.pop();
        oldOrder.push_back(current);
        for (const uint32_t next : adjacency[current])
            if (--indegree[next] == 0)
                ready.push(next);
    }
    if (oldOrder.size() != processableCount)
        return; // Defensive: invalid cycles never replace the last-safe order.
    for (uint32_t index = processableCount; index < count; ++index)
        oldOrder.push_back(index);

    std::vector<uint32_t> remap(count, MixGraph::kNoStrip);
    std::vector<MixStrip> reordered;
    reordered.reserve(count);
    for (uint32_t next = 0; next < oldOrder.size(); ++next) {
        const uint32_t old = oldOrder[next];
        remap[old] = next;
        reordered.push_back(std::move(graph.strips[old]));
    }
    graph.strips = std::move(reordered);
    graph.indexById.clear();
    graph.indexById.reserve(graph.strips.size());
    for (uint32_t index = 0; index < graph.strips.size(); ++index)
        graph.indexById.emplace(graph.strips[index].id, index);
    for (auto& edge : graph.edges) {
        edge.from = remap[edge.from];
        edge.to = remap[edge.to];
    }
    std::stable_sort(graph.edges.begin(), graph.edges.end(),
                     [](const MixEdge& left, const MixEdge& right) {
                         return left.to < right.to;
                     });
    for (auto& edge : graph.sidechainEdges) {
        edge.from = remap[edge.from];
        edge.to = remap[edge.to];
    }
    std::stable_sort(graph.sidechainEdges.begin(), graph.sidechainEdges.end(),
                     [](const MixSidechainEdge& left,
                        const MixSidechainEdge& right) {
                         if (left.to != right.to)
                             return left.to < right.to;
                         return left.pluginSlotIndex < right.pluginSlotIndex;
                     });
    graph.firstLaneStrip = processableCount;
}

uint64_t latencyLayoutKey(const MixGraph& graph, uint64_t processorKey) {
    uint64_t hash = kFnvOffset;
    hashU64(hash, processorKey);
    hashU64(hash, graph.routingLayoutKey);
    return hash;
}

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

const char* stripKindName(StripKind kind) {
    switch (kind) {
        case StripKind::Track: return "track";
        case StripKind::Click: return "click";
        case StripKind::Send: return "send";
        case StripKind::Main: return "main";
        case StripKind::OutputLane: return "output";
    }
    return "track";
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
        strip.panLaw = track.panLaw;
        strip.mute = track.mute;
        strip.solo = track.solo;
        strip.soloSafe = track.soloSafe;
        strip.polarity = track.polarity;
        strip.trimLinear = dbToGain(track.inputTrimDb);
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
        // Enable controls whether the generator produces samples; mute remains
        // an independent strip/routing state. Count-in may temporarily render
        // the generator even while this project preference is off.
        strip.mute = project.click.mute;
        strip.solo = project.click.solo;
        strip.soloSafe = project.click.soloSafe;
        return addStrip(std::move(strip));
    }();

    // ── Busses: sends, then main ────────────────────────────────────────────

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
        strip.soloSafe = send.soloSafe;
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
        strip.soloSafe = project.main.soloSafe;
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
        else if (anySoloFor(strip.soloGroup) && !strip.solo && !strip.soloSafe)
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
            return !(anySoloFor(source.soloGroup) && !source.solo && !source.soloSafe);
        return source.audible;
    };

    const auto addEdge = [&](uint32_t from, uint32_t to, float gain, SendTap tap,
                             int8_t sourceChannel) {
        if (from == MixGraph::kNoStrip || to == MixGraph::kNoStrip)
            return;
        MixEdge edge;
        edge.from = from;
        edge.to = to;
        edge.gainLinear = gain;
        edge.tap = tap;
        edge.preFader = (tap == SendTap::PreFader);
        edge.sourceChannel = sourceChannel;
        edge.active = edgeActive(from, edge.preFader);
        graph.edges.push_back(edge);
    };

    // Routes a strip into an ext-out target. Two lanes carry true stereo (L to
    // the first, R to the second); one lane sums. This is the ONLY place that
    // decides how a strip meets physical channels -- tracks, sends, the click
    // and Main all come through here.
    const auto addExtOutEdges = [&](uint32_t from, const std::optional<std::string>& target,
                                    float gain, SendTap tap = SendTap::PostPan) {
        if (!target.has_value())
            return;
        const std::vector<std::string> lanes = splitLaneIds(*target);
        for (std::size_t i = 0; i < lanes.size(); ++i) {
            const int8_t sourceChannel =
                lanes.size() >= 2 ? static_cast<int8_t>(i == 0 ? 0 : 1) : static_cast<int8_t>(-1);
            addEdge(from, graph.find(lanes[i]), gain, tap, sourceChannel);
        }
    };

    // A source's main route + its aux sends. Identical for tracks and click.
    const auto addSourceEdges = [&](uint32_t from, const SourceOutput& output) {
        switch (output.type) {
            case OutputType::Main:
                addEdge(from, mainStrip, 1.0f, SendTap::PostPan, /*sourceChannel=*/-1);
                break;
            case OutputType::Bus:
                // Main route into an aux/group bus. Always forward (sources
                // precede busses in `strips`), so it cannot form a cycle.
                addEdge(from, graph.find(output.target.value_or("")), 1.0f,
                        SendTap::PostPan, /*sourceChannel=*/-1);
                break;
            case OutputType::ExtOut:
                addExtOutEdges(from, output.target, 1.0f, SendTap::PostPan);
                break;
            case OutputType::SendsOnly:
                break; // audible only through the send rows below
        }
        for (size_t sendIndex = 0; sendIndex < output.sends.size(); ++sendIndex) {
            const SendConfig& send = output.sends[sendIndex];
            if (!send.enabled)
                continue;
            const SendTap tap = send.tap != SendTap::PostPan ? send.tap : (send.preFader ? SendTap::PreFader : SendTap::PostPan);
            const size_t previousSize = graph.edges.size();
            addEdge(from, graph.find(send.bus), sendLevelToGain(send.level), tap,
                    /*sourceChannel=*/-1);
            if (graph.edges.size() != previousSize)
                graph.edges.back().sendIndex = static_cast<uint32_t>(sendIndex);
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
        const uint32_t from = graph.find(send.id);
        switch (send.output.type) {
            case OutputType::Main:
                addEdge(from, mainStrip, 1.0f, SendTap::PostPan, /*sourceChannel=*/-1);
                break;
            case OutputType::ExtOut:
                addExtOutEdges(from, send.output.target, 1.0f, SendTap::PostPan);
                break;
            case OutputType::Bus:
            case OutputType::SendsOnly:
                // Neither is a valid bus destination. Bus -> Bus is refused on
                // purpose: it is the one edge that could close a cycle, and a
                // feedback loop in a live rig is not a thing to discover on
                // stage. Renders silent.
                break;
        }
    }

    // Main always owns its physical channels; it is the one strip that can
    // never fold into anything else.
    addExtOutEdges(mainStrip, project.main.output.target, 1.0f, SendTap::PostPan);

    // Collect external plug-in inputs separately from the ordinary mix edges.
    // Invalid or stale project references are omitted from the realtime graph;
    // command-side validation reports the reason to the editor before commit.
    const uint32_t processableStripCount = graph.firstLaneStrip;
    std::vector<std::vector<uint32_t>> dependencyGraph(processableStripCount);
    for (const auto& edge : graph.edges)
        if (edge.from < processableStripCount && edge.to < processableStripCount)
            dependencyGraph[edge.from].push_back(edge.to);

    constexpr uint32_t kMaximumSidechainInputBusIndex = 32;
    for (uint32_t destination = 0; destination < processableStripCount;
         ++destination) {
        const auto* slots = pluginSlotsForStrip(project, graph.strips[destination]);
        if (slots == nullptr)
            continue;
        const size_t slotCount = std::min<size_t>(slots->size(), 128);
        uint32_t acceptedFeeds = 0;
        for (uint32_t slotIndex = 0; slotIndex < slotCount; ++slotIndex) {
            const PluginSlot& slot = (*slots)[slotIndex];
            if (!slot.sidechain.has_value() || slot.plugin.instrument
                || slot.plugin.identifier.empty()
                || slot.sidechain->sourceStripId.empty()
                || slot.sidechain->inputBusIndex == 0
                || slot.sidechain->inputBusIndex > kMaximumSidechainInputBusIndex)
                continue;
            const uint32_t source = graph.find(slot.sidechain->sourceStripId);
            if (source >= processableStripCount || source == destination
                || acceptedFeeds >= kMaximumSidechainFeedsPerStrip
                || hasPath(dependencyGraph, destination, source))
                continue;

            graph.sidechainEdges.push_back({
                source, destination, slotIndex, slot.sidechain->inputBusIndex,
                slot.sidechain->channelMode, graph.strips[source].audible,
                slot.id});
            dependencyGraph[source].push_back(destination);
            ++acceptedFeeds;
        }
    }

    // Both ordinary routes and sidechain routes form one dependency DAG for
    // processing order. Audio contributions remain distinct: sidechain edges
    // are never accumulated into the destination strip's normal pre buffer.
    orderStripsTopologically(graph, processableStripCount);

    // Group ordinary edges by destination so the render pass can walk strips
    // and edges together in one forward sweep.
    std::stable_sort(graph.edges.begin(), graph.edges.end(),
                     [](const MixEdge& a, const MixEdge& b) { return a.to < b.to; });

    graph.processorLayoutKey = processorLayoutKey(project, graph);
    graph.routingLayoutKey = routingLayoutKey(graph);
    graph.latencyLayoutKey = latencyLayoutKey(
        graph, graph.processorLayoutKey);
    return graph;
}

} // namespace resostage
