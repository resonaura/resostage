/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "OfflineRenderer.h"

#include "audio/graph/MixGraph.h"
#include "timing/TempoMap.h"

#include <cstdint>
#include <string>
#include <vector>

namespace resostage::offline_detail {

/** One sample-stamped MIDI message routed to an offline instrument strip. */
struct OfflineMidiEvent {
    int64_t sample = 0;
    uint32_t strip = MixGraph::kNoStrip;
    uint8_t pitch = 0;
    uint8_t channel = 0;
    uint8_t velocity = 0;
    uint8_t releaseVelocity = 0;
    uint8_t status = 0;
    uint8_t data1 = 0;
    uint8_t data2 = 0;
    uint8_t dataLength = 0;
    bool noteOn = false;
    bool raw = false;
    /** Both edges quantized to one sample; keep attack before its own release. */
    bool instantaneous = false;
};

bool buildOfflineMidiEvents(const Project& project, const SongDef& song,
                            const MixGraph& graph, const TempoMap& tempoMap,
                            const OfflineProcessorSession* processors,
                            double sampleRate, int64_t renderStartSample,
                            int64_t renderEndSample,
                            std::vector<OfflineMidiEvent>& events,
                            std::string& error);

using OfflineMIDIEvent = OfflineMidiEvent;

inline bool buildOfflineMIDIEvents(const Project& project, const SongDef& song,
                                   const MixGraph& graph, const TempoMap& tempoMap,
                                   const OfflineProcessorSession* processors,
                                   double sampleRate, int64_t renderStartSample,
                                   int64_t renderEndSample,
                                   std::vector<OfflineMidiEvent>& events,
                                   std::string& error) {
    return buildOfflineMidiEvents(project, song, graph, tempoMap, processors, sampleRate,
                                  renderStartSample, renderEndSample, events, error);
}

} // namespace resostage::offline_detail
