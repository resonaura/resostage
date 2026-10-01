// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

// Sample-accurate playback of MIDI regions to plug-in and external MIDI tracks.
// This is called from the audio path; preserve bounded, allocation-free work.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "midi/Midi2Compatibility.h"
#include "project/MidiRegionLoop.h"
#include "timing/OutputLatency.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace resostage {

void AudioEngine::dispatchMidiRegionsForBlock(const SongDef& song,
                                              int64_t blockStartSample,
                                              int numSamples,
                                              double sampleRate,
                                              const MixGraph* graph,
                                              PluginProcessorBank* pluginBank,
                                              const TempoMap* tempoMap,
                                              uint64_t hostTimeNanos,
                                              double outputLatencySec) {
    if (numSamples <= 0 || sampleRate <= 0.0 || song.midiRegions.empty())
        return;

    const int64_t blockEndSample = blockStartSample + numSamples;

    // Zero-allocation fallback for sample <-> beat conversion if tempoMap snapshot is not yet published
    auto fallbackBeatsToSamples = [&](double beat) -> int64_t {
        const double sec = beat * 60.0 / std::max(1.0, song.bpm);
        return static_cast<int64_t>(std::llround(sec * sampleRate));
    };

    auto fallbackSamplesToBeats = [&](int64_t sample) -> double {
        const double sec = static_cast<double>(sample) / sampleRate;
        return (sec * std::max(1.0, song.bpm)) / 60.0;
    };

    auto beatsToSamples = [&](double beat) -> int64_t {
        return tempoMap != nullptr ? tempoMap->beatsToSamples(beat, sampleRate)
                                   : fallbackBeatsToSamples(beat);
    };

    auto samplesToBeats = [&](int64_t sample) -> double {
        return tempoMap != nullptr ? tempoMap->samplesToBeats(sample, sampleRate)
                                   : fallbackSamplesToBeats(sample);
    };

    const double blockStartBeat = samplesToBeats(blockStartSample);
    const double blockEndBeat = samplesToBeats(blockEndSample);

    const auto& projectTracks = project().tracks;

    for (const auto& region : song.midiRegions) {
        if (region.muted || (region.notes.empty() && region.events.empty() && region.umpEvents.empty())
            || region.durationBeats <= 0.0)
            continue;

        const double regionStartBeat = region.startBeats;
        const double regionEndBeat = region.startBeats + region.durationBeats;

        // Bounded fast rejection: check if region timeline span overlaps the block in beats
        if (blockEndBeat <= regionStartBeat || blockStartBeat >= regionEndBeat)
            continue;

        // Also check in sample space for exact boundaries
        const int64_t regionStartSample = beatsToSamples(regionStartBeat);
        const int64_t regionEndSample = beatsToSamples(regionEndBeat);
        if (blockEndSample <= regionStartSample || blockStartSample >= regionEndSample)
            continue;

        // Resolve destination channel strip index and track kind
        uint32_t targetStripIndex = MixGraph::kNoStrip;
        TrackKind trackKind = TrackKind::Instrument;

        for (const auto& tr : projectTracks) {
            if (tr.id == region.trackId) {
                trackKind = tr.kind;
                if (graph != nullptr) {
                    targetStripIndex = graph->find(tr.effectiveStripId());
                }
                break;
            }
        }
        if (targetStripIndex == MixGraph::kNoStrip && graph != nullptr) {
            targetStripIndex = graph->find(region.trackId);
        }

        const bool canSendToPlugin = (pluginBank != nullptr
                                      && targetStripIndex != MixGraph::kNoStrip
                                      && pluginBank->stripHasInstrument(targetStripIndex));
        const bool canSendToExternalMidi = (trackKind == TrackKind::ExternalMIDI
                                            || trackKind == TrackKind::MIDI);

        if (!canSendToPlugin && !canSendToExternalMidi)
            continue;

        const double loopLen = (region.loop && region.loopLengthBeats > 1e-4)
            ? region.loopLengthBeats
            : region.durationBeats;

        int kMin = 0;
        int kMax = 0;

        if (region.loop && loopLen > 1e-4) {
            const double overlapStartBeat = std::max(blockStartBeat, regionStartBeat);
            const double overlapEndBeat = std::min(blockEndBeat, regionEndBeat);
            const double phase = midiRegionLoopPhase(
                region.clipOffsetBeats, region.loopStartBeats, loopLen);
            const double tStart = overlapStartBeat - regionStartBeat + phase;
            const double tEnd = overlapEndBeat - regionStartBeat + phase;
            kMin = static_cast<int>(std::floor(tStart / loopLen));
            kMax = static_cast<int>(std::floor(tEnd / loopLen));
        }

        for (int k = kMin; k <= kMax; ++k) {
            const double iterationOffset = region.loop
                ? regionStartBeat - region.loopStartBeats
                    - midiRegionLoopPhase(region.clipOffsetBeats,
                                          region.loopStartBeats, loopLen)
                    + (k * loopLen)
                : regionStartBeat - region.clipOffsetBeats;

            for (const auto& note : region.notes) {
                if (note.muted || note.durationBeats <= 0.0)
                    continue;
                if (region.loop && !midiRegionContainsLoopSourceBeat(
                        note.startBeats, region.loopStartBeats, loopLen))
                    continue;

                const double noteOnBeat = iterationOffset + note.startBeats;
                const double loopBoundaryBeat = region.loop
                    ? iterationOffset + region.loopStartBeats + loopLen
                    : std::numeric_limits<double>::infinity();
                const double noteOffBeat = std::min(
                    noteOnBeat + note.durationBeats, loopBoundaryBeat);

                const uint8_t ch = static_cast<uint8_t>(std::clamp(static_cast<int>(note.channel) + 1, 1, 16));
                const uint8_t pitch = static_cast<uint8_t>(std::clamp(static_cast<int>(note.pitch), 0, 127));
                const uint8_t vel = midi1NoteVelocity(note, true);
                const uint8_t relVel = midi1NoteVelocity(note, false);

                // Note-On dispatch
                if (noteOnBeat >= regionStartBeat && noteOnBeat < regionEndBeat) {
                    const int64_t onSample = beatsToSamples(noteOnBeat);
                    if (onSample >= blockStartSample && onSample < blockEndSample) {
                        const int sampleOffset = std::clamp(static_cast<int>(onSample - blockStartSample), 0, numSamples - 1);

                        if (canSendToPlugin) {
                            pluginBank->addStripMidiEvent(targetStripIndex, juce::MidiMessage::noteOn(ch, pitch, vel), sampleOffset);
                        }
                        if (canSendToPlugin || canSendToExternalMidi)
                            updateActiveMidiNote(targetStripIndex, pitch, true);
                        if (targetStripIndex < kMaxActiveMidiTracks) {
                            const size_t channelIndex = std::min<size_t>(
                                static_cast<size_t>(note.channel), 15);
                            auto& count = sequencedMidiNoteCounts[targetStripIndex]
                                [channelIndex][pitch];
                            if (count < std::numeric_limits<uint8_t>::max())
                                ++count;
                        }
                        if (canSendToExternalMidi) {
                            const double offsetSec = static_cast<double>(sampleOffset) / sampleRate;
                            MidiCommand cmd;
                            cmd.kind = MidiCommandKind::NoteOn;
                            cmd.channel = note.channel;
                            cmd.data1 = pitch;
                            cmd.data2 = vel;
                            cmd.targetHostTimeNanos = heardHostNanos(hostTimeNanos, offsetSec, outputLatencySec);
                            midiDispatcher.enqueue(cmd);
                            activeExternalMidiChannelMask |= static_cast<uint16_t>(
                                1u << std::min<unsigned>(note.channel, 15u));
                        }
                    }
                }

                // Note-Off dispatch
                const double clampedOffBeat = std::min(noteOffBeat, regionEndBeat);
                if (noteOnBeat < regionEndBeat && clampedOffBeat > regionStartBeat) {
                    const int64_t offSample = beatsToSamples(clampedOffBeat);
                    if (offSample >= blockStartSample && offSample < blockEndSample) {
                        const int sampleOffset = std::clamp(static_cast<int>(offSample - blockStartSample), 0, numSamples - 1);

                        if (canSendToPlugin) {
                            pluginBank->addStripMidiEvent(targetStripIndex, juce::MidiMessage::noteOff(ch, pitch, relVel), sampleOffset);
                        }
                        if (canSendToPlugin || canSendToExternalMidi)
                            updateActiveMidiNote(targetStripIndex, pitch, false);
                        if (targetStripIndex < kMaxActiveMidiTracks) {
                            const size_t channelIndex = std::min<size_t>(
                                static_cast<size_t>(note.channel), 15);
                            auto& count = sequencedMidiNoteCounts[targetStripIndex]
                                [channelIndex][pitch];
                            if (count != 0)
                                --count;
                        }
                        if (canSendToExternalMidi) {
                            const double offsetSec = static_cast<double>(sampleOffset) / sampleRate;
                            MidiCommand cmd;
                            cmd.kind = MidiCommandKind::NoteOff;
                            cmd.channel = note.channel;
                            cmd.data1 = pitch;
                            cmd.data2 = relVel;
                            cmd.targetHostTimeNanos = heardHostNanos(hostTimeNanos, offsetSec, outputLatencySec);
                            midiDispatcher.enqueue(cmd);
                        }
                    }
                }
            }

            for (const auto& event : region.events) {
                if (region.loop && !midiRegionContainsLoopSourceBeat(
                        event.beat, region.loopStartBeats, loopLen))
                    continue;
                const double eventBeat = iterationOffset + event.beat;
                if (eventBeat < regionStartBeat || eventBeat >= regionEndBeat) continue;
                const int64_t eventSample = beatsToSamples(eventBeat);
                if (eventSample < blockStartSample || eventSample >= blockEndSample) continue;
                // Meta events and SysEx are retained losslessly for file
                // round-trips. SysEx can be arbitrarily large and therefore
                // cannot be constructed/copied on the real-time callback;
                // short channel/system messages are safe to schedule here.
                if (event.status == 0xff || event.status == 0xf0 || event.status == 0xf7
                    || event.data.size() > 2 || event.status < 0x80)
                    continue;
                const int sampleOffset = std::clamp(static_cast<int>(eventSample - blockStartSample), 0, numSamples - 1);
                uint8_t bytes[3] = {event.status, 0, 0};
                for (size_t byte = 0; byte < event.data.size(); ++byte) bytes[byte + 1] = event.data[byte];
                const auto statusKind = event.status & 0xf0;
                const size_t expectedLength = event.status >= 0xf8 || event.status == 0xf6 ? 0u
                    : statusKind == 0xc0 || statusKind == 0xd0 || event.status == 0xf1 || event.status == 0xf3
                        ? 1u : 2u;
                const size_t dataLength = std::min(event.data.size(), expectedLength);
                if (canSendToPlugin)
                    pluginBank->addStripMidiEvent(targetStripIndex,
                        juce::MidiMessage(bytes, static_cast<int>(dataLength + 1)), sampleOffset);
                if (canSendToExternalMidi) {
                    MidiCommand cmd;
                    cmd.kind = MidiCommandKind::Raw;
                    cmd.status = event.status;
                    cmd.channel = event.status < 0xf0 ? static_cast<uint8_t>(event.status & 0x0f) : 0;
                    cmd.dataLength = static_cast<uint8_t>(dataLength);
                    if (dataLength > 0) cmd.data1 = event.data[0];
                    if (dataLength > 1) cmd.data2 = event.data[1];
                    const double offsetSec = static_cast<double>(sampleOffset) / sampleRate;
                    cmd.targetHostTimeNanos = heardHostNanos(hostTimeNanos, offsetSec, outputLatencySec);
                    midiDispatcher.enqueue(cmd);
                }
            }

            for (const auto& event : region.umpEvents) {
                const auto compatible = umpToMidi1ChannelControl(event);
                if (!compatible || !std::isfinite(event.beat)) continue;
                if (region.loop && !midiRegionContainsLoopSourceBeat(
                        event.beat, region.loopStartBeats, loopLen))
                    continue;
                const double eventBeat = iterationOffset + event.beat;
                if (eventBeat < regionStartBeat || eventBeat >= regionEndBeat) continue;
                const int64_t eventSample = beatsToSamples(eventBeat);
                if (eventSample < blockStartSample || eventSample >= blockEndSample) continue;
                const int sampleOffset = std::clamp(static_cast<int>(eventSample - blockStartSample), 0, numSamples - 1);
                if (canSendToPlugin) {
                    const uint8_t bytes[3] = {compatible->status, compatible->data1, compatible->data2};
                    pluginBank->addStripMidiEvent(targetStripIndex,
                        juce::MidiMessage(bytes, compatible->dataLength + 1), sampleOffset);
                }
                if (canSendToExternalMidi) {
                    MidiCommand cmd;
                    cmd.kind = MidiCommandKind::Raw;
                    cmd.status = compatible->status;
                    cmd.channel = static_cast<uint8_t>(compatible->status & 0x0f);
                    cmd.dataLength = compatible->dataLength;
                    cmd.data1 = compatible->data1;
                    cmd.data2 = compatible->data2;
                    const double offsetSec = static_cast<double>(sampleOffset) / sampleRate;
                    cmd.targetHostTimeNanos = heardHostNanos(hostTimeNanos, offsetSec, outputLatencySec);
                    midiDispatcher.enqueue(cmd);
                }
            }
        }
    }

}

} // namespace resostage
