/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// JUCE message-thread construction of WebUiState.
// This code reads mutable project state on the JUCE message thread, combines
// it with published engine telemetry, and publishes the resulting snapshot to
// WebServer. Keep it off the audio callback; this file split does not change
// the state ownership or publication cadence.

#include "MainComponent.h"
#include "audio/graph/MixGraph.h"
#include "audio/graph/ProjectPlaybackSnapshot.h"
#include "automation/StripAutomationPlan.h"
#include "engine/AudioEngineInternal.h"
#include "lighting/LightOutputResolver.h"
#include "plugins/PluginProcessorBank.h"
#include "project/ProjectJson.h"
#include "project/RouteId.h"
#include "server/BuilderJson.h"
#include "server/WireTypes.h"
#include "platform/ThermalState.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace resostage {

void MainComponent::publishWebState() {
    WebUiState state;
    const auto& transport = engine.transport();
    const auto activeBank = engine.hasCurrentPluginProcessorBank()
        ? engine.activePluginProcessorBank() : nullptr;
    if (activeBank != nullptr) {
        engine.health().setPluginDiagnostics(
            activeBank->missedOutputBlocks(),
            activeBank->missedInputBlocks(),
            activeBank->missedControlEvents(),
            activeBank->rejectedMidiEvents());
    } else {
        engine.health().setPluginDiagnostics(0, 0, 0, 0);
    }
    const auto health = engine.health().sample();

    state.playheadSeconds = transport.playheadSeconds.load(std::memory_order_relaxed);
    state.globalPlayheadSeconds = engine.globalPlayheadSeconds();
    state.globalBeatsElapsed = engine.globalBeatsElapsed();
    state.cyclePassSequence = transport.cyclePassSequence.load(std::memory_order_relaxed);
    state.sampleRate = transport.sampleRate.load(std::memory_order_relaxed);
    state.driftFactor = transport.driftFactor.load(std::memory_order_relaxed);
    state.playing = transport.running.load(std::memory_order_relaxed);
    state.recording = engine.isRecording();
    state.recordingCountIn = engine.isRecordingCountIn();
    state.recordingCountInBeatsRemaining = engine.recordingCountInBeatsRemaining();
    state.autoInputMonitoring = engine.isAutoInputMonitoring();
    state.autoPunchEnabled = engine.isAutoPunchEnabled();
    state.lowLatencyMonitoring = engine.isLowLatencyMonitoring();
    state.lowLatencyLimitMs = engine.getLowLatencyLimitMs();
    state.liveRecordings = engine.getLiveRecordingRegions();
    for (const auto& note : engine.getActiveMidiNotes())
        state.activeMidiNotes.push_back({note.trackId, note.pitch,
                                         static_cast<int>(note.trackIndex)});
    state.hardwareAlarm = transport.hardwareAlarm.load(std::memory_order_relaxed);

    const Project& proj = engine.project();
    const auto loading = engine.pluginLoadingSnapshot();
    state.pluginLoading = {loading.epoch, loading.generation, loading.phase,
        loading.blocksPlayback, loading.showDialog, loading.playRequested,
        loading.total, loading.completed, loading.failed,
        loading.currentName, loading.error};
    const auto copyPluginSlots = [&activeBank, &loading](const std::vector<PluginSlot>& slots) {
        std::vector<WebUiState::PluginSlotRow> rows;
        rows.reserve(slots.size());
        for (const auto& slot : slots) {
            WebUiState::PluginSlotRow row;
            row.id = slot.id;
            row.pluginId = slot.plugin.identifier;
            row.name = slot.plugin.name;
            row.manufacturer = slot.plugin.manufacturer;
            row.format = slot.plugin.format;
            row.instrument = slot.plugin.instrument;
            row.bypassed = slot.bypassed;
            row.hasState = slot.stateResource.has_value();
            row.keepAwake = slot.keepAwake;
            if (activeBank != nullptr) {
                row.powerState = pluginPowerStateToString(activeBank->getSlotPowerState(slot.id));
                row.loadState = activeBank->getSlotLoadState(slot.id);
                row.loadError = activeBank->getSlotLoadError(slot.id);
                if (row.loadState == "loading" && loading.phase != "loading") {
                    row.loadState = "failed";
                    row.loadError = "Plug-in slot was not initialized (host capacity or load failure)";
                }
            } else {
                row.loadState = loading.phase == "failed" ? "failed" : "loading";
                row.loadError = loading.error;
            }
            // Power telemetry describes a running processor, not a configured slot.
            if (row.loadState != "loaded") row.powerState = row.loadState;
            rows.push_back(std::move(row));
        }
        return rows;
    };
    const auto copyAutomationLanes = [](const std::vector<AutomationLane>& lanes) {
        std::vector<WebUiState::AutomationLaneRow> rows;
        rows.reserve(lanes.size());
        for (const auto& lane : lanes) {
            WebUiState::AutomationLaneRow row;
            row.id = lane.id;
            row.target.domain = automationDomainToString(lane.target.domain);
            row.target.entityId = lane.target.entityId;
            row.target.parameterId = lane.target.parameterId;
            row.target.valueType = parameterValueTypeToString(lane.target.valueType);
            row.target.defaultValue = lane.target.defaultValue;
            row.target.minValue = lane.target.minValue;
            row.target.maxValue = lane.target.maxValue;
            row.scope = automationScopeToString(lane.scope);
            row.enabled = lane.enabled;
            row.muted = lane.muted;
            row.writeMode = automationWriteModeToString(lane.writeMode);
            row.points.reserve(lane.points.size());
            for (const auto& point : lane.points) {
                WebUiState::AutomationLaneRow::Point rowPoint;
                rowPoint.timeBeats = point.timeBeats;
                rowPoint.value = point.value;
                rowPoint.curve = point.curve;
                row.points.push_back(std::move(rowPoint));
            }
            rows.push_back(std::move(row));
        }
        return rows;
    };
    state.projectName = proj.name;
    state.activeTrackId = proj.activeTrackId;
    state.click = proj.click.enabled;
    state.clickName = proj.click.name.empty() ? "Click" : proj.click.name;
    state.clickBusId = routeIdOf(proj.click.output);
    state.clickGainDb = proj.click.gainDb;
    state.clickPan = proj.click.pan;
    state.clickMono = proj.click.channels == 1;
    state.clickSolo = proj.click.solo;
    state.clickSoloSafe = engine.isClickSoloSafe();
    state.clickOutputType = outputTypeToString(proj.click.output.type);
    state.clickOutputTarget = proj.click.output.target.value_or("");
    state.clickSoloGroup = engine.trackSoloGroup();
    state.clickSoloActiveInGroup = engine.anySoloInGroup(state.clickSoloGroup.c_str());
    state.clickSends.clear();
    for (const SendConfig& cs : proj.click.output.sends) {
        WebUiState::ClickSendRow csr;
        csr.busId = cs.bus;
        csr.level = cs.level;
        csr.enabled = cs.enabled;
        state.clickSends.push_back(std::move(csr));
    }
    state.clickPlugins = copyPluginSlots(proj.click.plugins);
    // Interval max of rendered click peaks since last poll — captures every
    // audible tick even when the impulse is shorter than the UI sample period.
    {
        const MeterFrame clickFrame = engine.consumeClickMeterInterval();
        state.clickPeakDb = clickFrame.peakDb;
        state.clickPeakDbL = clickFrame.peakDbL;
        state.clickPeakDbR = clickFrame.peakDbR;
        state.clickIntervalPeakDbL = clickFrame.intervalPeakDbL;
        state.clickIntervalPeakDbR = clickFrame.intervalPeakDbR;
    }
    {
        const auto bh = engine.streamBufferHealth();
        state.streamBufferMinSec = bh.minBufferedSeconds;
        state.streamBufferAvgSec = bh.avgBufferedSeconds;
        state.streamResidentTracks = bh.residentTracks;
        state.streamStreamingTracks = bh.streamingTracks;
        state.streamBufferUrgent = bh.urgent;
        state.streamResidentMiB =
            static_cast<double>(bh.residentBytes) / (1024.0 * 1024.0);
        state.streamRingFraction = bh.minRingFraction;
        state.streamIoPressure = bh.ioPressure == IoPressureLevel::Critical  ? "critical"
                                 : bh.ioPressure == IoPressureLevel::Tight   ? "tight"
                                                                             : "healthy";
    }
    state.songCount = static_cast<int>(proj.songs.size());
    state.songIndex = (engine.currentSongIndex() == static_cast<size_t>(-1))
                          ? -1
                          : static_cast<int>(engine.currentSongIndex());
    state.lastAction = lastAction_;
    state.lastActionNonce = lastActionNonce_;
    state.statusMessage = lastStatusMessage;
    state.busy = engine.isBusy();
    state.quitConfirmPending = awaitingQuitDecision;
    state.openConfirmPending = awaitingOpenDecision;
    state.saveAsPending = (pendingSaveAsCallback != nullptr);
    state.uiTab = uiTabRequest;
    state.uiTabSeq = uiTabSeq;
    state.canUndo = engine.canUndoTimeline();
    state.canRedo = engine.canRedoTimeline();
    state.undoLabel = engine.undoTimelineLabel();
    state.redoLabel = engine.redoTimelineLabel();
    state.projectEpoch = projectEpoch_;
    state.stateRevision = engine.projectHistoryRevision();
    state.playbackProjectEpoch = 0;
    state.playbackProjectRevision = 0;
    const auto publishedGraph = engine.mixGraph();
    if (publishedGraph != nullptr) {
        state.playbackProjectEpoch = publishedGraph->projectEpoch;
        state.playbackProjectRevision = publishedGraph->projectHistoryRevision;
    }
    state.lastHistoryRequestId = lastHistoryRequestId_;
    state.historyResults.assign(historyResults_.begin(), historyResults_.end());
    state.editorCommandResults.assign(editorCommandResults_.begin(), editorCommandResults_.end());

    state.songs.reserve(proj.songs.size());
    for (const SongDef& song : proj.songs) {
        WebUiState::SongRow row;
        row.name = song.name;
        row.bpm = song.bpm;
        row.autoplay = (song.onEnded == SongEnd::Next);
        row.tsNum = song.timeSignature.numerator;
        row.tsDen = song.timeSignature.denominator;
        row.endSeconds = song.endSeconds;
        // Metronome is project-global — mirror onto every song row so older
        // SPA code that still reads song.click / song.clickSends stays correct.
        row.click = proj.click.enabled;
        row.clickBusId = routeIdOf(proj.click.output);
        row.clickGainDb = proj.click.gainDb;
        for (const SendConfig& cs : proj.click.output.sends) {
            WebUiState::SongRow::ClickSendRow csr;
            csr.busId = cs.bus;
            csr.level = cs.level;
            csr.enabled = cs.enabled;
            row.clickSends.push_back(std::move(csr));
        }

        row.regions.reserve(song.regions.size());
        for (const Region& r : song.regions) {
            WebUiState::SongRow::RegionRow rr;
            rr.id = r.id;
            rr.trackId = r.trackId;
            rr.startSeconds = r.startSeconds;
            rr.durationSeconds = r.durationSeconds;
            rr.gainDb = r.gainDb;
            rr.source.file = r.source.file;
            rr.source.offsetSeconds = r.source.offsetSeconds;
            rr.fade.inSeconds = r.fade.inSeconds;
            rr.fade.outSeconds = r.fade.outSeconds;
            rr.fade.inCurve = r.fade.inCurve;
            rr.fade.outCurve = r.fade.outCurve;
            rr.loop.enabled = r.loop.enabled;
            rr.loop.lengthSeconds = r.loop.lengthSeconds;
            rr.playback.speed = r.playback.speed;
            rr.playback.semitones = r.playback.semitones;
            rr.playback.reverse = r.playback.reverse;
            rr.automationLanes = copyAutomationLanes(r.automationLanes);
            row.regions.push_back(std::move(rr));
        }
        row.automationLanes = copyAutomationLanes(song.automationLanes);

        row.events.reserve(song.events.size());
        for (const TimelineEvent& e : song.events) {
            WebUiState::SongRow::EventRow er;
            er.id = e.id;
            er.type = builder_json::eventTypeToWebString(e.type);
            er.timeSeconds = e.timeSeconds;
            er.triggerOnLoad = e.triggerOnLoad;
            er.latencyMs = e.latencyCompensationMs;
            er.midiChannel = e.midiChannel;
            er.midiProgram = e.midiProgram;
            er.midiCC = e.midiCC;
            er.midiCCValue = e.midiCCValue;
            er.midiNote = e.midiNote;
            er.midiVelocity = e.midiVelocity;
            er.httpUrl = e.httpUrl.value_or("");
            row.events.push_back(std::move(er));
        }

        row.sections.reserve(song.sections.size());
        for (const SongSection& sec : song.sections) {
            WebUiState::SongRow::SectionRow sr;
            sr.id = sec.id;
            sr.name = sec.name;
            sr.startSeconds = sec.startSeconds;
            sr.colorIndex = sec.colorIndex;
            row.sections.push_back(std::move(sr));
        }

        row.lightCues.reserve(song.lightCues.size());
        for (const LightCue& lc : song.lightCues) {
            WebUiState::SongRow::LightCueRow lcr;
            lcr.id = lc.id;
            lcr.trackId = lc.trackId;
            lcr.startSeconds = lc.startSeconds;
            lcr.durationSeconds = lc.durationSeconds;
            lcr.color.r = lc.color.r;
            lcr.color.g = lc.color.g;
            lcr.color.b = lc.color.b;
            lcr.intensity = lc.intensity;
            lcr.fade.inSeconds = lc.fade.inSeconds;
            lcr.fade.outSeconds = lc.fade.outSeconds;
            lcr.label = lc.label.value_or("");
            lcr.effect.type = lc.effect.type.value_or("");
            lcr.effect.sourceType = lc.effect.sourceType;
            lcr.effect.sourceId = lc.effect.sourceId.value_or("");
            lcr.effect.intensity = lc.effect.intensity;
            lcr.effect.tempoSync = lc.effect.tempoSync;
            lcr.effect.tempoSubdivision = lc.effect.tempoSubdivision;
            lcr.effect.rateHz = lc.effect.rateHz;
            lcr.gradient.preset = lc.gradient.preset;
            lcr.gradient.colors = lc.gradient.colors.value_or("");
            lcr.blendMode = lc.blendMode;
            row.lightCues.push_back(std::move(lcr));
        }

        row.midiRegions.reserve(song.midiRegions.size());
        for (const auto& mr : song.midiRegions) {
            WebUiState::SongRow::MidiRegionRow mrr;
            mrr.id = mr.id;
            mrr.trackId = mr.trackId;
            mrr.name = mr.name;
            mrr.startBeats = mr.startBeats;
            mrr.durationBeats = mr.durationBeats;
            mrr.clipOffsetBeats = mr.clipOffsetBeats;
            mrr.loop = mr.loop;
            mrr.loopLengthBeats = mr.loopLengthBeats;
            mrr.loopStartBeats = mr.loopStartBeats;
            mrr.muted = mr.muted;
            mrr.color = mr.color;
            mrr.notes.reserve(mr.notes.size());
            for (const auto& n : mr.notes) {
                WebUiState::SongRow::MidiRegionRow::Note nr;
                nr.id = n.id;
                nr.pitch = n.pitch;
                nr.startBeats = n.startBeats;
                nr.durationBeats = n.durationBeats;
                nr.velocity = n.velocity;
                nr.releaseVelocity = n.releaseVelocity;
                nr.probability = n.probability;
                nr.pan = n.pan;
                nr.tuningOffsetCents = n.tuningOffsetCents;
                nr.muted = n.muted;
                nr.channel = n.channel;
                if (n.midi2) {
                    WebUiState::SongRow::MidiRegionRow::Note::Midi2Data midi2;
                    midi2.group = n.midi2->group;
                    midi2.velocity = n.midi2->velocity;
                    midi2.releaseVelocity = n.midi2->releaseVelocity;
                    midi2.attributeType = n.midi2->attributeType;
                    midi2.attributeData = n.midi2->attributeData;
                    nr.midi2 = midi2;
                }
                mrr.notes.push_back(std::move(nr));
            }
            mrr.events.reserve(mr.events.size());
            for (const auto& event : mr.events) {
                WebUiState::SongRow::MidiRegionRow::MidiEvent rowEvent;
                rowEvent.beat = event.beat;
                rowEvent.status = event.status;
                rowEvent.data.reserve(event.data.size());
                for (uint8_t byte : event.data) rowEvent.data.push_back(byte);
                mrr.events.push_back(std::move(rowEvent));
            }
            mrr.umpEvents.reserve(mr.umpEvents.size());
            for (const auto& event : mr.umpEvents) {
                WebUiState::SongRow::MidiRegionRow::UmpEvent rowEvent;
                rowEvent.beat = event.beat;
                rowEvent.words = event.words;
                rowEvent.wordCount = event.wordCount;
                mrr.umpEvents.push_back(std::move(rowEvent));
            }
            mrr.automationLanes = copyAutomationLanes(mr.automationLanes);
            row.midiRegions.push_back(std::move(mrr));
        }

        row.tempoPoints.reserve(song.tempoPoints.size());
        for (const auto& tp : song.tempoPoints) {
            WebUiState::SongRow::TempoPointRow tpr;
            tpr.beat = tp.beat;
            tpr.bpm = tp.bpm;
            tpr.timeSeconds = tp.timeSeconds;
            tpr.curve = tp.curve;
            row.tempoPoints.push_back(std::move(tpr));
        }

        row.signaturePoints.reserve(song.signaturePoints.size());
        for (const auto& sp : song.signaturePoints) {
            WebUiState::SongRow::SignaturePointRow spr;
            spr.beat = sp.beat;
            spr.numerator = sp.numerator;
            spr.denominator = sp.denominator;
            spr.bar = sp.bar;
            row.signaturePoints.push_back(std::move(spr));
        }

        state.songs.push_back(std::move(row));
    }

    // Project-wide cycle (one zone; songIndex binds left/right to a song).
    state.cycle.active = proj.cycle.active;
    state.cycle.skip = proj.cycle.skip;
    state.cycle.startSeconds = proj.cycle.startSeconds;
    state.cycle.endSeconds = proj.cycle.endSeconds;
    state.cycle.songIndex = proj.cycle.songIndex;

    if (state.songIndex >= 0 && static_cast<size_t>(state.songIndex) < proj.songs.size()) {
        const SongDef& song = proj.songs[static_cast<size_t>(state.songIndex)];
        state.songName = song.name;
        state.bpm = song.bpm;
    }

    state.meters.reserve(engine.busCount());
    for (size_t i = 0; i < engine.busCount(); ++i) {
        WebUiState::MeterRow m;
        m.id = engine.busIdAt(i);
        // Interval-max peaks so short impulses (metronome on this bus) are not
        // lost between UI polls — see AudioEngine::consumeBusMeterInterval().
        {
            const MeterFrame frame = engine.consumeBusMeterInterval(i);
            m.peakDb = frame.peakDb;
            m.peakDbL = frame.peakDbL;
            m.peakDbR = frame.peakDbR;
            m.intervalPeakDbL = frame.intervalPeakDbL;
            m.intervalPeakDbR = frame.intervalPeakDbR;
            m.shortTermLufs = frame.shortTermLufs;
        }
        state.meters.push_back(std::move(m));
    }

    const auto& projTracks = proj.tracks;

    state.tracks.reserve(projTracks.size());
    for (size_t i = 0; i < projTracks.size(); ++i) {
        const TrackDef& def = projTracks[i];
        WebUiState::TrackRow tr;
        tr.id = def.id;
        tr.name = def.name.empty() ? def.id : def.name;
        tr.kind = trackKindToString(def.kind);
        tr.stripId = def.effectiveStripId();
        tr.channels = def.channels;
        tr.gainDb = def.gainDb;
        tr.pan = def.pan;
        tr.panLaw = panLawToString(def.panLaw);
        tr.mute = def.mute;
        tr.solo = def.solo;
        tr.soloSafe = def.soloSafe;
        tr.soloGroup = engine.trackSoloGroup();
        tr.soloActiveInGroup = engine.anySoloInGroup(tr.soloGroup.c_str());
        tr.recordArmed = def.recordArmed;
        tr.inputMonitoring = def.inputMonitoring;
        tr.inputSource = def.inputSource;
        tr.midiInputChannel = def.midiInputChannel;
        tr.midiInputDevice = def.midiInputDevice;
        tr.inputTrimDb = def.inputTrimDb;
        tr.phaseInvert = def.phaseInvert;
        tr.polarity = polarityToString(def.polarity);
        tr.plugins = copyPluginSlots(def.plugins);
        // The project serializer's mapping, not a second copy of it. The copy
        // that used to live here had drifted: it had no case for
        // OutputType::Bus and folded it into a `default:` of "main", so a
        // track whose main route is an aux/group bus was published to the web
        // UI as routed to Main -- the mixer showed the wrong destination and
        // sourceOutputBusId() resolved it to "audio::main" instead of the bus
        // id. -Wswitch-enum is what surfaced it.
        tr.output.type = outputTypeToString(def.output.type);
        tr.output.target = def.output.target.value_or("");
        for (const auto& send : def.output.sends) {
            WebUiState::TrackRow::SendRow sr;
            sr.bus = send.bus;
            sr.level = send.level;
            sr.preFader = send.preFader || (send.tap == SendTap::PreFader);
            sr.enabled = send.enabled;
            sr.lowLatencySafe = send.lowLatencySafe;
            sr.tap = sendTapToString(send.tap != SendTap::PostPan ? send.tap : (send.preFader ? SendTap::PreFader : SendTap::PostPan));
            tr.output.sends.push_back(std::move(sr));
        }

        // Interval-max peaks so short impulses on tracks are not lost between
        // UI polls -- same pattern as buses/click (consumeBusMeterInterval).
        {
            const MeterFrame frame = engine.consumeTrackMeterInterval(i);
            tr.peakDb = frame.peakDb;
            tr.peakDbL = frame.peakDbL;
            tr.peakDbR = frame.peakDbR;
        }
        state.tracks.push_back(std::move(tr));
    }

    state.busses.reserve(engine.busCount());
    for (size_t i = 0; i < engine.busCount(); ++i) {
        WebUiState::BusRow br;
        br.id = engine.busIdAt(i);
        br.name = engine.busNameAt(i);
        br.gainDb = engine.busGainDb(i);
        br.mute = engine.isBusMuted(i);
        br.solo = engine.isBusSoloed(i);
        br.soloSafe = engine.isBusSoloSafe(i);
        br.soloGroup = engine.busSoloGroupAt(i);
        br.soloActiveInGroup = engine.anySoloInGroup(br.soloGroup.c_str());
        br.startChannel = engine.busStartChannelAt(i);
        br.channels = engine.busChannelCountAt(i);
        br.isDirectOut = engine.busIsDirectAt(i);
        br.unavailable = engine.busIsDirectAt(i) && !engine.busAvailableAt(i);
        const auto sendIt = std::find_if(proj.sends.begin(), proj.sends.end(),
            [&](const SendBus& s) { return s.id == br.id; });
        if (br.id == "audio::main") {
            br.pan = proj.main.pan;
            br.isAux = false;
            br.plugins = copyPluginSlots(proj.main.plugins);
        } else if (sendIt != proj.sends.end()) {
            br.pan = sendIt->pan;
            br.isAux = true;
            br.plugins = copyPluginSlots(sendIt->plugins);
        } else {
            br.pan = 0.0;
            br.isAux = false;
        }
        // Peaks already consumed into state.meters above; re-read LUFS frame
        // for bus rows without double-clearing the interval max. Prefer the
        // same interval peaks so mixer strips match the master meters array.
        if (i < state.meters.size() && state.meters[i].id == br.id) {
            br.peakDb = state.meters[i].peakDb;
            br.peakDbL = state.meters[i].peakDbL;
            br.peakDbR = state.meters[i].peakDbR;
        } else {
            const MeterFrame frame = engine.consumeBusMeterInterval(i);
            br.peakDb = frame.peakDb;
            br.peakDbL = frame.peakDbL;
            br.peakDbR = frame.peakDbR;
        }
        state.busses.push_back(std::move(br));
    }

    // Show automation on the actual live fader/knob values, not by rewriting
    // persisted gain/pan fields in the UI snapshot. Only the graph that
    // exactly matches this project publication may drive these values; while
    // a replacement graph is being prepared the controls safely fall back to
    // their last authoritative manual values.
    if (state.playing && publishedGraph != nullptr
        && publishedGraph->projectEpoch == state.projectEpoch
        && publishedGraph->projectHistoryRevision == state.stateRevision
        && publishedGraph->playbackState != nullptr
        && publishedGraph->playbackState->projectEpoch == state.projectEpoch
        && publishedGraph->stripAutomation != nullptr
        && state.songIndex >= 0
        && static_cast<size_t>(state.songIndex) < proj.songs.size()) {
        const auto* playbackSong = publishedGraph->playbackState->songAt(
            static_cast<size_t>(state.songIndex));
        if (playbackSong != nullptr && playbackSong->tempoMap != nullptr) {
            const double beat = playbackSong->tempoMap->secondsToBeats(
                state.playheadSeconds);
            publishedGraph->stripAutomation->visitControlValues(
                static_cast<size_t>(state.songIndex), beat,
                publishedGraph->manualAutomationLaneOverrides.get(),
                [&](const StripAutomationPlan::EvaluatedValue& value) {
                    if (value.stripIndex >= publishedGraph->strips.size())
                        return;
                    const MixStrip& strip =
                        publishedGraph->strips[value.stripIndex];
                    WebUiState::TrackRow* track = nullptr;
                    WebUiState::BusRow* bus = nullptr;
                    bool click = false;
                    if (strip.kind == StripKind::Track
                        && strip.projectIndex < state.tracks.size()
                        && state.tracks[strip.projectIndex].id == strip.id) {
                        track = &state.tracks[strip.projectIndex];
                    } else if (strip.kind == StripKind::Click) {
                        click = (strip.id == "audio::click");
                    } else if (strip.kind == StripKind::Main
                               && !state.busses.empty()
                               && state.busses.front().id == strip.id) {
                        bus = &state.busses.front();
                    } else if (strip.kind == StripKind::Send) {
                        const size_t busIndex =
                            static_cast<size_t>(strip.projectIndex) + 1;
                        if (busIndex < state.busses.size()
                            && state.busses[busIndex].id == strip.id)
                            bus = &state.busses[busIndex];
                    }
                    if (value.parameter == StripAutomationPlan::Parameter::GainDb) {
                        if (track != nullptr)
                            track->automatedGainDb = value.value;
                        else if (bus != nullptr)
                            bus->automatedGainDb = value.value;
                        else if (click)
                            state.clickAutomatedGainDb = value.value;
                    } else if (value.parameter == StripAutomationPlan::Parameter::Pan) {
                        if (track != nullptr)
                            track->automatedPan = value.value;
                        else if (bus != nullptr)
                            bus->automatedPan = value.value;
                        else if (click)
                            state.clickAutomatedPan = value.value;
                    }
                });
        }
    }

    // Signal-flow diagram data: a direct projection of the graph the audio
    // thread is rendering right now. Deliberately a copy of the engine's own
    // structure rather than a re-derivation -- the whole value of the diagram
    // is that it cannot disagree with what you hear.
    state.mixGraph.strips.clear();
    state.mixGraph.edges.clear();
    if (publishedGraph != nullptr) {
        state.mixGraph.strips.reserve(publishedGraph->strips.size());
        for (const MixStrip& strip : publishedGraph->strips) {
            WebUiState::MixGraphRow::StripRow row;
            row.id = strip.id;
            row.name = strip.name;
            row.kind = stripKindName(strip.kind);
            row.soloGroup = soloGroupName(strip.soloGroup);
            row.channels = strip.channels;
            // The graph stores linear gain; the diagram labels dB like every
            // other surface does.
            row.gainDb = strip.gainLinear > 0.0f
                             ? 20.0 * std::log10(static_cast<double>(strip.gainLinear))
                             : -144.0;
            row.pan = strip.pan;
            row.mute = strip.mute;
            row.solo = strip.solo;
            row.soloSafe = strip.soloSafe;
            row.audible = strip.audible;
            row.physicalChannel = strip.physicalChannel;
            // Live level, so the diagram shows which paths are actually
            // carrying signal rather than only how they are wired.
            if (strip.kind == StripKind::Click) {
                row.peakDb = state.clickPeakDb;
            } else if (strip.kind == StripKind::Track) {
                if (strip.projectIndex < state.tracks.size())
                    row.peakDb = state.tracks[strip.projectIndex].peakDb;
            } else {
                for (const auto& bus : state.busses) {
                    if (bus.id == strip.id) {
                        row.peakDb = bus.peakDb;
                        break;
                    }
                }
            }
            state.mixGraph.strips.push_back(std::move(row));
        }
        state.mixGraph.edges.reserve(publishedGraph->edges.size());
        for (const MixEdge& edge : publishedGraph->edges) {
            if (edge.from >= publishedGraph->strips.size()
                || edge.to >= publishedGraph->strips.size())
                continue;
            WebUiState::MixGraphRow::EdgeRow row;
            row.from = publishedGraph->strips[edge.from].id;
            row.to = publishedGraph->strips[edge.to].id;
            row.level = static_cast<double>(edge.gainLinear) * 100.0;
            row.preFader = edge.preFader;
            row.active = edge.active;
            row.sourceChannel = edge.sourceChannel;
            state.mixGraph.edges.push_back(std::move(row));
        }
    }

    state.lighting.enabled = proj.lighting.enabled;
    state.lighting.kind = lightingKindToString(proj.lighting.kind);
    state.lighting.resolight.columns = proj.lighting.resolight.columns;
    state.lighting.resolight.rows = proj.lighting.resolight.rows;
    state.lighting.idle.behavior = proj.lighting.idle.behavior;
    state.lighting.idle.color.r = proj.lighting.idle.color.r;
    state.lighting.idle.color.g = proj.lighting.idle.color.g;
    state.lighting.idle.color.b = proj.lighting.idle.color.b;
    state.lighting.idle.intensity = proj.lighting.idle.intensity;
    state.lighting.idle.effect.type = proj.lighting.idle.effect.type;
    state.lighting.idle.effect.rateHz = proj.lighting.idle.effect.rateHz;
    state.lighting.idle.gradient.preset = proj.lighting.idle.gradient.preset;
    state.lighting.idle.gradient.colors = proj.lighting.idle.gradient.colors.value_or("");
    state.lighting.defaultRefreshRateHz = proj.lighting.defaultRefreshRateHz;
    state.lighting.fixtures.reserve(proj.lighting.fixtures.size());
    for (const LightFixture& f : proj.lighting.fixtures) {
        WebUiState::LightFixtureRow fr;
        fr.id = f.id;
        fr.name = f.name;
        fr.kind = lightFixtureKindToString(f.kind);
        fr.grid.column = f.grid.column;
        fr.grid.row = f.grid.row;
        fr.ledCount = f.ledCount;
        fr.addressable = f.addressable;
        fr.position.x = f.position.x;
        fr.position.y = f.position.y;
        fr.position.z = f.position.z;
        fr.rotation.y = f.rotation.y;
        fr.mountedHorizontally = f.mountedHorizontally;
        fr.dmx.universe = f.dmx.universe;
        fr.dmx.startChannel = f.dmx.startChannel;
        fr.dmx.channelCount = f.dmx.channelCount;
        fr.shape = f.shape;
        fr.matrixColumns = f.matrixColumns;
        fr.channelProfile = f.channelProfile;
        fr.tiltDegrees = f.tiltDegrees;
        fr.refreshRateHz = f.refreshRateHz;
        fr.networkHost = f.networkHost.value_or("");
        if (f.networkHost.has_value() && !f.networkHost->empty()) {
            const auto link = engine.lightHardware().fixtureLinkStatus(f.id);
            fr.hwConfigured = link.configured;
            fr.hwConnected = link.connected;
            fr.hwRssiDbm = link.rssiDbm;
            fr.hwChipType = link.chipType;
        }
        state.lighting.fixtures.push_back(std::move(fr));
    }
    state.lighting.artNetTargetHost = proj.lighting.artNetTargetHost.value_or("");
    {
        const auto boards = engine.lightHardware().discoveredBoards();
        state.lighting.discoveredBoards.reserve(boards.size());
        for (const auto& b : boards) {
            WebUiState::DiscoveredBoardRow row;
            row.mac = b.mac;
            row.ip = b.ip;
            row.name = b.name;
            row.chipType = b.chipType;
            row.lastSeenSecondsAgo = b.lastSeenSecondsAgo;
            state.lighting.discoveredBoards.push_back(std::move(row));
        }
    }

    state.lighting.tracks.reserve(proj.lighting.tracks.size());
    for (const LightTrack& lt : proj.lighting.tracks) {
        WebUiState::LightingRow::LightTrackRow ltr;
        ltr.id = lt.id;
        ltr.name = lt.name;
        ltr.fixtureIds = lt.fixtureIds;
        state.lighting.tracks.push_back(std::move(ltr));
    }

    // Backend-authoritative resolved lamp state -- the exact same
    // engine/lighting/LightOutputResolver.h call LightEngine's real-time DMX
    // thread makes, so the live preview can never drift from what the real
    // hardware is doing (see RESTORE_POINT.md Feature 6's sync fix).
    if (proj.lighting.enabled && state.songIndex >= 0
        && static_cast<size_t>(state.songIndex) < proj.songs.size()) {
        const SongDef& activeSong = proj.songs[static_cast<size_t>(state.songIndex)];
        const auto& allTracks = proj.tracks;
        const auto sourceLevelDb = [this, &allTracks](const std::string& type, const std::string& id) -> SourceLevels {
            const auto toLevels = [](const MeterFrame& f) {
                SourceLevels lv;
                lv.peakDb = f.peakDb;
                for (int b = 0; b < kLightBandCount; ++b)
                    lv.bandLevel[b] = f.bandLevel[b];
                return lv;
            };
            if (type == "track") {
                for (size_t i = 0; i < allTracks.size(); ++i) {
                    if (allTracks[i].id != id)
                        continue;
                    if (const auto* m = engine.trackMeterAt(i)) {
                        MeterFrame f;
                        if (m->read(f))
                            return toLevels(f);
                    }
                    break;
                }
                return SourceLevels{};
            }
            for (size_t i = 0; i < engine.busCount(); ++i) {
                if (!id.empty() && engine.busIdAt(i) != id)
                    continue;
                if (id.empty() && i != 0)
                    continue; // empty id = master mix / first bus
                if (const auto* m = engine.busMeterAt(i)) {
                    MeterFrame f;
                    if (m->read(f))
                        return toLevels(f);
                }
                break;
            }
            return SourceLevels{};
        };

        // Re-read the live transport position right before resolving light
        // outputs.  The playhead was first sampled at the top of
        // publishWebState() (line ~999), but by the time we reach here the
        // JSON serialisation of all structural state has already run — on a
        // loaded machine that can be several ms.  The LightEngine DMX thread
        // always reads transport.playheadSeconds.load() live, so we must too
        // in order to match its output instead of trailing behind it.
        const double livePlayheadSec =
            transport.playheadSeconds.load(std::memory_order_relaxed);

        // Apply the same idle-behavior override LightEngine's real DMX thread
        // applies: while the transport is stopped with a non-"hold"
        // idleBehavior (blackout/staticColor/effect), the whole preview feed
        // fades to/from the idle target via the shared blendTowardIdle +
        // kIdleFadeSeconds, exactly like the hardware -- resuming playback
        // fades just as smoothly back out of it. This preview feed drives
        // every light preview in the SPA (Light tab, Editor's Light-mode,
        // wherever) -- the frontend draws the backend-rendered per-LED rows
        // as-is and never re-simulates idle behavior client-side anymore.
        const bool useIdleOverride = !state.playing && proj.lighting.idle.behavior != "hold";

        // Mirror of LightEngine's transition bookkeeping -- see threadLoop.
        // Each transition fires once (edge-triggered): leaving idle keys on
        // wasIdleFading only, never on an already-active resume fade, or the
        // resume fade-out would restart every frame and never progress.
        if (useIdleOverride && !lightingPreviewWasIdleFading && !lightingPreviewWasResumeFading) {
            // Fresh entry into idle (transport just stopped) -- start the
            // fade from the last pre-idle resolve, same as the DMX thread.
            lightingPreviewIdleFadeStart = std::chrono::steady_clock::now();
            lightingPreviewWasIdleFading = true;
        } else if (lightingPreviewWasResumeFading && useIdleOverride) {
            lightingPreviewLastResolved = lightingPreviewLastFrame;
            lightingPreviewIdleFadeStart = std::chrono::steady_clock::now();
            lightingPreviewWasResumeFading = false;
            lightingPreviewWasIdleFading = true;
        } else if (!useIdleOverride && lightingPreviewWasIdleFading) {
            lightingPreviewResumeFrom = lightingPreviewLastFrame;
            lightingPreviewResumeFadeStart = std::chrono::steady_clock::now();
            lightingPreviewWasResumeFading = true;
            lightingPreviewWasIdleFading = false;
        }

        // When a fade is genuinely in progress (0 < blendT < 1), these mirror
        // LightEngine::threadLoop's blendFrom/blendTo/blendT so the per-LED
        // preview loop below can crossfade each LED individually instead of
        // rendering the pre-blended aggregate `resolved` -- keeps the web
        // preview's per-pixel look identical to the real DMX output during
        // idle transitions (see resolveLedWireColorsBlended's doc comment).
        std::vector<ResolvedFixtureOutput> resolved;
        std::vector<ResolvedFixtureOutput> blendFrom;
        std::vector<ResolvedFixtureOutput> blendTo;
        double blendT = 1.0;
        if (lightingPreviewWasResumeFading) {
            // Fading back from idle to the normal cue resolve. Fixtures the
            // idle state turned on but that no cue drives anymore get an
            // explicit off-row so they fade to black instead of snapping.
            auto normal = resolveLightOutputs(
                proj.lighting.tracks, activeSong.lightCues, livePlayheadSec, activeSong.bpm, sourceLevelDb);
            const double t = std::chrono::duration<double>(
                                 std::chrono::steady_clock::now() - lightingPreviewResumeFadeStart)
                                 .count() /
                             kResumeFadeSeconds;
            if (t >= 1.0) {
                resolved = std::move(normal);
                lightingPreviewWasResumeFading = false;
            } else {
                for (const auto& rf : lightingPreviewResumeFrom) {
                    bool found = false;
                    for (const auto& n : normal)
                        if (n.fixtureId == rf.fixtureId) { found = true; break; }
                    if (!found) {
                        ResolvedFixtureOutput stub;
                        stub.fixtureId = rf.fixtureId;
                        normal.push_back(std::move(stub));
                    }
                }
                resolved = blendTowardIdle(lightingPreviewResumeFrom, normal, t);
                blendFrom = lightingPreviewResumeFrom;
                blendTo = normal;
                blendT = t;
            }
            lightingPreviewLastResolved = resolved;
        } else if (lightingPreviewWasIdleFading) {
            // Fading into (and then sustaining) the idle target. effectPhase
            // is wall-clock seconds since the fade began -- consumed by the
            // "effect" idle mode so the effect animates while stopped.
            const double effectPhase = std::chrono::duration<double>(
                                           std::chrono::steady_clock::now() - lightingPreviewIdleFadeStart)
                                           .count();
            const auto target = buildIdleTarget(proj.lighting.fixtures, proj.lighting.idle.behavior,
                                                proj.lighting.idle.color.r, proj.lighting.idle.color.g,
                                                proj.lighting.idle.color.b, proj.lighting.idle.intensity,
                                                proj.lighting.idle.effect.type, proj.lighting.idle.effect.rateHz,
                                                proj.lighting.idle.gradient.preset, proj.lighting.idle.gradient.colors.value_or(""),
                                                effectPhase);
            const double t = effectPhase / kIdleFadeSeconds;
            resolved = blendTowardIdle(lightingPreviewLastResolved, target, t);
            if (t < 1.0) {
                blendFrom = lightingPreviewLastResolved;
                blendTo = target;
                blendT = t;
            }
        } else {
            resolved = resolveLightOutputs(
                proj.lighting.tracks, activeSong.lightCues, livePlayheadSec, activeSong.bpm, sourceLevelDb);
            lightingPreviewLastResolved = resolved;
        }
        lightingPreviewLastFrame = resolved;

        // Fixture id -> project fixture array index, the wire key the binary
        // per-LED stream uses so the frontend can map colors back to its own
        // lighting.fixtures array without shipping ids every frame.
        std::map<std::string, int> fixtureIndex;
        for (size_t fi = 0; fi < proj.lighting.fixtures.size(); ++fi)
            fixtureIndex[proj.lighting.fixtures[fi].id] = static_cast<int>(fi);

        // Only built when a fade is actually in progress -- see blendFrom's
        // doc comment above. `blendTo`/`resolved` share the same fixture
        // order (both derived by iterating the same "to" vector inside
        // blendTowardIdle); only the "from" side needs a lookup by id since
        // a fixture can be absent from it.
        std::map<std::string, const ResolvedFixtureOutput*> blendFromById;
        const bool blendActive = !blendFrom.empty() || !blendTo.empty();
        if (blendActive)
            for (const auto& f : blendFrom)
                blendFromById[f.fixtureId] = &f;

        state.lightOutput.reserve(resolved.size());
        for (size_t ri = 0; ri < resolved.size(); ++ri) {
            const auto& r = resolved[ri];
            WebUiState::LightOutputRow lor;
            lor.fixtureId = r.fixtureId;
            lor.fixtureIdx = fixtureIndex[r.fixtureId]; // -1 if missing from the rig
            if (lor.fixtureIdx >= 0) {
                const auto& fixture = proj.lighting.fixtures[static_cast<size_t>(lor.fixtureIdx)];
                std::vector<LedWireColor> wire;
                if (blendActive) {
                    static const ResolvedFixtureOutput kBlackFallback{};
                    const ResolvedFixtureOutput* fromEntry = &kBlackFallback;
                    if (auto it = blendFromById.find(r.fixtureId); it != blendFromById.end())
                        fromEntry = it->second;
                    wire = resolveLedWireColorsBlended(*fromEntry, blendTo[ri], fixture, blendT);
                } else {
                    wire = resolveLedWireColors(r, fixture);
                }
                lor.ledColors.reserve(wire.size());
                for (const auto& c : wire) {
                    // The preview has no separate white channel to render --
                    // add w back into r/g/b (real RGBW hardware's white diode
                    // visually brightens/desaturates the same way) so an
                    // "rgbw" fixture doesn't preview as near-black just
                    // because most of a white cue color got routed onto the
                    // W wire instead of R/G/B.
                    const int r2 = std::min(255, static_cast<int>(c.r) + c.w);
                    const int g2 = std::min(255, static_cast<int>(c.g) + c.w);
                    const int b2 = std::min(255, static_cast<int>(c.b) + c.w);
                    lor.ledColors.push_back({r2, g2, b2});
                }
            }
            state.lightOutput.push_back(std::move(lor));
        }
    }

    state.cpuPercent = health.totalCpuPercent;
    state.rssBytes = health.totalRssBytes;
    state.freeBytes = health.systemFreeBytes;
    state.systemTotalBytes = health.systemTotalBytes;
    state.cpuCoreCount = health.cpuCoreCount;
    state.underrunCount = health.underrunCount;
    state.audioCallbackCount = health.audioCallbackCount;
    state.silentBlockCount = health.silentBlockCount;
    state.pitchBlockCount = health.pitchBlockCount;
    state.pluginMissedOutputBlocks = health.pluginMissedOutputBlocks;
    state.pluginMissedInputBlocks = health.pluginMissedInputBlocks;
    state.pluginMissedControlEvents = health.pluginMissedControlEvents;
    state.pluginRejectedMidiEvents = health.pluginRejectedMidiEvents;
    // Sourced from the streaming layer rather than SystemHealth so telemetry/
    // keeps no dependency on audio/.
    state.streamStarveCount = engine.streamStarveCount();
    {
        const auto cb = engine.callbackTimingSnapshot();
        state.callbackWorstRatio = cb.worstRatio;
        state.callbackWorstMs = cb.worstWallMs;
        state.callbackWorstCpuShare = cb.worstCpuShare;
        state.callbackComputeStalls = cb.computeStalls;
        state.callbackPreemptedStalls = cb.preemptedStalls;
        state.callbackOverruns = cb.buckets[static_cast<size_t>(CallbackBucket::Over100)];
    }
    state.outputLatencySamples = static_cast<int>(engine.outputLatencySamples());
    state.outputLatencyMs = engine.outputLatencySeconds() * 1000.0;
    state.hostTimeSkewMs = static_cast<double>(engine.hostTimeSkew()) / 1.0e6;
    // A throttled laptop is the one cause of a dropout that every other number
    // here reports as healthy. See platform/ThermalState.h.
    state.thermalState = thermalStateName(currentThermalState());
    state.diskReadBytesPerSec = health.diskReadBytesPerSec;
    state.diskWriteBytesPerSec = health.diskWriteBytesPerSec;
    state.webClientCount = webServer.clientCount();
    state.processes.clear();
    for (const auto& p : health.processes) {
        WebUiState::ProcessEntry pe;
        pe.pid = p.pid;
        pe.name = p.name;
        pe.rssBytes = p.rssBytes;
        pe.cpuPercent = p.cpuPercent;
        state.processes.push_back(std::move(pe));
    }
    engine.health().setWebClientCount(state.webClientCount);

    populateSettingsState(state.settings);

    webServer.publishState(state);
}

} // namespace resostage
