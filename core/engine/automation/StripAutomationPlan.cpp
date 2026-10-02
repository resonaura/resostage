/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "StripAutomationPlan.h"

#include "AutomationEvaluator.h"
#include "audio/graph/MixGraph.h"
#include "audio/graph/MixRenderer.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace resostage {

std::shared_ptr<const StripAutomationPlan> StripAutomationPlan::prepare(
    const Project& project, const MixGraph& graph, std::string& error) {
    error.clear();
    if (project.songs.size() > kMaximumSongs) {
        error = "Strip automation exceeds the prepared song limit";
        return nullptr;
    }
    auto plan = std::make_shared<StripAutomationPlan>();
    plan->songs.resize(project.songs.size());
    size_t admittedLanes = 0;
    size_t admittedPoints = 0;
    std::vector<uint8_t> boundParameters(graph.strips.size());
    std::vector<bool> boundEdges(graph.edges.size(), false);
    for (size_t songIndex = 0; songIndex < project.songs.size(); ++songIndex) {
        std::fill(boundParameters.begin(), boundParameters.end(), uint8_t{0});
        std::fill(boundEdges.begin(), boundEdges.end(), false);
        auto& bindings = plan->songs[songIndex].lanes;
        for (const auto& lane : project.songs[songIndex].automationLanes) {
            if (lane.target.domain != AutomationDomain::Strip
                || lane.scope != AutomationScope::Track || !lane.enabled
                || lane.muted || lane.points.empty())
                continue;
            Parameter parameter;
            uint8_t mask = 0;
            uint32_t targetEdgeIndex = 0;
            if (lane.target.parameterId == "faderGainDb") {
                parameter = Parameter::GainDb;
                mask = 1;
            } else if (lane.target.parameterId == "pan") {
                parameter = Parameter::Pan;
                mask = 2;
            } else if (lane.target.parameterId == "mute") {
                parameter = Parameter::Mute;
                mask = 4;
            } else if (lane.target.parameterId.rfind("send:", 0) == 0) {
                parameter = Parameter::SendGain;
            } else {
                continue;
            }
            const uint32_t stripIndex = graph.find(lane.target.entityId);
            if (stripIndex == MixGraph::kNoStrip
                || graph.strips[stripIndex].kind == StripKind::OutputLane)
                continue; // An unbound lane stays in the project, never retargeted.

            if (parameter == Parameter::SendGain) {
                std::string targetBusId;
                const std::string sendRef = lane.target.parameterId.substr(5);
                const bool isIndex = !sendRef.empty()
                    && std::all_of(sendRef.begin(), sendRef.end(), ::isdigit);
                if (graph.strips[stripIndex].kind == StripKind::Track
                    && graph.strips[stripIndex].projectIndex < project.tracks.size()) {
                    const auto& trackDef = project.tracks[graph.strips[stripIndex].projectIndex];
                    if (isIndex) {
                        const size_t sIdx = std::stoul(sendRef);
                        if (sIdx < trackDef.output.sends.size())
                            targetBusId = trackDef.output.sends[sIdx].bus;
                    } else {
                        targetBusId = sendRef;
                    }
                } else if (graph.strips[stripIndex].kind == StripKind::Click) {
                    if (isIndex) {
                        const size_t sIdx = std::stoul(sendRef);
                        if (sIdx < project.click.output.sends.size())
                            targetBusId = project.click.output.sends[sIdx].bus;
                    } else {
                        targetBusId = sendRef;
                    }
                }
                if (targetBusId.empty())
                    continue;
                const uint32_t toStrip = graph.find(targetBusId);
                if (toStrip == MixGraph::kNoStrip)
                    continue;
                bool foundEdge = false;
                for (size_t e = 0; e < graph.edges.size(); ++e) {
                    if (graph.edges[e].from == stripIndex && graph.edges[e].to == toStrip) {
                        targetEdgeIndex = static_cast<uint32_t>(e);
                        foundEdge = true;
                        break;
                    }
                }
                if (!foundEdge)
                    continue;
                if (boundEdges[targetEdgeIndex])
                    continue; // First enabled non-empty matching edge lane wins.
            } else {
                if ((boundParameters[stripIndex] & mask) != 0)
                    continue; // First enabled non-empty matching track lane wins.
            }
            if (admittedLanes == kMaximumLanes
                || lane.points.size() > kMaximumPoints - admittedPoints) {
                error = "Strip automation exceeds the prepared envelope budget";
                return nullptr;
            }
            if (!std::isfinite(lane.target.minValue)
                || !std::isfinite(lane.target.maxValue)
                || lane.target.maxValue < lane.target.minValue) {
                error = "Strip automation has an invalid parameter range";
                return nullptr;
            }
            double previousBeat = -std::numeric_limits<double>::infinity();
            for (const auto& point : lane.points) {
                if (!std::isfinite(point.timeBeats) || point.timeBeats < 0.0
                    || point.timeBeats <= previousBeat || !std::isfinite(point.value)
                    || !std::isfinite(point.curve) || std::abs(point.curve) > 1.0f) {
                    error = "Strip automation has invalid or unordered envelope points";
                    return nullptr;
                }
                previousBeat = point.timeBeats;
            }
            bindings.push_back({stripIndex, targetEdgeIndex, parameter, lane.target.minValue,
                                lane.target.maxValue, lane.points});
            if (parameter == Parameter::SendGain) {
                boundEdges[targetEdgeIndex] = true;
            } else {
                boundParameters[stripIndex] |= mask;
            }
            ++admittedLanes;
            admittedPoints += lane.points.size();
        }
    }
    return plan;
}

void StripAutomationPlan::apply(size_t songIndex, double segmentBeat,
                                MixRenderer& renderer) const noexcept {
    if (songIndex >= songs.size() || !std::isfinite(segmentBeat))
        return;
    for (const auto& binding : songs[songIndex].lanes) {
        const float value = std::clamp(
            AutomationEvaluator::evaluatePoints(binding.points, segmentBeat),
            binding.minValue, binding.maxValue);
        if (binding.parameter == Parameter::GainDb) {
            // A second physical bound prevents a damaged imported target
            // range from producing an infinite coefficient or unsafe gain.
            const float gain = std::pow(10.0f, std::clamp(value, -144.0f, 36.0f) / 20.0f);
            renderer.setAutomationGain(binding.stripIndex, gain);
        } else if (binding.parameter == Parameter::Pan) {
            renderer.setAutomationPan(binding.stripIndex, std::clamp(value, -1.0f, 1.0f));
        } else if (binding.parameter == Parameter::Mute) {
            renderer.setAutomationMute(binding.stripIndex, value >= 0.5f);
        } else if (binding.parameter == Parameter::SendGain) {
            renderer.setAutomationEdgeGain(binding.edgeIndex, std::clamp(value, 0.0f, 10.0f));
        }
    }
}

size_t StripAutomationPlan::bindingCount(size_t songIndex) const noexcept {
    return songIndex < songs.size() ? songs[songIndex].lanes.size() : 0;
}

} // namespace resostage
