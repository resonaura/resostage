/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "WebServer.h"
#include "WebServerHttp.h"
#include "server/BuilderJson.h"
#include "server/WireTypes.h"

#include <libwebsockets.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string_view>

namespace resostage {

using webserver_http::writeJsonEnabled;
using webserver_http::writeJsonError;
using webserver_http::writeJsonOk;

namespace {

// Body parse for {"index": N} using Glaze.
int parseSelectIndex(const char* body, size_t len) {
    if (body == nullptr || len == 0)
        return -1;
    wire::WSelectIndexPayload p;
    const auto ec = glz::read_json(p, std::string_view(body, len));
    if (ec || p.index < 0)
        return -1;
    return p.index;
}

// Body parse for {"index": N, "value": X} using Glaze.
// X is either a number or a JSON boolean (mute/solo send booleans; gain/pan send numbers).
bool parseIndexAndValue(const char* body, size_t len, int& outIndex, double& outValue) {
    if (body == nullptr || len == 0)
        return false;
    glz::generic doc;
    const auto ec = glz::read_json(doc, std::string_view(body, len));
    if (ec)
        return false;
    if (!builder_json::getInt(doc, "index", outIndex))
        return false;
    const auto& val = doc["value"];
    if (val.is_boolean()) {
        outValue = val.get_boolean() ? 1.0 : 0.0;
        return true;
    }
    if (val.is_number()) {
        outValue = val.get_number();
        return true;
    }
    return false;
}

bool isMixerCommandPath(const char* path) {
    static const char* const kPaths[] = {
        "/api/v1/track/gain", "/api/v1/track/pan", "/api/v1/track/pan-law",
        "/api/v1/track/mute", "/api/v1/track/solo",
        "/api/v1/track/solo-safe",
        "/api/v1/track/mono", "/api/v1/track/arm",  "/api/v1/track/monitor", "/api/v1/track/focus",
        "/api/v1/bus/gain",   "/api/v1/bus/pan",    "/api/v1/bus/mute",   "/api/v1/bus/solo",
        "/api/v1/bus/solo-safe",
        "/api/v1/click/solo", "/api/v1/click/solo-safe",
    };
    for (const char* p : kPaths)
        if (std::strcmp(path, p) == 0)
            return true;
    return false;
}

WebCommandKind mixerCommandKindForPath(const char* path) {
    if (std::strcmp(path, "/api/v1/track/gain") == 0) return WebCommandKind::SetTrackGain;
    if (std::strcmp(path, "/api/v1/track/pan") == 0) return WebCommandKind::SetTrackPan;
    if (std::strcmp(path, "/api/v1/track/pan-law") == 0) return WebCommandKind::SetTrackPanLaw;
    if (std::strcmp(path, "/api/v1/track/mute") == 0) return WebCommandKind::SetTrackMute;
    if (std::strcmp(path, "/api/v1/track/solo") == 0) return WebCommandKind::SetTrackSolo;
    if (std::strcmp(path, "/api/v1/track/solo-safe") == 0) return WebCommandKind::SetTrackSoloSafe;
    if (std::strcmp(path, "/api/v1/track/mono") == 0) return WebCommandKind::SetTrackMono;
    if (std::strcmp(path, "/api/v1/track/arm") == 0) return WebCommandKind::SetTrackRecordArm;
    if (std::strcmp(path, "/api/v1/track/monitor") == 0) return WebCommandKind::SetTrackInputMonitor;
    if (std::strcmp(path, "/api/v1/track/focus") == 0) return WebCommandKind::SetFocusedTrack;
    if (std::strcmp(path, "/api/v1/bus/gain") == 0) return WebCommandKind::SetBusGain;
    if (std::strcmp(path, "/api/v1/bus/pan") == 0) return WebCommandKind::SetBusPan;
    if (std::strcmp(path, "/api/v1/bus/mute") == 0) return WebCommandKind::SetBusMute;
    if (std::strcmp(path, "/api/v1/bus/solo") == 0) return WebCommandKind::SetBusSolo;
    if (std::strcmp(path, "/api/v1/bus/solo-safe") == 0) return WebCommandKind::SetBusSoloSafe;
    if (std::strcmp(path, "/api/v1/click/solo-safe") == 0) return WebCommandKind::SetClickSoloSafe;
    return WebCommandKind::SetClickSolo; // "/api/v1/click/solo" -- last remaining option per isMixerCommandPath's list
}

// Builder and Settings paths carry their whole payload as a raw JSON
// pass-through (see WebCommand::json) -- WebServer does no field parsing for
// these at all, unlike the mixer paths above.
struct BuilderRoute {
    const char* path;
    WebCommandKind kind;
};
constexpr BuilderRoute kBuilderRoutes[] = {
    {"/api/v1/builder/song/add", WebCommandKind::BuilderSongAdd},
    {"/api/v1/builder/song/import-folder", WebCommandKind::BuilderSongImportFolder},
    {"/api/v1/builder/song/remove", WebCommandKind::BuilderSongRemove},
    {"/api/v1/builder/song/move", WebCommandKind::BuilderSongMove},
    {"/api/v1/builder/song/update", WebCommandKind::BuilderSongUpdate},
    {"/api/v1/builder/song/end", WebCommandKind::BuilderSongEnd},
    {"/api/v1/builder/track/add", WebCommandKind::BuilderTrackAdd},
    {"/api/v1/builder/track/duplicate", WebCommandKind::BuilderTrackDuplicate},
    {"/api/v1/builder/track/remove", WebCommandKind::BuilderTrackRemove},
    {"/api/v1/builder/track/move", WebCommandKind::BuilderTrackMove},
    {"/api/v1/builder/track/update", WebCommandKind::BuilderTrackUpdate},
    {"/api/v1/builder/track/import-wav/begin", WebCommandKind::BuilderTrackImportWavBegin},
    {"/api/v1/builder/track/import-wav/dialog", WebCommandKind::BuilderTrackImportWavDialog},
    {"/api/v1/builder/region/add", WebCommandKind::BuilderRegionAdd},
    {"/api/v1/builder/region/remove", WebCommandKind::BuilderRegionRemove},
    {"/api/v1/builder/region/update", WebCommandKind::BuilderRegionUpdate},
    {"/api/v1/builder/midi-region/add", WebCommandKind::BuilderMidiRegionAdd},
    {"/api/v1/builder/midi-region/remove", WebCommandKind::BuilderMidiRegionRemove},
    {"/api/v1/builder/midi-region/update", WebCommandKind::BuilderMidiRegionUpdate},
    {"/api/v1/builder/automation-lane/add", WebCommandKind::BuilderAutomationLaneAdd},
    {"/api/v1/builder/automation-lane/remove", WebCommandKind::BuilderAutomationLaneRemove},
    {"/api/v1/builder/automation-lane/update", WebCommandKind::BuilderAutomationLaneUpdate},
    {"/api/v1/builder/automation-point/add", WebCommandKind::BuilderAutomationPointAdd},
    {"/api/v1/builder/automation-point/remove", WebCommandKind::BuilderAutomationPointRemove},
    {"/api/v1/builder/automation/record-gesture", WebCommandKind::BuilderAutomationRecordGesture},
    {"/api/v1/builder/bus/add", WebCommandKind::BuilderBusAdd},
    {"/api/v1/builder/bus/remove", WebCommandKind::BuilderBusRemove},
    {"/api/v1/builder/bus/move", WebCommandKind::BuilderBusMove},
    {"/api/v1/builder/bus/update", WebCommandKind::BuilderBusUpdate},
    {"/api/v1/builder/event/add", WebCommandKind::BuilderEventAdd},
    {"/api/v1/builder/event/remove", WebCommandKind::BuilderEventRemove},
    {"/api/v1/builder/event/move", WebCommandKind::BuilderEventMove},
    {"/api/v1/builder/event/update", WebCommandKind::BuilderEventUpdate},
    {"/api/v1/builder/section/add", WebCommandKind::BuilderSectionAdd},
    {"/api/v1/builder/section/remove", WebCommandKind::BuilderSectionRemove},
    {"/api/v1/builder/section/update", WebCommandKind::BuilderSectionUpdate},
    {"/api/v1/builder/cycle/update", WebCommandKind::BuilderCycleUpdate},
    {"/api/v1/lighting/config", WebCommandKind::SetLightingConfig},
    {"/api/v1/lighting/fixture/add", WebCommandKind::LightFixtureAdd},
    {"/api/v1/lighting/fixture/duplicate", WebCommandKind::LightFixtureDuplicate},
    {"/api/v1/lighting/fixture/remove", WebCommandKind::LightFixtureRemove},
    {"/api/v1/lighting/fixture/update", WebCommandKind::LightFixtureUpdate},
    {"/api/v1/lighting/track/add", WebCommandKind::LightTrackAdd},
    {"/api/v1/lighting/track/remove", WebCommandKind::LightTrackRemove},
    {"/api/v1/lighting/track/move", WebCommandKind::LightTrackMove},
    {"/api/v1/lighting/track/update", WebCommandKind::LightTrackUpdate},
    {"/api/v1/lighting/cue/add", WebCommandKind::LightCueAdd},
    {"/api/v1/lighting/cue/remove", WebCommandKind::LightCueRemove},
    {"/api/v1/lighting/cue/update", WebCommandKind::LightCueUpdate},
    {"/api/v1/timeline/undo", WebCommandKind::TimelineUndo},
    {"/api/v1/timeline/redo", WebCommandKind::TimelineRedo},
    {"/api/v1/settings/audio-device", WebCommandKind::SetAudioOutputDevice},
    {"/api/v1/settings/audio-input-device", WebCommandKind::SetAudioInputDevice},
    {"/api/v1/settings/audio-driver", WebCommandKind::SetAudioDeviceType},
    {"/api/v1/settings/audio-control-panel", WebCommandKind::ShowAudioControlPanel},
    {"/api/v1/settings/sample-rate", WebCommandKind::SetSampleRate},
    {"/api/v1/settings/buffer-size", WebCommandKind::SetBufferSize},
    {"/api/v1/settings/midi-output", WebCommandKind::SetMidiOutput},
    {"/api/v1/settings/midi-input", WebCommandKind::SetMidiInput},
    {"/api/v1/settings/midi-virtual-port", WebCommandKind::SetMidiVirtualPort},
    {"/api/v1/settings/ui-render-engine", WebCommandKind::SetUiRenderEngine},
    {"/api/v1/settings/theme", WebCommandKind::SetTheme},
    {"/api/v1/settings/keybinding", WebCommandKind::SetKeybinding},
    {"/api/v1/settings/count-in", WebCommandKind::SetCountInBars},
    {"/api/v1/settings/output-channels", WebCommandKind::SetOutputChannels},
    {"/api/v1/settings/input-channels", WebCommandKind::SetInputChannels},
    {"/api/v1/settings/midi-learn", WebCommandKind::MidiLearn},
    {"/api/v1/settings/midi-learn-cancel", WebCommandKind::MidiLearnCancel},
    {"/api/v1/settings/midi-clear", WebCommandKind::MidiClear},
    {"/api/v1/transport/seek", WebCommandKind::Seek},
    {"/api/v1/mixer/track/send", WebCommandKind::SetTrackSend},
    {"/api/v1/mixer/track/send/remove", WebCommandKind::RemoveTrackSend},
    {"/api/v1/project/name", WebCommandKind::SetProjectName},
    {"/api/v1/ui/focus-state", WebCommandKind::UiFocusState},
    {"/api/v1/action", WebCommandKind::PerformAction},
};

bool builderCommandKindForPath(const char* path, WebCommandKind& outKind) {
    for (const auto& route : kBuilderRoutes) {
        if (std::strcmp(path, route.path) == 0) {
            outKind = route.kind;
            return true;
        }
    }
    return false;
}

} // namespace

bool WebServer::handleHttpApi(struct lws* wsi, const char* path, const char* method,
                               const char* body, size_t bodyLen) {
    if (path == nullptr || method == nullptr)
        return false;
    if (std::strcmp(method, "POST") != 0)
        return false;

    WebCommand cmd;
    bool ok = true;

    if (std::strcmp(path, "/api/v1/transport/play") == 0) {
        cmd = {WebCommandKind::Play, 0};
    } else if (std::strcmp(path, "/api/v1/transport/record") == 0) {
        int trackIdx = -1;
        if (body != nullptr && bodyLen > 0) {
            glz::generic doc;
            if (!glz::read_json(doc, std::string_view(body, bodyLen))) {
                (void)builder_json::getInt(doc, "trackIndex", trackIdx);
            }
        }
        cmd = {WebCommandKind::TransportRecord, trackIdx};
    } else if (std::strcmp(path, "/api/v1/transport/stop") == 0) {
        cmd = {WebCommandKind::Stop, 0};
    } else if (std::strcmp(path, "/api/v1/transport/stop-to-start") == 0) {
        cmd = {WebCommandKind::StopToStart, 0};
    } else if (std::strcmp(path, "/api/v1/transport/next") == 0) {
        cmd = {WebCommandKind::Next, 0};
    } else if (std::strcmp(path, "/api/v1/transport/prev") == 0) {
        cmd = {WebCommandKind::Prev, 0};
    } else if (std::strcmp(path, "/api/v1/transport/select") == 0) {
        const int idx = parseSelectIndex(body, bodyLen);
        if (idx < 0) {
            writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "missing index");
            return true;
        }
        cmd = {WebCommandKind::SelectSong, idx, 0.0};
    } else if (isMixerCommandPath(path)) {
        int idx = 0;
        double value = 0.0;
        if (!parseIndexAndValue(body, bodyLen, idx, value)) {
            writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "missing index/value");
            return true;
        }
        cmd = {mixerCommandKindForPath(path), idx, value};
    } else if (std::strcmp(path, "/api/v1/track/input-source") == 0) {
        cmd = {WebCommandKind::SetTrackInputSource, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/track/trim") == 0 || std::strcmp(path, "/api/v1/track/polarity") == 0) {
        cmd = {WebCommandKind::SetTrackTrim, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/recording/auto-input") == 0) {
        cmd = {WebCommandKind::SetAutoInputMonitoring, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/recording/auto-punch") == 0) {
        cmd = {WebCommandKind::SetAutoPunch, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/recording/low-latency") == 0) {
        cmd = {WebCommandKind::SetLowLatencyMonitoring, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/midi/send") == 0 || std::strcmp(path, "/api/v1/midi/event") == 0) {
        glz::generic doc;
        if (!builder_json::parseJson(std::string(body, bodyLen), doc)) {
            writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "invalid json");
            return true;
        }
        int status = 0, d1 = 0, d2 = 0;
        int trackIndex = -1;
        builder_json::getInt(doc, "trackIndex", trackIndex);
        if (builder_json::getInt(doc, "status", status)
            && builder_json::getInt(doc, "data1", d1)
            && builder_json::getInt(doc, "data2", d2)) {
            const uint8_t pkt[3] = { static_cast<uint8_t>(status),
                                     static_cast<uint8_t>(d1),
                                     static_cast<uint8_t>(d2) };
            injectMidi(pkt, 3, trackIndex);
            writeJsonOk(wsi);
            return true;
        }
        std::string type;
        int note = 60, velocity = 100, channel = 1;
        builder_json::getString(doc, "type", type);
        builder_json::getInt(doc, "note", note);
        builder_json::getInt(doc, "velocity", velocity);
        builder_json::getInt(doc, "channel", channel);
        const uint8_t ch = static_cast<uint8_t>(std::clamp(channel, 1, 16) - 1);
        uint8_t st = 0x90 | ch;
        if (type == "note_off" || velocity <= 0)
            st = 0x80 | ch;
        const uint8_t pkt[3] = { st, static_cast<uint8_t>(std::clamp(note, 0, 127)),
                                 static_cast<uint8_t>(std::clamp(velocity, 0, 127)) };
        injectMidi(pkt, 3, trackIndex);
        writeJsonOk(wsi);
        return true;
    } else if (std::strcmp(path, "/api/v1/project/new") == 0) {
        cmd = {WebCommandKind::NewProject, 0};
    } else if (std::strcmp(path, "/api/v1/project/load-dialog") == 0) {
        cmd = {WebCommandKind::OpenLoadDialog, 0};
    } else if (std::strcmp(path, "/api/v1/project/save") == 0) {
        cmd = {WebCommandKind::SaveProject, 0};
    } else if (std::strcmp(path, "/api/v1/project/save-as") == 0) {
        cmd = {WebCommandKind::SaveProjectAs, 0};
    } else if (std::strcmp(path, "/api/v1/project/export") == 0) {
        beginExport();
        cmd = {WebCommandKind::ExportProjectForDownload, 0};
    } else if (std::strcmp(path, "/api/v1/render/start") == 0) {
        beginAudioRender();
        cmd = {WebCommandKind::RenderAudio, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/render/cancel") == 0) {
        cmd = {WebCommandKind::CancelAudioRender, 0};
    } else if (std::strcmp(path, "/api/v1/plugins/scan") == 0) {
        cmd = {WebCommandKind::PluginScan, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/scan/cancel") == 0) {
        cmd = {WebCommandKind::PluginScanCancel, 0};
    } else if (std::strcmp(path, "/api/v1/plugins/enabled") == 0) {
        cmd = {WebCommandKind::PluginSetEnabled, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/slot/add") == 0) {
        cmd = {WebCommandKind::PluginSlotAdd, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/slot/replace") == 0) {
        cmd = {WebCommandKind::PluginSlotReplace, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/slot/remove") == 0) {
        cmd = {WebCommandKind::PluginSlotRemove, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/slot/move") == 0) {
        cmd = {WebCommandKind::PluginSlotMove, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/slot/bypass") == 0) {
        cmd = {WebCommandKind::PluginSlotBypass, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/slot/retry") == 0) {
        cmd = {WebCommandKind::PluginSlotRetry, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/loading/decision") == 0) {
        wire::WPluginLoadDecisionPayload p;
        const auto err = glz::read_json(p, std::string_view(body, bodyLen));
        if (err || (p.decision != "continue" && p.decision != "stop" && p.decision != "retry")) {
            writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "Invalid plug-in loading decision");
            return true;
        }
        cmd = {WebCommandKind::PluginLoadDecision, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/slot/editor") == 0) {
        cmd = {WebCommandKind::PluginSlotOpenEditor, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/slot/keep-awake") == 0) {
        cmd = {WebCommandKind::PluginSlotKeepAwake, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/slot/park") == 0) {
        cmd = {WebCommandKind::PluginSlotPark, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/plugins/slot/unpark") == 0) {
        cmd = {WebCommandKind::PluginSlotUnpark, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/project/open-recent") == 0) {
        wire::WOpenRecentPayload p;
        if (glz::read_json(p, std::string_view(body, bodyLen)) || p.path.empty()) {
            writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "missing path");
            return true;
        }
        cmd = {WebCommandKind::OpenRecentProject, 0, 0.0, p.path};
    } else if (std::strcmp(path, "/api/v1/project/clear-recent") == 0) {
        cmd = {WebCommandKind::ClearRecentProjects, 0};
    } else if (std::strcmp(path, "/api/v1/project/quit-decision") == 0) {
        const int choice = parseSelectIndex(body, bodyLen);
        if (choice < 0) {
            writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "missing index");
            return true;
        }
        cmd = {WebCommandKind::QuitDecision, choice};
    } else if (std::strcmp(path, "/api/v1/project/open-decision") == 0) {
        const int choice = parseSelectIndex(body, bodyLen);
        if (choice < 0) {
            writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "missing index");
            return true;
        }
        cmd = {WebCommandKind::OpenDecision, choice};
    } else if (std::strcmp(path, "/api/v1/settings/ui-render-engine") == 0) {
        cmd = {WebCommandKind::SetUiRenderEngine, 0, 0.0, std::string(body, bodyLen)};
        writeJsonOk(wsi);
        return true;
    } else if (std::strcmp(path, "/api/v1/settings/telemetry-hz") == 0) {
        wire::WTelemetryHzPayload p;
        if (!glz::read_json(p, std::string_view(body, bodyLen)) && p.telemetryHz > 0) {
            setTargetTelemetryHz(p.telemetryHz);
        }
        writeJsonOk(wsi);
        return true;
    } else if (std::strcmp(path, "/api/v1/view") == 0) {
        wire::WViewPayload p;
        if (!glz::read_json(p, std::string_view(body, bodyLen)) && !p.view.empty()) {
            noteClientView(p.view);
            writeJsonOk(wsi);
        } else {
            writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "missing view");
        }
        return true;
    } else if (WebCommandKind builderKind; builderCommandKindForPath(path, builderKind)) {
        if (builderKind == WebCommandKind::BuilderTrackImportWavBegin) {
            wire::WTrackImportBeginPayload p;
            if (glz::read_json(p, std::string_view(body, bodyLen)))
                writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "Invalid media import target");
            else if (!beginTrackImport(p.songIndex, p.index, p.fileName, p.startSeconds, p.requestId))
                writeJsonError(wsi, 409, "Media import target is invalid, already reserved, or the upload queue is full");
            else writeJsonOk(wsi);
            return true;
        }
        cmd = {builderKind, 0, 0.0, "", std::string(body, bodyLen)};
    } else if (std::strcmp(path, "/api/v1/remote/discovery") == 0) {
        wire::WDiscoveryTogglePayload p;
        bool enabled = true;
        if (!glz::read_json(p, std::string_view(body, bodyLen))) {
            enabled = p.enabled;
        }
        if (discoveryToggleHandler) {
            discoveryToggleHandler(enabled);
        }
        writeJsonEnabled(wsi, enabled);
        return true;
    } else if (std::strcmp(path, "/api/v1/remote/subscribe-udp") == 0) {
        char clientIp[64] = "";
        lws_get_peer_simple(wsi, clientIp, sizeof(clientIp));
        int port = kUdpTelemetryPort;
        wire::WSubscribeUdpPayload p;
        if (!glz::read_json(p, std::string_view(body, bodyLen)) && p.port > 0) {
            port = p.port;
        }
        if (clientIp[0] != '\0') {
            registerUdpSubscriber(clientIp, port);
        }
        writeJsonOk(wsi);
        return true;
    } else {
        ok = false;
    }

    if (!ok)
        return false;

    const bool isHistory = cmd.kind == WebCommandKind::TimelineUndo
        || cmd.kind == WebCommandKind::TimelineRedo;
    if (isHistory)
        cmd.historyRequestId = ++nextHistoryRequestId_;
    const uint64_t historyRequestId = cmd.historyRequestId;
    if (!enqueueCommand(std::move(cmd))) {
        writeJsonError(wsi, 503, "Core command queue is full; retry the command");
        return true;
    }
    if (isHistory) {
        wire::WHistoryAccepted accepted{true, historyRequestId, stateSessionId_};
        const auto json = glz::write_json(accepted).value_or("{}");
        webserver_http::writeHttpResponse(wsi, HTTP_STATUS_OK,
            "application/json", json.data(), json.size());
    } else {
        writeJsonOk(wsi);
    }
    return true;
}

} // namespace resostage
