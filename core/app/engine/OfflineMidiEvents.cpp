/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "OfflineMidiEvents.h"

#include "midi/Midi2Compatibility.h"
#include "project/MidiRegionLoop.h"

#include <algorithm>
#include <cmath>

namespace resostage::offline_detail {

bool buildOfflineMidiEvents(const Project& project, const SongDef& song,
                            const MixGraph& graph, const TempoMap& tempoMap,
                            const OfflineProcessorSession* processors,
                            double sampleRate, int64_t renderStartSample,
                            int64_t renderEndSample,
                            std::vector<OfflineMidiEvent>& events,
                            std::string& error) {
    constexpr size_t kMaximumEvents = 1'000'000;
    events.clear();
    if (processors == nullptr)
        return true;
    for (const auto& region : song.midiRegions) {
        if (region.muted || (region.notes.empty() && region.events.empty() && region.umpEvents.empty())
            || !std::isfinite(region.startBeats)
            || !std::isfinite(region.durationBeats) || region.durationBeats <= 0.0)
            continue;
        const TrackDef* targetTrack = nullptr;
        for (const auto& track : project.tracks) {
            if (track.id == region.trackId) { targetTrack = &track; break; }
        }
        if (targetTrack == nullptr)
            continue;
        const uint32_t strip = graph.find(targetTrack->effectiveStripId());
        if (strip == MixGraph::kNoStrip || !processors->stripHasInstrument(strip))
            continue;

        const double loopLength = region.loop && std::isfinite(region.loopLengthBeats)
            && region.loopLengthBeats > 1.0e-4
            ? region.loopLengthBeats : region.durationBeats;
        const double clipOffset = std::isfinite(region.clipOffsetBeats)
            ? std::max(0.0, region.clipOffsetBeats) : 0.0;
        const double loopStart = region.loop && std::isfinite(region.loopStartBeats)
            ? std::max(0.0, region.loopStartBeats) : 0.0;
        const int repeatCount = region.loop && loopLength > 1.0e-4
            ? static_cast<int>(std::clamp(std::ceil(
                region.durationBeats / loopLength), 1.0, 100'000.0))
            : 1;
        const double regionEndBeat = region.startBeats + region.durationBeats;
        for (int repeat = 0; repeat < repeatCount; ++repeat) {
            for (const auto& note : region.notes) {
                if (note.muted || !std::isfinite(note.startBeats)
                    || !std::isfinite(note.durationBeats) || note.durationBeats < 0.0)
                    continue;
                if (region.loop && !midiRegionContainsLoopSourceBeat(
                        note.startBeats, loopStart, loopLength))
                    continue;
                const double relativeBeat = region.loop
                    ? midiRegionLoopOccurrence(note.startBeats, clipOffset,
                                               loopStart, loopLength)
                        + repeat * loopLength
                    : note.startBeats - clipOffset;
                const double noteOnBeat = region.startBeats + relativeBeat;
                if (noteOnBeat >= regionEndBeat)
                    continue;
                const double availableInLoop = region.loop
                    ? loopStart + loopLength - note.startBeats
                    : note.durationBeats;
                const double noteOffBeat = std::min(
                    noteOnBeat + std::min(note.durationBeats, availableInLoop),
                    regionEndBeat);
                const bool instantaneousAtRegionStart = note.durationBeats == 0.0
                    && noteOnBeat >= region.startBeats;
                if (noteOffBeat <= region.startBeats && !instantaneousAtRegionStart)
                    continue;
                const int64_t onSample = tempoMap.beatsToSamples(noteOnBeat, sampleRate);
                const int64_t offSample = tempoMap.beatsToSamples(noteOffBeat, sampleRate);
                const int64_t regionStartSample = tempoMap.beatsToSamples(region.startBeats, sampleRate);
                const int64_t effectiveOnSample = std::max({
                    onSample, renderStartSample, regionStartSample});
                const int64_t effectiveOffSample = std::min(offSample, renderEndSample);
                if (effectiveOnSample >= renderEndSample
                    || effectiveOffSample < effectiveOnSample
                    || (effectiveOffSample == effectiveOnSample
                        && onSample < effectiveOnSample))
                    continue;
                const uint8_t pitch = static_cast<uint8_t>(std::clamp(
                    static_cast<int>(note.pitch), 0, 127));
                const uint8_t velocity = midi1NoteVelocity(note, true);
                const uint8_t releaseVelocity = midi1NoteVelocity(note, false);
                const uint8_t channel = static_cast<uint8_t>(std::clamp(static_cast<int>(note.channel), 0, 15));
                OfflineMidiEvent noteOn;
                noteOn.sample = effectiveOnSample;
                noteOn.strip = strip;
                noteOn.pitch = pitch;
                noteOn.channel = channel;
                noteOn.velocity = velocity;
                noteOn.releaseVelocity = releaseVelocity;
                noteOn.noteOn = true;
                noteOn.instantaneous = effectiveOffSample == effectiveOnSample;
                events.push_back(noteOn);
                OfflineMidiEvent noteOff = noteOn;
                noteOff.sample = effectiveOffSample;
                noteOff.noteOn = false;
                events.push_back(noteOff);
                if (events.size() > kMaximumEvents) {
                    error = "MIDI arrangement exceeds the offline render event limit";
                    return false;
                }
            }
            for (const auto& message : region.events) {
                if (!std::isfinite(message.beat) || message.data.size() > 2
                    || message.status == 0xff || message.status == 0xf0 || message.status == 0xf7)
                    continue; // Meta and variable-length SysEx are retained for SMF export only.
                if (region.loop && !midiRegionContainsLoopSourceBeat(
                        message.beat, loopStart, loopLength))
                    continue;
                const double relativeBeat = region.loop
                    ? midiRegionLoopOccurrence(message.beat, clipOffset,
                                               loopStart, loopLength)
                        + repeat * loopLength
                    : message.beat - clipOffset;
                const int64_t sample = tempoMap.beatsToSamples(
                    region.startBeats + relativeBeat, sampleRate);
                if (sample < renderStartSample || sample >= renderEndSample
                    || sample < tempoMap.beatsToSamples(region.startBeats, sampleRate)
                    || sample >= tempoMap.beatsToSamples(regionEndBeat, sampleRate))
                    continue;
                OfflineMidiEvent event;
                event.sample = sample;
                event.strip = strip;
                event.status = message.status;
                event.dataLength = static_cast<uint8_t>(message.data.size());
                if (!message.data.empty()) event.data1 = message.data[0];
                if (message.data.size() > 1) event.data2 = message.data[1];
                event.raw = true;
                events.push_back(event);
                if (events.size() > kMaximumEvents) {
                    error = "MIDI arrangement exceeds the offline render event limit";
                    return false;
                }
            }
            for (const auto& message : region.umpEvents) {
                const auto compatible = umpToMidi1ChannelControl(message);
                if (!compatible || !std::isfinite(message.beat)) continue;
                if (region.loop && !midiRegionContainsLoopSourceBeat(
                        message.beat, loopStart, loopLength))
                    continue;
                const double relativeBeat = region.loop
                    ? midiRegionLoopOccurrence(message.beat, clipOffset,
                                               loopStart, loopLength)
                        + repeat * loopLength
                    : message.beat - clipOffset;
                const int64_t sample = tempoMap.beatsToSamples(
                    region.startBeats + relativeBeat, sampleRate);
                if (sample < renderStartSample || sample >= renderEndSample
                    || sample < tempoMap.beatsToSamples(region.startBeats, sampleRate)
                    || sample >= tempoMap.beatsToSamples(regionEndBeat, sampleRate))
                    continue;
                OfflineMidiEvent event;
                event.sample = sample;
                event.strip = strip;
                event.status = compatible->status;
                event.data1 = compatible->data1;
                event.data2 = compatible->data2;
                event.dataLength = compatible->dataLength;
                event.raw = true;
                events.push_back(event);
                if (events.size() > kMaximumEvents) {
                    error = "MIDI arrangement exceeds the offline render event limit";
                    return false;
                }
            }
        }
    }
    std::stable_sort(events.begin(), events.end(), [](const auto& a, const auto& b) {
        if (a.sample != b.sample) return a.sample < b.sample;
        const auto eventPhase = [](const OfflineMidiEvent& event) {
            if (event.raw) return 1;
            if (event.instantaneous) return event.noteOn ? 2 : 3;
            return event.noteOn ? 4 : 0;
        };
        const int aPhase = eventPhase(a);
        const int bPhase = eventPhase(b);
        if (aPhase != bPhase) return aPhase < bPhase;
        if (a.raw != b.raw) return !a.raw;
        return a.strip < b.strip;
    });
    return true;
}

} // namespace resostage::offline_detail
