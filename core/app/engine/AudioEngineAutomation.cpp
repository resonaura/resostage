/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Block-rate automation evaluation and dispatch.
// Keep this work bounded and allocation-free: it is called from the audio
// transport path once per rendered block.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "automation/AutomationEvaluator.h"
#include "project/MidiRegionLoop.h"
#include "timing/OutputLatency.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <string_view>

namespace resostage {

void AudioEngine::dispatchAutomationForBlock(const SongDef& song,
                                             int64_t blockStartSample,
                                             int numSamples,
                                             double sampleRate,
                                             const MixGraph* graph,
                                             PluginProcessorBank* pluginBank,
                                             const TempoMap* tempoMap,
                                             uint64_t hostTimeNanos,
                                             double outputLatencySec) {
    if (song.automationLanes.empty() && song.midiRegions.empty() && song.regions.empty())
        return;

    const double safeRate = sampleRate > 0.0 ? sampleRate : 48000.0;
    const double blockStartSeconds = static_cast<double>(blockStartSample) / safeRate;
    const double blockStartBeat = tempoMap != nullptr
        ? tempoMap->samplesToBeats(blockStartSample, safeRate)
        : (blockStartSeconds * 2.0);

    // MIDI controller automation is stored as typed values (CC 0..127,
    // pitch bend -8192..8191), not always normalized floats. Keep parsing and
    // event construction allocation-free because this runs at block rate.
    const auto sendMidiAutomation = [&](const AutomationLane& lane, float value,
                                        std::string_view trackId) {
        if (lane.target.domain != AutomationDomain::MidiCC || numSamples <= 0)
            return;

        const std::string_view parameterId(lane.target.parameterId);
        const bool pitchBend = parameterId == "pitchBend" || parameterId == "pitch-bend";
        int controller = -1;
        if (!pitchBend) {
            std::string_view digits = parameterId;
            if (digits.starts_with("cc:")) digits.remove_prefix(3);
            else if (digits.starts_with("cc")) digits.remove_prefix(2);
            const auto parsed = std::from_chars(digits.data(), digits.data() + digits.size(), controller);
            if (digits.empty() || parsed.ec != std::errc{} || parsed.ptr != digits.data() + digits.size())
                return;
            controller = std::clamp(controller, 0, 127);
        }

        const float minValue = lane.target.minValue;
        const float maxValue = lane.target.maxValue;
        const bool normalized = maxValue <= minValue + 1.0e-6f;
        const float low = normalized ? 0.0f : minValue;
        const float high = normalized ? 1.0f : maxValue;
        const float typedValue = std::clamp(value, low, high);
        const float unit = (typedValue - low) / std::max(1.0e-6f, high - low);

        uint32_t stripIndex = MixGraph::kNoStrip;
        bool externalMidi = false;
        if (!trackId.empty()) {
            for (const auto& track : project().tracks) {
                if (track.id != trackId)
                    continue;
                externalMidi = track.kind == TrackKind::MIDI || track.kind == TrackKind::ExternalMIDI;
                if (graph != nullptr)
                    stripIndex = graph->find(track.effectiveStripId());
                break;
            }
        }
        if (pluginBank != nullptr && stripIndex != MixGraph::kNoStrip
            && pluginBank->stripHasInstrument(stripIndex)) {
            const auto message = pitchBend
                ? juce::MidiMessage::pitchWheel(1, std::clamp(
                    static_cast<int>(std::lround(unit * 16383.0f)), 0, 16383))
                : juce::MidiMessage::controllerEvent(1, controller,
                    std::clamp(static_cast<int>(std::lround(unit * 127.0f)), 0, 127));
            pluginBank->addStripMidiEvent(stripIndex, message, 0);
        }

        if (externalMidi) {
            MidiCommand command;
            command.targetHostTimeNanos = heardHostNanos(hostTimeNanos, 0.0, outputLatencySec);
            command.channel = 0; // Track MIDI output defaults to channel 1.
            if (pitchBend) {
                const int bend14 = std::clamp(static_cast<int>(std::lround(unit * 16383.0f)), 0, 16383);
                command.kind = MidiCommandKind::Raw;
                command.status = 0xE0;
                command.dataLength = 2;
                command.data1 = static_cast<uint8_t>(bend14 & 0x7f);
                command.data2 = static_cast<uint8_t>((bend14 >> 7) & 0x7f);
            } else {
                command.kind = MidiCommandKind::ControlChange;
                command.data1 = static_cast<uint8_t>(controller);
                command.data2 = static_cast<uint8_t>(std::clamp(
                    static_cast<int>(std::lround(unit * 127.0f)), 0, 127));
            }
            midiDispatcher.enqueue(command);
        }
    };

    // 1. Evaluate TrackAutomation lanes defined on the SongDef
    for (const auto& lane : song.automationLanes) {
        if (!lane.enabled || lane.muted || lane.points.empty())
            continue;

        const float value = AutomationEvaluator::evaluatePoints(
            lane.points, blockStartBeat, lane.target.defaultValue);

        if (lane.target.domain == AutomationDomain::Plugin) {
            if (pluginBank != nullptr) {
                const int parameterIndex = pluginBank->resolvePluginParameterIndex(
                    lane.target.entityId, lane.target.parameterId);
                if (parameterIndex >= 0)
                    pluginBank->setPluginParameterBySlotId(
                        lane.target.entityId, parameterIndex, value);
            }
        } else if (lane.target.domain == AutomationDomain::MidiCC) {
            sendMidiAutomation(lane, value, lane.target.entityId);
        }
    }

    // 2. Evaluate RegionAutomation and RegionModulation for active regions
    for (const auto& mr : song.midiRegions) {
        if (mr.muted || mr.automationLanes.empty())
            continue;
        if (blockStartBeat < mr.startBeats || blockStartBeat >= mr.startBeats + mr.durationBeats)
            continue;

        const double relBeats = midiRegionSourceBeat(
            blockStartBeat - mr.startBeats, mr.clipOffsetBeats,
            mr.loopStartBeats, mr.loopLengthBeats, mr.loop);

        for (const auto& lane : mr.automationLanes) {
            if (!lane.enabled || lane.muted || lane.points.empty())
                continue;

            const float value = AutomationEvaluator::evaluatePoints(
                lane.points, relBeats, lane.target.defaultValue);

            if (lane.target.domain == AutomationDomain::Plugin && pluginBank != nullptr) {
                const int parameterIndex = pluginBank->resolvePluginParameterIndex(
                    lane.target.entityId, lane.target.parameterId);
                if (parameterIndex >= 0)
                    pluginBank->setPluginParameterBySlotId(
                        lane.target.entityId, parameterIndex, value);
            } else if (lane.target.domain == AutomationDomain::MidiCC) {
                sendMidiAutomation(lane, value, mr.trackId);
            }
        }
    }

    // Audio-region plug-in automation is local to the clip just like MIDI
    // region automation. Region placement is stored in seconds, so convert its
    // origin through the same tempo map before evaluating musical-time points.
    for (const auto& region : song.regions) {
        if (region.automationLanes.empty()
            || blockStartSeconds < region.startSeconds
            || (region.durationSeconds > 0.0
                && blockStartSeconds >= region.startSeconds + region.durationSeconds))
            continue;

        const int64_t regionStartSample = static_cast<int64_t>(
            std::llround(region.startSeconds * safeRate));
        const double regionStartBeat = tempoMap != nullptr
            ? tempoMap->samplesToBeats(regionStartSample, safeRate)
            : (region.startSeconds * std::max(1.0, song.bpm) / 60.0);
        const double regionBeat = blockStartBeat - regionStartBeat;
        for (const auto& lane : region.automationLanes) {
            if (!lane.enabled || lane.muted || lane.points.empty()
                || lane.target.domain != AutomationDomain::Plugin
                || pluginBank == nullptr)
                continue;

            const int parameterIndex = pluginBank->resolvePluginParameterIndex(
                lane.target.entityId, lane.target.parameterId);
            if (parameterIndex < 0)
                continue;
            const float value = AutomationEvaluator::evaluatePoints(
                lane.points, regionBeat, lane.target.defaultValue);
            pluginBank->setPluginParameterBySlotId(
                lane.target.entityId, parameterIndex, value);
        }
    }
}

} // namespace resostage
