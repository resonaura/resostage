// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

// Timeline event dispatch and plug-in lookahead preparation.
// This code is called from the existing transport/audio paths; only its
// translation-unit ownership changes here. Preserve the bounded, allocation-free
// work performed by event dispatch and lookahead methods.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "project/RouteId.h"
#include "timing/OutputLatency.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>

namespace resostage {

void AudioEngine::dispatchEvent(const TimelineEvent& ev, uint64_t targetHostTimeNanos) {
    switch (ev.type) {
        case EventType::MidiNoteOn: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::NoteOn;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiNote, 0, 127));
            cmd.data2 = static_cast<uint8_t>(std::clamp(ev.midiVelocity, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::MidiNoteOff: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::NoteOff;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiNote, 0, 127));
            cmd.data2 = static_cast<uint8_t>(std::clamp(ev.midiVelocity, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::MidiCC: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::ControlChange;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiCC, 0, 127));
            cmd.data2 = static_cast<uint8_t>(std::clamp(ev.midiCCValue, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::MidiProgramChange: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::ProgramChange;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiProgram, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::Http: {
            HttpTriggerCommand cmd;
            cmd.url = ev.httpUrl.value_or("");
            cmd.method = ev.httpMethod;
            cmd.body = ev.httpBody.value_or("");
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            eventDispatcher.enqueueHttp(cmd);
            break;
        }
        case EventType::Dmx: {
            DmxTriggerCommand cmd;
            cmd.universe = ev.dmxUniverse;
            cmd.data = ev.dmxData;
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            eventDispatcher.enqueueDmx(cmd);
            break;
        }
    }
}

void AudioEngine::fireOnLoadEvents(const SongDef& song) {
    const uint64_t now = SystemMonotonicClock{}.nowNanos();
    for (const TimelineEvent& ev : song.events)
        if (ev.triggerOnLoad)
            dispatchEvent(ev, now);
}

void AudioEngine::fireDueEvents(const SongDef& song, double blockStartSeconds,
                                double blockEndSeconds,
                                uint64_t hostTimeNanosAtBlockStart,
                                int64_t effectiveOutputLatencySamples,
                                PluginProcessorBank* pluginBank,
                                int numSamples) {
    // How long the audio for this block will sit in the device before anyone
    // hears it. Every event below is scheduled for that moment rather than for
    // now, so a MIDI note or a light cue lands WITH its downbeat instead of
    // ahead of it -- and, just as importantly, stops moving when the operator
    // changes the buffer size. See engine/timing/OutputLatency.h.
    const double outputLatencySec =
        resostage::outputLatencySeconds(effectiveOutputLatencySamples,
                                        currentSampleRate);

    for (size_t i = 0; i < song.events.size() && i < eventFiredFlags.size(); ++i) {
        const TimelineEvent& ev = song.events[i];
        if (ev.triggerOnLoad || eventFiredFlags[i] != 0)
            continue;

        const double fireAtSeconds = ev.timeSeconds - (ev.latencyCompensationMs / 1000.0);
        // Blocks are half-open [start, end). An event exactly on `end`
        // belongs to the next block; firing it here would put a right-locator
        // event one sample before a cycle wrap and then fire it again at the
        // left-side segment.
        if (fireAtSeconds >= blockEndSeconds)
            continue;

        // Events already in the past when we get to them (e.g. several were
        // skipped during a MasterClock catch-up jump) fire as soon as
        // possible rather than being silently dropped.
        const double offsetSeconds = std::max(0.0, fireAtSeconds - blockStartSeconds);
        const uint64_t targetHostTimeNanos =
            heardHostNanos(hostTimeNanosAtBlockStart, offsetSeconds, outputLatencySec);

        dispatchEvent(ev, targetHostTimeNanos);

        // If an active plug-in bank is present, route block MIDI events to instrument strips
        if (pluginBank != nullptr && numSamples > 0) {
            juce::MidiMessage msg;
            if (ev.type == EventType::MidiNoteOn) {
                msg = juce::MidiMessage::noteOn(
                    std::clamp(ev.midiChannel, 1, 16),
                    std::clamp(ev.midiNote, 0, 127),
                    static_cast<uint8_t>(std::clamp(ev.midiVelocity, 0, 127)));
            } else if (ev.type == EventType::MidiNoteOff) {
                msg = juce::MidiMessage::noteOff(
                    std::clamp(ev.midiChannel, 1, 16),
                    std::clamp(ev.midiNote, 0, 127),
                    static_cast<uint8_t>(std::clamp(ev.midiVelocity, 0, 127)));
            } else if (ev.type == EventType::MidiCC) {
                msg = juce::MidiMessage::controllerEvent(
                    std::clamp(ev.midiChannel, 1, 16),
                    std::clamp(ev.midiCC, 0, 127),
                    std::clamp(ev.midiCCValue, 0, 127));
            }
            if (msg.getRawDataSize() > 0) {
                const int sampleOffset = std::clamp(
                    static_cast<int>(offsetSeconds * currentSampleRate), 0, numSamples - 1);
                const auto& projectTracks = project().tracks;
                for (size_t s = 0; s < projectTracks.size(); ++s) {
                    if (pluginBank->stripHasInstrument(s)) {
                        pluginBank->addStripMidiEvent(s, msg, sampleOffset);
                        if (ev.type == EventType::MidiNoteOn || ev.type == EventType::MidiNoteOff)
                            updateActiveMidiNote(
                                s,
                                ev.midiNote,
                                ev.type == EventType::MidiNoteOn && ev.midiVelocity > 0);
                    }
                }
            }
        }

        eventFiredFlags[i] = 1;
    }
}

void AudioEngine::prewarmPluginsLookahead(const SongDef& song,
                                         int64_t playheadSample,
                                         double sampleRate,
                                         const MixGraph* graph,
                                         PluginProcessorBank* pluginBank,
                                         const TempoMap* tempoMap) {
    if (pluginBank == nullptr || graph == nullptr)
        return;

    const double safeRate = sampleRate > 0.0 ? sampleRate : 48000.0;
    const double currentSeconds = static_cast<double>(playheadSample) / safeRate;
    const double currentBeat = tempoMap != nullptr
        ? tempoMap->samplesToBeats(playheadSample, safeRate)
        : (currentSeconds * (song.bpm / 60.0));

    const double beatsPerBar = static_cast<double>(song.timeSignature.numerator) * 4.0
                               / std::max(1, song.timeSignature.denominator);
    const double lookaheadBars = 2.0;
    const double lookaheadEndBeat = currentBeat + lookaheadBars * beatsPerBar;
    const double lookaheadEndSeconds = tempoMap != nullptr
        ? tempoMap->beatsToSeconds(lookaheadEndBeat)
        : lookaheadEndBeat * (60.0 / std::max(1.0, song.bpm));

    // Check audio regions within 2-bar horizon
    for (const auto& reg : song.regions) {
        const double regStart = reg.startSeconds;
        const double regEnd = (reg.durationSeconds > 0.0)
                                  ? (reg.startSeconds + reg.durationSeconds)
                                  : std::numeric_limits<double>::infinity();
        if (regEnd > currentSeconds && regStart < lookaheadEndSeconds) {
            const uint32_t stripIdx = graph->find(reg.trackId);
            if (stripIdx != MixGraph::kNoStrip) {
                pluginBank->prewarmStrip(stripIdx);
            }
        }
    }

    // Check MIDI regions within 2-bar horizon
    for (const auto& mreg : song.midiRegions) {
        if (mreg.muted) continue;
        const double mregStart = mreg.startBeats;
        const double mregEnd = (mreg.durationBeats > 0.0)
                                   ? (mreg.startBeats + mreg.durationBeats)
                                   : std::numeric_limits<double>::infinity();
        if (mregEnd > currentBeat && mregStart < lookaheadEndBeat) {
            const uint32_t stripIdx = graph->find(mreg.trackId);
            if (stripIdx != MixGraph::kNoStrip) {
                pluginBank->prewarmStrip(stripIdx);
            }
        }
    }
}

} // namespace resostage
