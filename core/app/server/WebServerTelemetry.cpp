/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "WebServer.h"
#include "server/WireTypes.h"
#include "server/BuilderJson.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <utility>
#include <juce_core/juce_core.h>

namespace resostage {

using namespace wire;

namespace {
double finiteOrZero(double v);

WPluginSlotTelemetry pluginSlotToWire(const WebUiState::PluginSlotRow& slot) {
    WPluginSlotTelemetry wire;
    wire.id = slot.id;
    wire.pluginId = slot.pluginId;
    wire.name = slot.name;
    wire.manufacturer = slot.manufacturer;
    wire.format = slot.format;
    wire.instrument = slot.instrument;
    wire.bypassed = slot.bypassed;
    wire.hasState = slot.hasState;
    wire.keepAwake = slot.keepAwake;
    wire.powerState = slot.powerState;
    wire.loadState = slot.loadState;
    wire.loadError = slot.loadError;
    return wire;
}

WAutomationLaneTelemetry automationLaneToWire(const WebUiState::AutomationLaneRow& lane) {
    WAutomationLaneTelemetry wire;
    wire.id = lane.id;
    wire.target.domain = lane.target.domain;
    wire.target.entityId = lane.target.entityId;
    wire.target.parameterId = lane.target.parameterId;
    wire.target.valueType = lane.target.valueType;
    wire.target.defaultValue = finiteOrZero(lane.target.defaultValue);
    wire.target.minValue = finiteOrZero(lane.target.minValue);
    wire.target.maxValue = finiteOrZero(lane.target.maxValue);
    wire.scope = lane.scope;
    wire.enabled = lane.enabled;
    wire.muted = lane.muted;
    wire.writeMode = lane.writeMode;
    wire.points.reserve(lane.points.size());
    for (const auto& point : lane.points) {
        WAutomationPointTelemetry wirePoint;
        wirePoint.timeBeats = finiteOrZero(point.timeBeats);
        wirePoint.value = finiteOrZero(point.value);
        wirePoint.curve = finiteOrZero(point.curve);
        wire.points.push_back(std::move(wirePoint));
    }
    return wire;
}


// Guards against NaN/Inf reaching the wire: ostringstream would emit "nan"/
// "inf" tokens, which are not valid JSON and would make every connected
// browser's JSON.parse() throw, silently freezing the remote UI. Mirrors the
// equivalent guard in ProjectJson.cpp's writeNumber().
double finiteOrZero(double v) {
    return std::isfinite(v) ? v : 0.0;
}


// Meter levels: non-finite / absurd values must NOT become 0.0 (0 dBFS =
// full-scale bar flash). Floor them instead.
double finiteOrDbFloor(double v) {
    if (!std::isfinite(v) || v < -144.0)
        return -144.0;
    if (v > 24.0)
        return 24.0;
    return v;
}


} // namespace

void WebServer::setTargetTelemetryHz(int hz) {
    const int clamped = std::clamp(hz, kTelemetryMinHz, kTelemetryHz);
    targetTelemetryHz_.store(clamped, std::memory_order_relaxed);
    effectiveTelemetryHz_.store(clamped, std::memory_order_relaxed);
}

void WebServer::registerUDPSubscriber(const std::string& ip, int port) {
    if (ip.empty() || port <= 0 || port > 65535)
        return;
    // libwebsockets may report an IPv4 peer through an IPv6-mapped address.
    // DatagramSocket's IPv4 write expects the dotted quad.
    const std::string normalizedIp = ip.rfind("::ffff:", 0) == 0 ? ip.substr(7) : ip;
    const double nowSec = juce::Time::getMillisecondCounterHiRes() * 0.001;
    std::lock_guard<std::mutex> lock(udpSubscribersMutex_);
    for (auto& s : udpSubscribers_) {
        if (s.ip == normalizedIp && s.port == port) {
            s.lastSeenSec = nowSec;
            return;
        }
    }
    udpSubscribers_.push_back({normalizedIp, port, nowSec});
}

std::string WebServer::buildStateJson(const char* view) const {
    WebUiState snap;
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        snap = state;
    }

    // View scopes the heavy arrays. Transport / time / status always go out.
    // REST calls with view=nullptr/"all" get the full snapshot.
    const bool all = (view == nullptr || view[0] == '\0'
                      || std::strcmp(view, "all") == 0);
    const bool isPlayer = all || std::strcmp(view, "player") == 0;
    const bool isMixer = all || std::strcmp(view, "mixer") == 0;
    const bool isEditor = all || std::strcmp(view, "editor") == 0
                          || std::strcmp(view, "builder") == 0;
    const bool isSettings = all || std::strcmp(view, "settings") == 0;
    const bool isLight = all || std::strcmp(view, "light") == 0;

    // Songs: player + editor (timeline/hotkeys). Editor needs full detail.
    // Light also needs songs -- the rig editor resolves the active song's bpm
    // and light cues for its preview (see ProjectLightingPanel.tsx).
    const bool wantSongs = all || isPlayer || isEditor || isMixer || isLight;
    const bool wantSongsFull = all || isEditor; // events, full region fades, clickSends
    const bool wantMeters = all || isPlayer || isMixer;
    const bool wantTracks = all || isPlayer || isMixer || isEditor;
    const bool wantBusses = all || isPlayer || isMixer || isEditor;
    const bool wantClick = all || isPlayer || isMixer;
    const bool wantHealth = all || isPlayer || isSettings;
    const bool wantHealthProcs = all || isSettings;
    const bool wantSettingsFull = true;
    // Explicit-request only, never part of "all": the diagram is a modal the
    // user opens on purpose, and the graph has no business riding along in
    // every 30 Hz frame or in a plain /api/v1/state call.
    const bool wantMixGraph =
        view != nullptr && std::strcmp(view, "mixgraph") == 0;
    (void)isSettings; // still used for midiBindings detail below

    WEngineTelemetryPayload wire;

    wire.projectName = snap.projectName;
    const auto& loading = snap.pluginLoading;
    wire.pluginLoading = {loading.epoch, loading.generation, loading.phase,
        loading.blocksPlayback, loading.showDialog, loading.playRequested,
        loading.total, loading.completed, loading.failed,
        loading.currentName, loading.error};
    wire.songName = snap.songName;
    wire.activeTrackId = snap.activeTrackId;
    wire.playheadSeconds = finiteOrZero(snap.playheadSeconds);
    wire.globalPlayheadSeconds = finiteOrZero(snap.globalPlayheadSeconds);
    wire.globalBeatsElapsed = finiteOrZero(snap.globalBeatsElapsed);
    wire.sampleRate = finiteOrZero(snap.sampleRate);
    wire.drift = finiteOrZero(snap.driftFactor);
    wire.bpm = finiteOrZero(snap.bpm);
    wire.playing = snap.playing;
    wire.recording = snap.recording;
    wire.recordingCountIn = snap.recordingCountIn;
    wire.recordingCountInBeatsRemaining = snap.recordingCountInBeatsRemaining;
    wire.autoInputMonitoring = snap.autoInputMonitoring;
    wire.autoPunchEnabled = snap.autoPunchEnabled;
    wire.punchStartSample = snap.punchStartSample;
    wire.punchEndSample = snap.punchEndSample;
    wire.lowLatencyMonitoring = snap.lowLatencyMonitoring;
    wire.lowLatencyLimitMs = snap.lowLatencyLimitMs;
    wire.liveRecordings.reserve(snap.liveRecordings.size());
    for (const auto& reg : snap.liveRecordings) {
        wire::WLiveRecordingRegion wr;
        wr.recordingId = reg.recordingId;
        wr.trackId = reg.trackId;
        wr.timelineStartSample = reg.timelineStartSample;
        wr.capturedFrames = reg.capturedFrames;
        wr.channelCount = reg.channelCount;
        wr.state = static_cast<uint8_t>(reg.state);
        wr.kind = static_cast<uint8_t>(reg.kind);
        wr.midiNotes.reserve(reg.midiNotes.size());
        for (const auto& note : reg.midiNotes) {
            wire::WLiveRecordingRegion::MidiNote wn;
            wn.id = note.id;
            wn.pitch = note.pitch;
            wn.startBeats = note.startBeats;
            wn.durationBeats = note.durationBeats;
            wn.velocity = note.velocity;
            wn.active = note.active;
            wr.midiNotes.push_back(wn);
        }
        wire.liveRecordings.push_back(std::move(wr));
    }
    wire.activeMidiNotes.reserve(snap.activeMidiNotes.size());
    for (const auto& note : snap.activeMidiNotes)
        wire.activeMidiNotes.push_back({note.trackId, note.pitch, note.trackIndex});
    wire.hardwareAlarm = snap.hardwareAlarm;
    wire.songIndex = snap.songIndex;
    wire.songCount = snap.songCount;
    wire.statusMessage = snap.statusMessage;
    wire.busy = snap.busy;
    wire.quitConfirmPending = snap.quitConfirmPending;
    wire.openConfirmPending = snap.openConfirmPending;
    wire.saveAsPending = snap.saveAsPending;
    wire.uiTab = snap.uiTab;
    wire.uiTabSeq = static_cast<uint32_t>(snap.uiTabSeq);
    wire.canUndo = snap.canUndo;
    wire.canRedo = snap.canRedo;
    wire.undoLabel = snap.undoLabel;
    wire.redoLabel = snap.redoLabel;
    wire.stateSessionId = snap.stateSessionId;
    wire.projectEpoch = snap.projectEpoch;
    wire.stateRevision = snap.stateRevision;
    wire.playbackProjectEpoch = snap.playbackProjectEpoch;
    wire.playbackProjectRevision = snap.playbackProjectRevision;
    wire.lastHistoryRequestId = snap.lastHistoryRequestId;
    wire.historyResults.reserve(snap.historyResults.size());
    for (const auto& result : snap.historyResults)
        wire.historyResults.push_back({result.requestId, result.applied,
                                       result.projectRevision, result.error});
    wire.editorCommandResults.reserve(snap.editorCommandResults.size());
    for (const auto& result : snap.editorCommandResults)
        wire.editorCommandResults.push_back({result.requestId, result.applied,
            result.projectEpoch, result.projectRevision, result.error,
            result.applicationDomain,
            result.playbackApplied, result.playbackProjectEpoch,
            result.playbackRevision, result.lightingApplied});
    wire.lastAction = snap.lastAction;
    wire.lastActionNonce = static_cast<uint64_t>(std::max(0, snap.lastActionNonce));
    wire.telemetryHz = effectiveTelemetryHz();

    if (wantClick) {
        WClickTelemetry wc;
        wc.enabled = snap.click;
        wc.name = snap.clickName.empty() ? "Click" : snap.clickName;
        wc.gainDb = finiteOrZero(snap.clickGainDb);
        wc.pan = finiteOrZero(snap.clickPan);
        wc.channels = snap.clickMono ? 1 : 2;
        wc.solo = snap.clickSolo;
        wc.soloSafe = snap.clickSoloSafe;
        wc.soloGroup = snap.clickSoloGroup;
        wc.soloActiveInGroup = snap.clickSoloActiveInGroup;
        // Mirrors the on-disk SourceOutput exactly, including ext-out and
        // bus destinations -- the click is routed like any other source.
        wc.output.type = snap.clickOutputType;
        if (!snap.clickOutputTarget.empty())
            wc.output.target = snap.clickOutputTarget;
        wc.output.sends.reserve(snap.clickSends.size());
        for (const auto& cs : snap.clickSends) {
            WSendConfig wS;
            wS.bus = cs.busId;
            wS.level = finiteOrZero(cs.level);
            wS.enabled = cs.enabled;
            wc.output.sends.push_back(std::move(wS));
        }
        wc.plugins.reserve(snap.clickPlugins.size());
        for (const auto& slot : snap.clickPlugins)
            wc.plugins.push_back(pluginSlotToWire(slot));
        wire.click = std::move(wc);
        wire.clickPeakDb = finiteOrDbFloor(snap.clickPeakDb);
        wire.clickPeakDbL = finiteOrDbFloor(snap.clickPeakDbL);
        wire.clickPeakDbR = finiteOrDbFloor(snap.clickPeakDbR);
        wire.clickIntervalPeakDbL = finiteOrDbFloor(snap.clickIntervalPeakDbL);
        wire.clickIntervalPeakDbR = finiteOrDbFloor(snap.clickIntervalPeakDbR);
        wire.streamBufferMinSec = finiteOrZero(snap.streamBufferMinSec);
        wire.streamBufferAvgSec = finiteOrZero(snap.streamBufferAvgSec);
        wire.streamResidentTracks = snap.streamResidentTracks;
        wire.streamStreamingTracks = snap.streamStreamingTracks;
        wire.streamBufferUrgent = snap.streamBufferUrgent;
        wire.streamResidentMiB = finiteOrZero(snap.streamResidentMiB);
        wire.streamRingFraction = finiteOrZero(snap.streamRingFraction);
        wire.streamIoPressure = snap.streamIoPressure;
    }

    if (wantSongs) {
        std::vector<WSongTelemetry> songVec;
        songVec.reserve(snap.songs.size());
        for (const auto& song : snap.songs) {
            WSongTelemetry wSong;
            wSong.name = song.name;
            wSong.bpm = finiteOrZero(song.bpm);
            wSong.mode = song.autoplay ? "auto" : "wait";
            wSong.tsNum = song.tsNum;
            wSong.tsDen = song.tsDen;
            wSong.endSeconds = finiteOrZero(song.endSeconds);
            wSong.click = song.click;
            wSong.clickBusId = song.clickBusId;
            wSong.clickGainDb = finiteOrZero(song.clickGainDb);

            if (wantSongsFull) {
                wSong.clickSends.reserve(song.clickSends.size());
                for (const auto& cs : song.clickSends) {
                    WClickSendTelemetry wcs;
                    wcs.busId = cs.busId;
                    wcs.level = finiteOrZero(cs.level);
                    wcs.enabled = cs.enabled;
                    wSong.clickSends.push_back(std::move(wcs));
                }
            }

            wSong.regions.reserve(song.regions.size());
            for (const auto& r : song.regions) {
                WRegionTelemetry wReg;
                wReg.id = r.id;
                wReg.trackId = r.trackId;
                wReg.startSeconds = finiteOrZero(r.startSeconds);
                wReg.durationSeconds = finiteOrZero(r.durationSeconds);
                wReg.gainDb = finiteOrZero(r.gainDb);
                wReg.source.file = r.source.file;
                wReg.source.offsetSeconds = finiteOrZero(r.source.offsetSeconds);

                if (wantSongsFull || isPlayer) {
                    WRegionFade wFade;
                    wFade.inSeconds = finiteOrZero(r.fade.inSeconds);
                    wFade.outSeconds = finiteOrZero(r.fade.outSeconds);
                    wFade.inCurve = finiteOrZero(r.fade.inCurve);
                    wFade.outCurve = finiteOrZero(r.fade.outCurve);
                    wReg.fade = wFade;
                    WRegionLoop wLoop;
                    wLoop.enabled = r.loop.enabled;
                    wLoop.lengthSeconds = finiteOrZero(r.loop.lengthSeconds);
                    wReg.loop = wLoop;
                    WRegionPlaybackWire wPlay;
                    wPlay.speed = r.playback.speed;
                    wPlay.semitones = finiteOrZero(r.playback.semitones);
                    wPlay.reverse = r.playback.reverse;
                    wReg.playback = wPlay;
                }
                if (wantSongsFull) {
                    wReg.automationLanes.reserve(r.automationLanes.size());
                    for (const auto& lane : r.automationLanes)
                        wReg.automationLanes.push_back(automationLaneToWire(lane));
                }
                wSong.regions.push_back(std::move(wReg));
            }

            if (wantSongsFull) {
                wSong.automationLanes.reserve(song.automationLanes.size());
                for (const auto& lane : song.automationLanes)
                    wSong.automationLanes.push_back(automationLaneToWire(lane));
                wSong.events.reserve(song.events.size());
                for (const auto& e : song.events) {
                    WEventTelemetry wEv;
                    wEv.id = e.id;
                    wEv.type = e.type;
                    wEv.timeSeconds = finiteOrZero(e.timeSeconds);
                    wEv.triggerOnLoad = e.triggerOnLoad;
                    wEv.latencyMs = finiteOrZero(e.latencyMs);
                    wEv.midiChannel = e.midiChannel;
                    wEv.midiProgram = e.midiProgram;
                    wEv.midiCC = e.midiCC;
                    wEv.midiCCValue = e.midiCCValue;
                    wEv.midiNote = e.midiNote;
                    wEv.midiVelocity = e.midiVelocity;
                    wEv.httpUrl = e.httpUrl;
                    wSong.events.push_back(std::move(wEv));
                }
            }

            wSong.sections.reserve(song.sections.size());
            for (const auto& sec : song.sections) {
                WSectionTelemetry wSec;
                wSec.id = sec.id;
                wSec.name = sec.name;
                wSec.startSeconds = finiteOrZero(sec.startSeconds);
                wSec.colorIndex = sec.colorIndex;
                wSong.sections.push_back(std::move(wSec));
            }

            wSong.lightCues.reserve(song.lightCues.size());
            for (const auto& lc : song.lightCues) {
                WLightCueTelemetry wLc;
                wLc.id = lc.id;
                wLc.trackId = lc.trackId;
                wLc.startSeconds = finiteOrZero(lc.startSeconds);
                wLc.durationSeconds = finiteOrZero(lc.durationSeconds);
                wLc.color.r = static_cast<uint8_t>(lc.color.r);
                wLc.color.g = static_cast<uint8_t>(lc.color.g);
                wLc.color.b = static_cast<uint8_t>(lc.color.b);
                wLc.intensity = finiteOrZero(lc.intensity);
                wLc.fade.inSeconds = finiteOrZero(lc.fade.inSeconds);
                wLc.fade.outSeconds = finiteOrZero(lc.fade.outSeconds);
                wLc.label = lc.label;
                wLc.effect.type = lc.effect.type;
                wLc.effect.sourceType = lc.effect.sourceType;
                wLc.effect.sourceId = lc.effect.sourceId;
                wLc.effect.intensity = finiteOrZero(lc.effect.intensity);
                wLc.effect.tempoSync = lc.effect.tempoSync;
                wLc.effect.tempoSubdivision = lc.effect.tempoSubdivision;
                wLc.effect.rateHz = finiteOrZero(lc.effect.rateHz);
                wLc.gradient.preset = lc.gradient.preset;
                wLc.gradient.colors = lc.gradient.colors;
                wLc.blendMode = lc.blendMode;
                wSong.lightCues.push_back(std::move(wLc));
            }

            wSong.midiRegions.reserve(song.midiRegions.size());
            for (const auto& mr : song.midiRegions) {
                WMidiRegionTelemetry wMr;
                wMr.id = mr.id;
                wMr.trackId = mr.trackId;
                wMr.name = mr.name;
                wMr.startBeats = finiteOrZero(mr.startBeats);
                wMr.durationBeats = finiteOrZero(mr.durationBeats);
                wMr.clipOffsetBeats = finiteOrZero(mr.clipOffsetBeats);
                wMr.loop = mr.loop;
                wMr.loopLengthBeats = finiteOrZero(mr.loopLengthBeats);
                wMr.loopStartBeats = finiteOrZero(mr.loopStartBeats);
                wMr.muted = mr.muted;
                wMr.color = mr.color;
                if (wantSongsFull) {
                    wMr.automationLanes.reserve(mr.automationLanes.size());
                    for (const auto& lane : mr.automationLanes)
                        wMr.automationLanes.push_back(automationLaneToWire(lane));
                }
                wMr.notes.reserve(mr.notes.size());
                for (const auto& n : mr.notes) {
                    WMidiNoteTelemetry wN;
                    wN.id = n.id;
                    wN.pitch = n.pitch;
                    wN.startBeats = finiteOrZero(n.startBeats);
                    wN.durationBeats = finiteOrZero(n.durationBeats);
                    wN.velocity = n.velocity;
                    wN.releaseVelocity = n.releaseVelocity;
                    wN.probability = n.probability;
                    wN.pan = n.pan;
                    wN.tuningOffsetCents = n.tuningOffsetCents;
                    wN.muted = n.muted;
                    wN.channel = n.channel;
                    if (n.midi2) {
                        WMidiNoteTelemetry::WMidi2Data midi2;
                        midi2.group = n.midi2->group;
                        midi2.velocity = n.midi2->velocity;
                        midi2.releaseVelocity = n.midi2->releaseVelocity;
                        midi2.attributeType = n.midi2->attributeType;
                        midi2.attributeData = n.midi2->attributeData;
                        wN.midi2 = midi2;
                    }
                    wMr.notes.push_back(std::move(wN));
                }
                wMr.events.reserve(mr.events.size());
                for (const auto& event : mr.events) {
                    WMidiClipEventTelemetry wEvent;
                    wEvent.beat = finiteOrZero(event.beat);
                    wEvent.status = event.status;
                    wEvent.data.reserve(event.data.size());
                    for (int byte : event.data)
                        wEvent.data.push_back(static_cast<uint8_t>(std::clamp(byte, 0, 255)));
                    wMr.events.push_back(std::move(wEvent));
                }
                wMr.umpEvents.reserve(mr.umpEvents.size());
                for (const auto& event : mr.umpEvents) {
                    WMidiUmpEventTelemetry wEvent;
                    wEvent.beat = finiteOrZero(event.beat);
                    wEvent.words = event.words;
                    wEvent.wordCount = event.wordCount;
                    wMr.umpEvents.push_back(std::move(wEvent));
                }
                wSong.midiRegions.push_back(std::move(wMr));
            }

            wSong.tempoPoints.reserve(song.tempoPoints.size());
            for (const auto& tp : song.tempoPoints) {
                WTempoPointTelemetry wTp;
                wTp.beat = finiteOrZero(tp.beat);
                wTp.bpm = finiteOrZero(tp.bpm);
                wTp.timeSeconds = finiteOrZero(tp.timeSeconds);
                wTp.curve = finiteOrZero(tp.curve);
                wSong.tempoPoints.push_back(std::move(wTp));
            }

            wSong.signaturePoints.reserve(song.signaturePoints.size());
            for (const auto& sp : song.signaturePoints) {
                WSignaturePointTelemetry wSp;
                wSp.beat = finiteOrZero(sp.beat);
                wSp.numerator = sp.numerator;
                wSp.denominator = sp.denominator;
                wSp.bar = sp.bar;
                wSong.signaturePoints.push_back(std::move(wSp));
            }

            songVec.push_back(std::move(wSong));
        }
        wire.songs = std::move(songVec);

        WCycleTelemetry cyc;
        cyc.active = snap.cycle.active;
        cyc.skip = snap.cycle.skip;
        cyc.startSeconds = finiteOrZero(snap.cycle.startSeconds);
        cyc.endSeconds = finiteOrZero(snap.cycle.endSeconds);
        cyc.songIndex = snap.cycle.songIndex;
        wire.cycle = cyc;
    }

    if (wantMeters) {
        std::vector<WMeterTelemetry> meterVec;
        meterVec.reserve(snap.meters.size());
        for (const auto& m : snap.meters) {
            WMeterTelemetry wM;
            wM.id = m.id;
            wM.peakDb = finiteOrDbFloor(m.peakDb);
            wM.intervalPeakDbL = finiteOrDbFloor(m.intervalPeakDbL);
            wM.intervalPeakDbR = finiteOrDbFloor(m.intervalPeakDbR);
            wM.peakDbL = finiteOrDbFloor(m.peakDbL);
            wM.peakDbR = finiteOrDbFloor(m.peakDbR);
            wM.shortTermLufs = finiteOrZero(m.shortTermLufs);
            meterVec.push_back(std::move(wM));
        }
        wire.meters = std::move(meterVec);
    }

    if (wantTracks) {
        std::vector<WTrackTelemetry> trkVec;
        trkVec.reserve(snap.tracks.size());
        for (const auto& t : snap.tracks) {
            WTrackTelemetry wT;
            wT.id = t.id;
            wT.name = t.name;
            wT.kind = t.kind;
            wT.stripId = t.stripId.empty() ? std::nullopt : std::make_optional(t.stripId);
            wT.channels = t.channels;
            wT.gainDb = finiteOrZero(t.gainDb);
            wT.pan = finiteOrZero(t.pan);
            wT.panLaw = t.panLaw;
            wT.mute = t.mute;
            wT.solo = t.solo;
            wT.soloSafe = t.soloSafe;
            wT.soloGroup = t.soloGroup;
            wT.soloActiveInGroup = t.soloActiveInGroup;
            wT.recordArmed = t.recordArmed;
            wT.inputMonitoring = t.inputMonitoring;
            wT.inputSource = t.inputSource;
            wT.midiInputChannel = t.midiInputChannel;
            wT.midiInputDevice = t.midiInputDevice;
            wT.inputTrimDb = finiteOrZero(t.inputTrimDb);
            wT.phaseInvert = t.phaseInvert;
            wT.polarity = t.polarity.empty() ? "none" : t.polarity;
            wT.output.type = t.output.type;
            wT.output.target = t.output.target;
            wT.output.sends.reserve(t.output.sends.size());
            for (const auto& s : t.output.sends) {
                WSendConfig wS;
                wS.bus = s.bus;
                wS.level = s.level;
                wS.preFader = s.preFader;
                wS.enabled = s.enabled;
                wS.lowLatencySafe = s.lowLatencySafe;
                wS.tap = s.tap.empty() ? "post-pan" : s.tap;
                wT.output.sends.push_back(std::move(wS));
            }
            wT.plugins.reserve(t.plugins.size());
            for (const auto& slot : t.plugins)
                wT.plugins.push_back(pluginSlotToWire(slot));
            wT.peakDb = finiteOrDbFloor(t.peakDb);
            wT.peakDbL = finiteOrDbFloor(t.peakDbL);
            wT.peakDbR = finiteOrDbFloor(t.peakDbR);
            trkVec.push_back(std::move(wT));
        }
        wire.tracks = std::move(trkVec);
    }

    if (wantBusses) {
        std::vector<WBusTelemetry> busVec;
        busVec.reserve(snap.busses.size());
        for (const auto& b : snap.busses) {
            WBusTelemetry wB;
            wB.id = b.id;
            wB.name = b.name;
            wB.gainDb = finiteOrZero(b.gainDb);
            wB.pan = finiteOrZero(b.pan);
            wB.mute = b.mute;
            wB.solo = b.solo;
            wB.soloSafe = b.soloSafe;
            wB.soloGroup = b.soloGroup;
            wB.soloActiveInGroup = b.soloActiveInGroup;
            wB.isDirectOut = b.isDirectOut;
            wB.unavailable = b.unavailable;
            wB.isAux = b.isAux;
            wB.startChannel = b.startChannel;
            wB.channels = b.channels;
            wB.plugins.reserve(b.plugins.size());
            for (const auto& slot : b.plugins)
                wB.plugins.push_back(pluginSlotToWire(slot));
            wB.peakDb = finiteOrDbFloor(b.peakDb);
            wB.peakDbL = finiteOrDbFloor(b.peakDbL);
            wB.peakDbR = finiteOrDbFloor(b.peakDbR);
            busVec.push_back(std::move(wB));
        }
        wire.busses = std::move(busVec);
    }

    const auto& li = snap.lighting;
    wire.lighting.enabled = li.enabled;
    wire.lighting.kind = li.kind;
    wire.lighting.resolight.columns = li.resolight.columns;
    wire.lighting.resolight.rows = li.resolight.rows;
    wire.lighting.idle.behavior = li.idle.behavior;
    wire.lighting.idle.color.r = static_cast<uint8_t>(li.idle.color.r);
    wire.lighting.idle.color.g = static_cast<uint8_t>(li.idle.color.g);
    wire.lighting.idle.color.b = static_cast<uint8_t>(li.idle.color.b);
    wire.lighting.idle.intensity = finiteOrZero(li.idle.intensity);
    wire.lighting.idle.effect.type = li.idle.effect.type;
    wire.lighting.idle.effect.rateHz = finiteOrZero(li.idle.effect.rateHz);
    wire.lighting.idle.gradient.preset = li.idle.gradient.preset;
    wire.lighting.idle.gradient.colors = li.idle.gradient.colors;
    wire.lighting.defaultRefreshRateHz = finiteOrZero(li.defaultRefreshRateHz);
    if (!li.artNetTargetHost.empty())
        wire.lighting.artNetTargetHost = li.artNetTargetHost;

    wire.lighting.fixtures.reserve(li.fixtures.size());
    for (const auto& f : li.fixtures) {
        WFixtureTelemetry wF;
        wF.id = f.id;
        wF.name = f.name;
        wF.kind = f.kind;
        wF.grid.column = f.grid.column;
        wF.grid.row = f.grid.row;
        wF.ledCount = f.ledCount;
        wF.addressable = f.addressable;
        wF.position.x = finiteOrZero(f.position.x);
        wF.position.y = finiteOrZero(f.position.y);
        wF.position.z = finiteOrZero(f.position.z);
        wF.rotation.y = finiteOrZero(f.rotation.y);
        wF.mountedHorizontally = f.mountedHorizontally;
        wF.dmx.universe = f.dmx.universe;
        wF.dmx.startChannel = f.dmx.startChannel;
        wF.dmx.channelCount = f.dmx.channelCount;
        wF.shape = f.shape;
        wF.matrixColumns = f.matrixColumns;
        wF.channelProfile = f.channelProfile;
        wF.tiltDegrees = finiteOrZero(f.tiltDegrees);
        wF.refreshRateHz = finiteOrZero(f.refreshRateHz);
        wF.networkHost = f.networkHost;
        wF.hwConfigured = f.hwConfigured;
        wF.hwConnected = f.hwConnected;
        wF.hwRssiDbm = f.hwRssiDbm;
        wF.hwChipType = f.hwChipType;
        wire.lighting.fixtures.push_back(std::move(wF));
    }

    wire.lighting.discoveredBoards.reserve(li.discoveredBoards.size());
    for (const auto& b : li.discoveredBoards) {
        WDiscoveredBoardTelemetry wB;
        wB.mac = b.mac;
        wB.ip = b.ip;
        wB.name = b.name;
        wB.chipType = b.chipType;
        wB.lastSeenSecondsAgo = finiteOrZero(b.lastSeenSecondsAgo);
        wire.lighting.discoveredBoards.push_back(std::move(wB));
    }

    wire.lighting.tracks.reserve(li.tracks.size());
    for (const auto& lt : li.tracks) {
        WLightTrackTelemetry wLt;
        wLt.id = lt.id;
        wLt.name = lt.name;
        wLt.fixtureIds = lt.fixtureIds;
        wire.lighting.tracks.push_back(std::move(wLt));
    }

    if (wantMixGraph) {
        WMixGraphTelemetry wG;
        wG.strips.reserve(snap.mixGraph.strips.size());
        for (const auto& st : snap.mixGraph.strips) {
            WMixStripTelemetry wS;
            wS.id = st.id;
            wS.name = st.name;
            wS.kind = st.kind;
            wS.soloGroup = st.soloGroup;
            wS.channels = st.channels;
            wS.gainDb = finiteOrZero(st.gainDb);
            wS.pan = finiteOrZero(st.pan);
            wS.mute = st.mute;
            wS.solo = st.solo;
            wS.soloSafe = st.soloSafe;
            wS.audible = st.audible;
            wS.physicalChannel = st.physicalChannel;
            wS.peakDb = finiteOrDbFloor(st.peakDb);
            wG.strips.push_back(std::move(wS));
        }
        wG.edges.reserve(snap.mixGraph.edges.size());
        for (const auto& e : snap.mixGraph.edges) {
            WMixEdgeTelemetry wE;
            wE.from = e.from;
            wE.to = e.to;
            wE.level = finiteOrZero(e.level);
            wE.preFader = e.preFader;
            wE.active = e.active;
            wE.sourceChannel = e.sourceChannel;
            wG.edges.push_back(std::move(wE));
        }
        wire.mixGraph = std::move(wG);
    }

    if (wantHealth) {
        WHealthTelemetry wH;
        wH.cpuPercent = finiteOrZero(snap.cpuPercent);
        wH.rssBytes = snap.rssBytes;
        wH.freeBytes = snap.freeBytes;
        wH.systemTotalBytes = snap.systemTotalBytes;
        wH.cpuCoreCount = snap.cpuCoreCount;
        wH.underrunCount = snap.underrunCount;
        wH.audioCallbackCount = snap.audioCallbackCount;
        wH.silentBlockCount = snap.silentBlockCount;
        wH.pitchBlockCount = snap.pitchBlockCount;
        wH.streamStarveCount = snap.streamStarveCount;
        wH.pluginMissedOutputBlocks = snap.pluginMissedOutputBlocks;
        wH.pluginMissedInputBlocks = snap.pluginMissedInputBlocks;
        wH.pluginMissedControlEvents = snap.pluginMissedControlEvents;
        wH.pluginRejectedMidiEvents = snap.pluginRejectedMidiEvents;
        wH.callbackWorstRatio = finiteOrZero(snap.callbackWorstRatio);
        wH.callbackWorstMs = finiteOrZero(snap.callbackWorstMs);
        wH.callbackWorstCpuShare = finiteOrZero(snap.callbackWorstCpuShare);
        wH.callbackComputeStalls = snap.callbackComputeStalls;
        wH.callbackPreemptedStalls = snap.callbackPreemptedStalls;
        wH.callbackOverruns = snap.callbackOverruns;
        wH.outputLatencySamples = snap.outputLatencySamples;
        wH.outputLatencyMs = finiteOrZero(snap.outputLatencyMs);
        wH.hostTimeSkewMs = finiteOrZero(snap.hostTimeSkewMs);
        wH.thermalState = snap.thermalState;
        wH.diskReadBytesPerSec = finiteOrZero(snap.diskReadBytesPerSec);
        wH.diskWriteBytesPerSec = finiteOrZero(snap.diskWriteBytesPerSec);
        wH.webClientCount = static_cast<uint32_t>(std::max(0, snap.webClientCount));
        if (wantHealthProcs) {
            wH.processes.reserve(snap.processes.size());
            for (const auto& p : snap.processes) {
                WProcessTelemetry wP;
                wP.pid = p.pid;
                wP.name = p.name;
                wP.rssBytes = p.rssBytes;
                wP.cpuPercent = finiteOrZero(p.cpuPercent);
                wH.processes.push_back(std::move(wP));
            }
        }
        wire.health = std::move(wH);
    }

    const auto& s = snap.settings;
    if (wantSettingsFull) {
        wire.settings.currentOutputDevice = s.currentOutputDevice;
        wire.settings.outputDevices = s.outputDevices;
        wire.settings.currentInputDevice = s.currentInputDevice;
        wire.settings.inputDevices = s.inputDevices;
        wire.settings.audioDrivers = s.audioDrivers;
        wire.settings.currentAudioDriver = s.currentAudioDriver;
        wire.settings.hasControlPanel = s.hasControlPanel;
        wire.settings.sampleRate = finiteOrZero(s.sampleRate);

        std::vector<double> srVec;
        srVec.reserve(s.availableSampleRates.size());
        for (double sr : s.availableSampleRates)
            srVec.push_back(finiteOrZero(sr));
        wire.settings.availableSampleRates = std::move(srVec);

        wire.settings.bufferSize = s.bufferSize;
        wire.settings.availableBufferSizes = s.availableBufferSizes;
        wire.settings.outputChannelNames = s.outputChannelNames;

        std::vector<bool> chVec;
        chVec.reserve(s.activeOutputChannels.size());
        for (bool active : s.activeOutputChannels)
            chVec.push_back(active);
        wire.settings.activeOutputChannels = std::move(chVec);

        wire.settings.inputChannelNames = s.inputChannelNames;
        std::vector<bool> inChVec;
        inChVec.reserve(s.activeInputChannels.size());
        for (bool active : s.activeInputChannels)
            inChVec.push_back(active);
        wire.settings.activeInputChannels = std::move(inChVec);

        wire.settings.inputLatencyMs = finiteOrZero(s.inputLatencyMs);
        wire.settings.outputLatencyMs = finiteOrZero(s.outputLatencyMs);
        wire.settings.roundtripLatencyMs = finiteOrZero(s.roundtripLatencyMs);

        wire.settings.midiOutputs = s.midiOutputs;
        wire.settings.midiInputs = s.midiInputs;
        wire.settings.currentMidiInput = s.currentMidiInput;
        wire.settings.selectedMidiOutputs = s.selectedMidiOutputs;
        wire.settings.selectedMidiInputs = s.selectedMidiInputs;
        wire.settings.virtualMidiPortEnabled = s.virtualMidiPortEnabled;
        wire.settings.uiRenderEngine = s.uiRenderEngine;
        wire.settings.theme = s.theme;
        wire.settings.countInBars = s.countInBars;
        wire.settings.countInPreferredBars = s.countInPreferredBars;
    }

    wire.settings.keybindings.reserve(s.keybindings.size());
    for (const auto& kb : s.keybindings) {
        WKeybindingTelemetry wKb;
        wKb.action = kb.action;
        wKb.key = kb.key;
        wKb.midiAssignable = kb.midiAssignable;
        wire.settings.keybindings.push_back(std::move(wKb));
    }

    wire.settings.recentProjects.reserve(s.recentProjects.size());
    for (const auto& rp : s.recentProjects) {
        WRecentProjectTelemetry wRp;
        wRp.path = rp.path;
        wRp.displayName = rp.displayName;
        wRp.lastOpenedIso = rp.lastOpenedIso;
        wire.settings.recentProjects.push_back(std::move(wRp));
    }

    if (isSettings || all) {
        wire.settings.midiBindings.reserve(s.midiBindings.size());
        for (const auto& mb : s.midiBindings) {
            WMidiBindingTelemetry wMb;
            wMb.action = mb.action;
            wMb.trigger = mb.trigger;
            wMb.channel = mb.channel;
            wMb.number = mb.number;
            wire.settings.midiBindings.push_back(std::move(wMb));
        }
    }

    wire.settings.midiLearnAction = s.midiLearnAction;
    wire.settings.renderOutputDirectory = s.renderOutputDirectory;
        wire.settings.countInBars = s.countInBars;
        wire.settings.countInPreferredBars = s.countInPreferredBars;

    std::string json;
    (void)glz::write_json(wire, json);
    return json;
}


} // namespace resostage
