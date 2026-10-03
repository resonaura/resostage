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
#include <charconv>
#include <cmath>
#include <limits>
#include <string_view>

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
    const auto reportSkippedLane = [&error](const char* message) {
        if (error.empty()) error = message;
    };
    std::vector<uint8_t> boundParameters(graph.strips.size());
    std::vector<bool> boundEdges(graph.edges.size(), false);
    for (size_t songIndex = 0; songIndex < project.songs.size(); ++songIndex) {
        std::fill(boundParameters.begin(), boundParameters.end(), uint8_t{0});
        std::fill(boundEdges.begin(), boundEdges.end(), false);
        auto& bindings = plan->songs[songIndex].lanes;
        for (const auto& lane : project.songs[songIndex].automationLanes) {
            if (lane.target.domain != AutomationDomain::Strip
                || lane.scope != AutomationScope::Track || !lane.enabled
                || lane.muted || lane.points.empty()
                || lane.writeMode == AutomationWriteMode::Write)
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
                const std::string_view sendRef(lane.target.parameterId.data() + 5,
                                               lane.target.parameterId.size() - 5);
                const bool isIndex = !sendRef.empty()
                    && std::all_of(sendRef.begin(), sendRef.end(),
                        [](char character) { return character >= '0' && character <= '9'; });
                const std::vector<SendConfig>* sends = nullptr;
                if (graph.strips[stripIndex].kind == StripKind::Track
                    && graph.strips[stripIndex].projectIndex < project.tracks.size()) {
                    sends = &project.tracks[graph.strips[stripIndex].projectIndex].output.sends;
                } else if (graph.strips[stripIndex].kind == StripKind::Click) {
                    sends = &project.click.output.sends;
                }
                if (sends == nullptr || sendRef.empty())
                    continue;
                size_t targetSendIndex = sends->size();
                if (isIndex) {
                    const auto parsed = std::from_chars(sendRef.data(),
                        sendRef.data() + sendRef.size(), targetSendIndex);
                    if (parsed.ec != std::errc{}
                        || parsed.ptr != sendRef.data() + sendRef.size()
                        || targetSendIndex >= sends->size())
                        continue; // Malformed legacy indices are unbound, never exceptions.
                } else {
                    for (size_t index = 0; index < sends->size(); ++index) {
                        if (!(*sends)[index].enabled || (*sends)[index].bus != sendRef)
                            continue;
                        if (targetSendIndex != sends->size()) {
                            // A stable bus ID cannot distinguish duplicate taps. Preserve
                            // the lane unbound rather than changing an arbitrary send.
                            targetSendIndex = sends->size();
                            break;
                        }
                        targetSendIndex = index;
                    }
                }
                if (targetSendIndex >= sends->size() || !(*sends)[targetSendIndex].enabled)
                    continue;
                targetBusId = (*sends)[targetSendIndex].bus;
                const uint32_t toStrip = graph.find(targetBusId);
                if (toStrip == MixGraph::kNoStrip)
                    continue;
                bool foundEdge = false;
                for (size_t e = 0; e < graph.edges.size(); ++e) {
                    if (graph.edges[e].from == stripIndex && graph.edges[e].to == toStrip
                        && graph.edges[e].sendIndex == targetSendIndex) {
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
                reportSkippedLane("Strip automation exceeds the prepared envelope budget; excess lanes were skipped");
                continue;
            }
            if (!std::isfinite(lane.target.minValue)
                || !std::isfinite(lane.target.maxValue)
                || lane.target.maxValue < lane.target.minValue) {
                reportSkippedLane("Strip automation has an invalid parameter range; that lane was skipped");
                continue;
            }
            double previousBeat = -std::numeric_limits<double>::infinity();
            bool validPoints = true;
            for (const auto& point : lane.points) {
                if (!std::isfinite(point.timeBeats) || point.timeBeats < 0.0
                    || point.timeBeats <= previousBeat || !std::isfinite(point.value)
                    || !std::isfinite(point.curve) || std::abs(point.curve) > 1.0f) {
                    validPoints = false;
                    break;
                }
                previousBeat = point.timeBeats;
            }
            if (!validPoints) {
                reportSkippedLane("Strip automation has invalid or unordered envelope points; that lane was skipped");
                continue;
            }
            const size_t bindingIndex = bindings.size();
            bindings.push_back({lane.id, stripIndex, targetEdgeIndex, parameter, lane.target.minValue,
                                lane.target.maxValue, lane.points});
            if (parameter == Parameter::GainDb || parameter == Parameter::Pan)
                plan->songs[songIndex].controlValues.push_back(bindingIndex);
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
                                MixRenderer& renderer,
                                const std::unordered_set<std::string>* manualOverrides) const noexcept {
    visitValues(songIndex, segmentBeat, manualOverrides,
        [&renderer](const EvaluatedValue& evaluated) noexcept {
        if (evaluated.parameter == Parameter::GainDb) {
            // A second physical bound prevents a damaged imported target
            // range from producing an infinite coefficient or unsafe gain.
            const float gain = std::pow(10.0f,
                std::clamp(evaluated.value, -144.0f, 36.0f) / 20.0f);
            renderer.setAutomationGain(evaluated.stripIndex, gain);
        } else if (evaluated.parameter == Parameter::Pan) {
            renderer.setAutomationPan(evaluated.stripIndex,
                                      std::clamp(evaluated.value, -1.0f, 1.0f));
        } else if (evaluated.parameter == Parameter::Mute) {
            renderer.setAutomationMute(evaluated.stripIndex,
                                       evaluated.value >= 0.5f);
        } else if (evaluated.parameter == Parameter::SendGain) {
            renderer.setAutomationEdgeGain(evaluated.edgeIndex,
                std::clamp(evaluated.value, 0.0f, 10.0f));
        }
    });
}

size_t StripAutomationPlan::bindingCount(size_t songIndex) const noexcept {
    return songIndex < songs.size() ? songs[songIndex].lanes.size() : 0;
}

} // namespace resostage
