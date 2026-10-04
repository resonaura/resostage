/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// JUCE message-thread dispatcher for commands polled from WebServer.
// WebServer only enqueues commands; this method preserves the single app-state
// mutation path, coalesces contiguous song navigation, and dispatches each
// command to its existing handler. This translation-unit split is organizational
// only: command handling must not move onto the server or audio thread.

#include "MainComponent.h"
#include "engine/AudioEngineInternal.h"
#include "project/RouteId.h"
#include "server/BuilderJson.h"
#include "server/WireTypes.h"

#include <algorithm>
#include <cstdio>
#include <vector>

namespace resostage {

void MainComponent::drainWebCommands() {
    // Drain the whole queue first. Rapid setlist clicks (or Next spam) used
    // to enqueue N SelectSong commands and each did a full stageSong open —
    // hopscotch felt like ~1s of "thinking". Coalesce consecutive song-nav
    // into a single goToSong of the final target.
    std::vector<WebCommand> batch;
    bool canDrainDeferredCommands = !engine.isBusy();
#if defined(RESOSTAGE_ENABLE_TEST_HOOKS)
    canDrainDeferredCommands = canDrainDeferredCommands && !holdDeferredCommandsForTesting;
#endif
    if (canDrainDeferredCommands) {
        batch.reserve(deferredWebCommands.size());
        while (!deferredWebCommands.empty()) {
            batch.push_back(std::move(deferredWebCommands.front()));
            deferredWebCommands.pop_front();
        }
        deferredWebCommandBytes = 0;
#if defined(RESOSTAGE_ENABLE_TEST_HOOKS)
        webServer.setTestDeferredCommandStatus(0, 0);
#endif
    }
    {
        WebCommand cmd;
        while (webServer.pollCommand(cmd))
            batch.push_back(std::move(cmd));
    }
    if (batch.empty())
        return;

    const auto isSongNav = [](WebCommandKind k) {
        return k == WebCommandKind::SelectSong || k == WebCommandKind::Next
               || k == WebCommandKind::Prev;
    };
    const auto isLightingMutation = [](WebCommandKind kind) {
        return kind == WebCommandKind::SetLightingConfig
            || kind == WebCommandKind::LightFixtureAdd
            || kind == WebCommandKind::LightFixtureDuplicate
            || kind == WebCommandKind::LightFixtureRemove
            || kind == WebCommandKind::LightFixtureUpdate
            || kind == WebCommandKind::LightTrackAdd
            || kind == WebCommandKind::LightTrackRemove
            || kind == WebCommandKind::LightTrackMove
            || kind == WebCommandKind::LightTrackUpdate
            || kind == WebCommandKind::LightCueAdd
            || kind == WebCommandKind::LightCueRemove
            || kind == WebCommandKind::LightCueUpdate;
    };

    auto foldSongNav = [this](const WebCommand* begin, const WebCommand* end) -> int {
        const int count = static_cast<int>(engine.project().songs.size());
        int target = static_cast<int>(engine.currentSongIndex());
        if (target < 0)
            target = 0;
        for (const WebCommand* p = begin; p != end; ++p) {
            if (p->kind == WebCommandKind::SelectSong) {
                target = p->arg;
            } else if (p->kind == WebCommandKind::Next) {
                if (count > 0)
                    target = std::min(count - 1, target + 1);
            } else if (p->kind == WebCommandKind::Prev) {
                target = std::max(0, target - 1);
            }
        }
        if (count > 0)
            target = std::clamp(target, 0, count - 1);
        return target;
    };

    auto dispatchOne = [this, &isLightingMutation](const WebCommand& cmd) {
        // Async save/import completion may reopen the live ProjectLoader. Keep
        // transactional edits out until it has finished; Stop remains usable
        // throughout a slow disk operation.
        bool mustDeferForProjectIO = engine.isBusy();
#if defined(RESOSTAGE_ENABLE_TEST_HOOKS)
        mustDeferForProjectIO = mustDeferForProjectIO || holdDeferredCommandsForTesting;
#endif
        if (mustDeferForProjectIO && cmd.kind != WebCommandKind::Stop
            && cmd.kind != WebCommandKind::CancelAudioRender
            && cmd.kind != WebCommandKind::PluginScanCancel
#if defined(RESOSTAGE_ENABLE_TEST_HOOKS)
            && cmd.kind != WebCommandKind::TestSetDeferredQueueHold
#endif
        ) {
            // Upload HTTP completion means queued, not converted. Preserve
            // later track-add/upload actions in their accepted order so an
            // import snapshot cannot erase or reject the rest of a batch.
            const size_t bytes = cmd.path.size() + cmd.json.size()
                + cmd.expectedStateSessionId.size();
            if (deferredWebCommands.size() < kMaximumDeferredCommands
                && bytes <= kMaximumDeferredCommandBytes - deferredWebCommandBytes) {
                deferredWebCommands.push_back(cmd);
                deferredWebCommandBytes += bytes;
#if defined(RESOSTAGE_ENABLE_TEST_HOOKS)
                webServer.setTestDeferredCommandStatus(
                    deferredWebCommands.size(), deferredWebCommandBytes);
#endif
            } else {
                const std::string error = "Pending project command queue is full; retry when the import finishes";
                if (cmd.kind == WebCommandKind::BuilderTrackImportWAVUpload) {
                    std::remove(cmd.path.c_str());
                    glz::generic payload;
                    std::string requestId;
                    if (builder_json::parseJson(cmd.json, payload))
                        builder_json::getString(payload, "requestId", requestId);
                    webServer.finishTrackImport(requestId, false, error);
                }
                if (cmd.kind == WebCommandKind::LoadProjectFromPath)
                    std::remove(cmd.path.c_str());
                if (cmd.historyRequestId != 0) {
                    historyResults_.push_back({cmd.historyRequestId, false,
                                               engine.projectHistoryRevision(), error});
                    while (historyResults_.size() > 256)
                        historyResults_.pop_front();
                }
                if (cmd.editorRequestId != 0) {
                    editorCommandResults_.push_back({cmd.editorRequestId, false, projectEpoch_,
                                                     engine.projectHistoryRevision(), error});
                    while (editorCommandResults_.size() > 256)
                        editorCommandResults_.pop_front();
                }
                if (cmd.kind == WebCommandKind::ExportProjectForDownload)
                    webServer.failExport();
                setStatus(error);
                publishWebState();
            }
            return;
        }
        if (cmd.hasExpectedProjectIdentity && cmd.expectedProjectEpoch != projectEpoch_) {
            const std::string error = "Project changed before this command was applied (expected epoch "
                + std::to_string(cmd.expectedProjectEpoch) + ", current epoch "
                + std::to_string(projectEpoch_) + ")";
            if (cmd.kind == WebCommandKind::BuilderTrackImportWAVUpload) {
                std::remove(cmd.path.c_str());
                glz::generic payload;
                std::string requestId;
                if (builder_json::parseJson(cmd.json, payload))
                    builder_json::getString(payload, "requestId", requestId);
                webServer.finishTrackImport(requestId, false, error);
            }
            if (cmd.historyRequestId != 0) {
                historyResults_.push_back({cmd.historyRequestId, false,
                                           engine.projectHistoryRevision(), error});
                while (historyResults_.size() > 256)
                    historyResults_.pop_front();
            }
            if (cmd.editorRequestId != 0) {
                editorCommandResults_.push_back({cmd.editorRequestId, false, projectEpoch_,
                                                 engine.projectHistoryRevision(), error});
                while (editorCommandResults_.size() > 256)
                    editorCommandResults_.pop_front();
            }
            setStatus(error);
            publishWebState();
            return;
        }
        const size_t idx = static_cast<size_t>(cmd.arg);
        const uint64_t revisionBefore = engine.projectHistoryRevision();
        const std::string statusBefore = lastStatusMessage;
        switch (cmd.kind) {
            case WebCommandKind::Play: engine.play(); break;
            case WebCommandKind::Stop: engine.stop(); break;
            case WebCommandKind::StopToStart: stopToStartClicked(); break;
            case WebCommandKind::Next: nextSong(); break;
            case WebCommandKind::Prev: prevSong(); break;
            case WebCommandKind::TransportRecord: engine.toggleRecording(cmd.arg); break;
            case WebCommandKind::SelectSong: goToSong(cmd.arg); break;
            case WebCommandKind::SetTrackGain: {
                engine.projectHistoryBeginEdit("tg" + std::to_string(idx), "Set Track Gain");
                engine.setTrackGainDb(engine.currentSongIndex(), idx, cmd.value);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackPan: {
                engine.projectHistoryBeginEdit("tp" + std::to_string(idx), "Set Track Pan");
                engine.setTrackPan(engine.currentSongIndex(), idx, cmd.value);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackPanLaw: {
                const int law = std::clamp(static_cast<int>(cmd.value), 0, 3);
                engine.projectHistoryBeginEdit("tpl" + std::to_string(idx), "Set Track Pan Law");
                engine.setTrackPanLaw(engine.currentSongIndex(), idx,
                    static_cast<PanLaw>(law));
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackMute: {
                engine.projectHistoryBeginEdit("", "Toggle Track Mute");
                engine.setTrackMute(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackSolo: {
                engine.projectHistoryBeginEdit("", "Toggle Track Solo");
                engine.setTrackSolo(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackSoloSafe: {
                engine.projectHistoryBeginEdit("", "Toggle Track Solo-Safe");
                engine.setTrackSoloSafe(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackMono: {
                engine.projectHistoryBeginEdit("", "Toggle Track Mono");
                engine.setTrackMono(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackRecordArm: {
                engine.projectHistoryBeginEdit("", "Toggle Track Record Arm");
                engine.setTrackRecordArmed(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackInputMonitor: {
                engine.projectHistoryBeginEdit("", "Toggle Track Input Monitor");
                engine.setTrackInputMonitoring(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetFocusedTrack:
                engine.setFocusedTrack(cmd.arg);
                if (cmd.arg >= 0 && static_cast<size_t>(cmd.arg) < engine.trackCount()) {
                    if (const auto* t = engine.trackDefAt(static_cast<size_t>(cmd.arg))) {
                        engine.project().activeTrackId = t->id;
                    }
                } else if (cmd.arg < 0) {
                    engine.project().activeTrackId.clear();
                }
                break;
            case WebCommandKind::SetTrackInputSource: {
                wire::WTrackInputSourcePayload payload;
                if (!glz::read_json(payload, cmd.json) && payload.trackIndex >= 0) {
                    engine.projectHistoryBeginEdit("", "Set Track Input Source");
                    engine.setTrackInputSource(engine.currentSongIndex(), static_cast<size_t>(payload.trackIndex), payload.inputSource, payload.midiInputChannel, payload.midiInputDevice);
                    engine.projectHistoryCommitEdit();
                }
                break;
            }
            case WebCommandKind::SetTrackTrim: {
                wire::WTrackTrimPayload payload;
                if (!glz::read_json(payload, cmd.json)) {
                    const size_t tIdx = payload.trackIndex >= 0 ? static_cast<size_t>(payload.trackIndex) : static_cast<size_t>(-1);
                    if (tIdx < engine.trackCount()) {
                        if (TrackDef* t = engine.trackDefAt(tIdx)) {
                            engine.projectHistoryBeginEdit("", "Set Track Trim");
                            t->inputTrimDb = payload.inputTrimDb;
                            t->polarity = polarityFromString(payload.polarity, payload.phaseInvert);
                            t->phaseInvert = payload.phaseInvert || (t->polarity != PolarityMask::None);
                            engine.projectHistoryCommitEdit();
                            engine.republishRouting();
                        }
                    }
                }
                break;
            }
            case WebCommandKind::SetAutoInputMonitoring: {
                wire::WAutoInputPayload payload;
                if (!glz::read_json(payload, cmd.json)) {
                    engine.setAutoInputMonitoring(payload.enabled);
                }
                break;
            }
            case WebCommandKind::SetAutoPunch: {
                wire::WAutoPunchPayload payload;
                if (!glz::read_json(payload, cmd.json)) {
                    engine.setAutoPunch(payload.enabled, payload.startSample, payload.endSample);
                }
                break;
            }
            case WebCommandKind::SetLowLatencyMonitoring: {
                wire::WLowLatencyPayload payload;
                if (!glz::read_json(payload, cmd.json)) {
                    engine.setLowLatencyMonitoring(payload.enabled, payload.limitMs);
                }
                break;
            }
            case WebCommandKind::SetBusGain: {
                engine.projectHistoryBeginEdit("bg" + std::to_string(idx), "Set Bus Gain");
                engine.setBusGainDb(idx, cmd.value);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetBusPan: {
                engine.projectHistoryBeginEdit("bp" + std::to_string(idx), "Set Bus Pan");
                engine.setBusPan(idx, cmd.value);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetBusMute: {
                engine.projectHistoryBeginEdit("", "Toggle Bus Mute");
                engine.setBusMute(idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetBusSolo: {
                engine.projectHistoryBeginEdit("", "Toggle Bus Solo");
                engine.setBusSolo(idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetBusSoloSafe: {
                engine.projectHistoryBeginEdit("", "Toggle Bus Solo-Safe");
                engine.setBusSoloSafe(idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetClickSolo: {
                engine.projectHistoryBeginEdit("", "Toggle Click Solo");
                engine.setClickSolo(cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetClickSoloSafe: {
                engine.projectHistoryBeginEdit("", "Toggle Click Solo-Safe");
                engine.setClickSoloSafe(cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackSend: {
                // The validated handler owns this transaction. Wrapping it
                // here too creates an empty step and commits to the wrong one.
                setTrackSendFromJson(cmd.json);
                break;
            }
            case WebCommandKind::RemoveTrackSend: {
                removeTrackSendFromJson(cmd.json);
                break;
            }
            case WebCommandKind::SetProjectName: setProjectNameFromJson(cmd.json); break;
            case WebCommandKind::NewProject:
                closeAllPluginEditors();
                engine.newProject();
                applyGlobalBindings();
                onProjectLoaded();
                setStatus("New project -- add songs in Builder, then Save As to create the .rsnraset file");
                break;
            case WebCommandKind::OpenLoadDialog:
                loadProjectClicked();
                break;
            case WebCommandKind::SaveProject:
                saveProjectClicked(false);
                break;
            case WebCommandKind::SaveProjectAs:
                saveProjectClicked(true);
                break;
            case WebCommandKind::LoadProjectFromPath: {
                openUploadedProjectFromIpc(cmd.path);
                break;
            }
            case WebCommandKind::OpenRecentProject: {
                // Reuse the same unsaved-change gate as Finder/Explorer opens.
                // A recent-project click must not silently discard in-memory
                // edits just because it originated inside the renderer.
                openRecentProjectFromPath(cmd.path);
                break;
            }
            case WebCommandKind::ClearRecentProjects:
                appSettings.recentProjects.clear();
                saveAppSettingsToDisk();
                publishWebState();
                break;
            case WebCommandKind::ExportProjectForDownload: {
                if (!engine.isProjectLoaded()) {
                    webServer.failExport();
                    setStatus("Nothing to export -- no project loaded");
                    break;
                }
                const auto tempFile = juce::File::getSpecialLocation(juce::File::tempDirectory)
                                          .getNonexistentChildFile("resostage-export", ".rsnraset");
                std::string error;
                if (engine.saveProject(tempFile.getFullPathName().toStdString(), error)) {
                    juce::String safeName = juce::String(engine.project().name)
                        .retainCharacters("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-");
                    if (safeName.isEmpty())
                        safeName = "Project";
                    webServer.completeExport(tempFile.getFullPathName().toStdString(),
                                             safeName.toStdString() + ".rsnraset");
                    setStatus("Export ready for download");
                } else {
                    webServer.failExport();
                    setStatus("Export failed: " + juce::String(error));
                }
                break;
            }
            case WebCommandKind::RenderAudio:
                startAudioRender(cmd.json);
                break;
            case WebCommandKind::CancelAudioRender:
                cancelAudioRender.store(true, std::memory_order_release);
                setStatus("Cancelling audio render…");
                break;
            case WebCommandKind::PluginScan: {
                wire::WPluginScanPayload p;
                (void)glz::read_json(p, cmd.json);
                if (!pluginCatalog.startScan(p.rescanAll))
                    setStatus("Plug-in scan is already running");
                break;
            }
            case WebCommandKind::PluginScanCancel:
                setStatus(pluginCatalog.cancelScan()
                    ? "Cancelling plug-in scan…"
                    : "No plug-in scan is running");
                break;
            case WebCommandKind::PluginSetEnabled: {
                glz::generic doc;
                std::string pluginId;
                bool enabled = true;
                if (builder_json::parseJson(cmd.json, doc)
                    && builder_json::getString(doc, "pluginId", pluginId)
                    && builder_json::getBool(doc, "enabled", enabled)) {
                    setStatus(pluginCatalog.setPluginEnabled(pluginId, enabled)
                        ? (enabled ? "Plug-in enabled" : "Plug-in disabled")
                        : "Could not update plug-in: catalog item not found");
                }
                break;
            }
            case WebCommandKind::PluginSlotAdd: pluginSlotAdd(cmd.json); break;
            case WebCommandKind::PluginSlotReplace: pluginSlotReplace(cmd.json); break;
            case WebCommandKind::PluginSlotRemove: pluginSlotRemove(cmd.json); break;
            case WebCommandKind::PluginSlotMove: pluginSlotMove(cmd.json); break;
            case WebCommandKind::PluginSlotBypass: pluginSlotBypass(cmd.json); break;
            case WebCommandKind::PluginSlotRetry: pluginSlotRetry(cmd.json); break;
            case WebCommandKind::PluginPresetSave: pluginPresetSave(cmd.json); break;
            case WebCommandKind::PluginPresetLoad: pluginPresetLoad(cmd.json); break;
            case WebCommandKind::PluginLoadDecision: {
                wire::WPluginLoadDecisionPayload p;
                if (glz::read_json(p, cmd.json)
                    || !engine.decidePluginLoading(p.epoch, p.generation, p.decision))
                    setStatus("Plug-in loading changed; use the current loading dialog");
                break;
            }
            case WebCommandKind::PluginSlotOpenEditor: pluginSlotOpenEditor(cmd.json); break;
            case WebCommandKind::PluginSlotKeepAwake: pluginSlotKeepAwake(cmd.json); break;
            case WebCommandKind::PluginSlotPark: pluginSlotPark(cmd.json); break;
            case WebCommandKind::PluginSlotUnpark: pluginSlotUnpark(cmd.json); break;
            case WebCommandKind::BuilderSongAdd: builderSongAdd(cmd.json); break;
            case WebCommandKind::BuilderSongImportFolder: builderSongImportFolder(cmd.json); break;
            case WebCommandKind::BuilderSongRemove: builderSongRemove(cmd.json); break;
            case WebCommandKind::BuilderSongMove: builderSongMove(cmd.json); break;
            case WebCommandKind::BuilderSongEnd: builderSongEnd(cmd.json); break;
            case WebCommandKind::BuilderSongUpdate: builderSongUpdate(cmd.json); break;
            case WebCommandKind::BuilderTrackAdd: builderTrackAdd(cmd.json); break;
            case WebCommandKind::BuilderTrackDuplicate: builderTrackDuplicate(cmd.json); break;
            case WebCommandKind::BuilderTrackRemove: builderTrackRemove(cmd.json); break;
            case WebCommandKind::BuilderTrackMove: builderTrackMove(cmd.json); break;
            case WebCommandKind::BuilderTrackUpdate: builderTrackUpdate(cmd.json); break;
            case WebCommandKind::BuilderTrackImportWAVBegin:
                break;
            case WebCommandKind::BuilderTrackImportWAVUpload:
                {
                    double startSeconds = 0.0;
                    std::string requestId;
                    glz::generic importOptions;
                    if (builder_json::parseJson(cmd.json, importOptions)) {
                        builder_json::getDouble(importOptions, "startSeconds", startSeconds);
                        builder_json::getString(importOptions, "requestId", requestId);
                    }
                    builderTrackImportWAVUpload(cmd.arg, static_cast<int>(cmd.value), cmd.path, startSeconds, requestId);
                }
                break;
            case WebCommandKind::BuilderTrackImportWAVDialog: builderTrackImportWAVDialog(cmd.json); break;
            case WebCommandKind::BuilderRegionAdd: builderRegionAdd(cmd.json); break;
            case WebCommandKind::BuilderRegionRemove: builderRegionRemove(cmd.json); break;
            case WebCommandKind::BuilderRegionUpdate: builderRegionUpdate(cmd.json); break;
            case WebCommandKind::BuilderMIDIRegionAdd: builderMIDIRegionAdd(cmd.json); break;
            case WebCommandKind::BuilderMIDIRegionRemove: builderMIDIRegionRemove(cmd.json); break;
            case WebCommandKind::BuilderMIDIRegionUpdate: builderMIDIRegionUpdate(cmd.json); break;
            case WebCommandKind::BuilderAutomationLaneAdd: builderAutomationLaneAdd(cmd.json); break;
            case WebCommandKind::BuilderAutomationLaneRemove: builderAutomationLaneRemove(cmd.json); break;
            case WebCommandKind::BuilderAutomationLaneUpdate: builderAutomationLaneUpdate(cmd.json); break;
            case WebCommandKind::BuilderAutomationPointAdd: builderAutomationPointAdd(cmd.json); break;
            case WebCommandKind::BuilderAutomationPointRemove: builderAutomationPointRemove(cmd.json); break;
            case WebCommandKind::BuilderAutomationPointsReplace: builderAutomationPointsReplace(cmd.json); break;
            case WebCommandKind::BuilderAutomationRecordGesture: builderAutomationRecordGesture(cmd.json); break;
            case WebCommandKind::BuilderAutomationManualOverride: {
                glz::generic payload;
                int songIndex = -1;
                std::string laneId;
                bool active = false;
                if (!builder_json::parseJson(cmd.json, payload)
                    || !builder_json::getInt(payload, "songIndex", songIndex)
                    || !builder_json::getString(payload, "laneId", laneId)
                    || !builder_json::getBool(payload, "active", active)
                    || songIndex < 0
                    || !engine.setAutomationManualOverride(
                        static_cast<size_t>(songIndex), laneId, active)) {
                    setStatus("Could not update live automation ownership; the lane may be unsupported or no longer available");
                }
                break;
            }
            case WebCommandKind::BuilderBusAdd: builderBusAdd(); break;
            case WebCommandKind::BuilderBusRemove: builderBusRemove(cmd.json); break;
            case WebCommandKind::BuilderBusMove: builderBusMove(cmd.json); break;
            case WebCommandKind::BuilderBusUpdate: builderBusUpdate(cmd.json); break;
            case WebCommandKind::BuilderEventAdd: builderEventAdd(cmd.json); break;
            case WebCommandKind::BuilderEventRemove: builderEventRemove(cmd.json); break;
            case WebCommandKind::BuilderEventMove: builderEventMove(cmd.json); break;
            case WebCommandKind::BuilderEventUpdate: builderEventUpdate(cmd.json); break;
            case WebCommandKind::BuilderSectionAdd: builderSectionAdd(cmd.json); break;
            case WebCommandKind::BuilderSectionRemove: builderSectionRemove(cmd.json); break;
            case WebCommandKind::BuilderSectionUpdate: builderSectionUpdate(cmd.json); break;
            case WebCommandKind::BuilderCycleUpdate: builderCycleUpdate(cmd.json); break;
            case WebCommandKind::SetLightingConfig: lightingSetConfig(cmd.json); break;
            case WebCommandKind::LightFixtureAdd: lightingFixtureAdd(cmd.json); break;
            case WebCommandKind::LightFixtureDuplicate: lightingFixtureDuplicate(cmd.json); break;
            case WebCommandKind::LightFixtureRemove: lightingFixtureRemove(cmd.json); break;
            case WebCommandKind::LightFixtureUpdate: lightingFixtureUpdate(cmd.json); break;
            case WebCommandKind::LightTrackAdd: lightingTrackAdd(cmd.json); break;
            case WebCommandKind::LightTrackRemove: lightingTrackRemove(cmd.json); break;
            case WebCommandKind::LightTrackMove: lightingTrackMove(cmd.json); break;
            case WebCommandKind::LightTrackUpdate: lightingTrackUpdate(cmd.json); break;
            case WebCommandKind::LightCueAdd: lightingCueAdd(cmd.json); break;
            case WebCommandKind::LightCueRemove: lightingCueRemove(cmd.json); break;
            case WebCommandKind::LightCueUpdate: lightingCueUpdate(cmd.json); break;
            case WebCommandKind::TimelineUndo: {
                // Publish the mutation and its exact acknowledgement together;
                // an intermediate snapshot could make the UI observe an
                // applied edit without its request result.
                const bool applied = performTimelineUndo(false);
                if (cmd.historyRequestId != 0) {
                    if (applied)
                        lastHistoryRequestId_ = cmd.historyRequestId;
                    historyResults_.push_back({
                        cmd.historyRequestId, applied,
                        engine.projectHistoryRevision(),
                        applied ? std::string{} : std::string("Nothing to undo"),
                    });
                    while (historyResults_.size() > 256)
                        historyResults_.pop_front();
                }
                publishWebState();
                break;
            }
            case WebCommandKind::TimelineRedo: {
                const bool applied = performTimelineRedo(false);
                if (cmd.historyRequestId != 0) {
                    if (applied)
                        lastHistoryRequestId_ = cmd.historyRequestId;
                    historyResults_.push_back({
                        cmd.historyRequestId, applied,
                        engine.projectHistoryRevision(),
                        applied ? std::string{} : std::string("Nothing to redo"),
                    });
                    while (historyResults_.size() > 256)
                        historyResults_.pop_front();
                }
                publishWebState();
                break;
            }
            case WebCommandKind::SetAudioOutputDevice: settingsSetAudioOutputDevice(cmd.json); break;
            case WebCommandKind::SetAudioInputDevice: settingsSetAudioInputDevice(cmd.json); break;
            case WebCommandKind::SetAudioDeviceType: settingsSetAudioDeviceType(cmd.json); break;
            case WebCommandKind::ShowAudioControlPanel: settingsShowAudioControlPanel(); break;
            case WebCommandKind::SetSampleRate: settingsSetSampleRate(cmd.json); break;
            case WebCommandKind::SetBufferSize: settingsSetBufferSize(cmd.json); break;
            case WebCommandKind::SetMIDIOutput: settingsSetMIDIOutput(cmd.json); break;
            case WebCommandKind::SetMIDIInput: settingsSetMIDIInput(cmd.json); break;
            case WebCommandKind::SetMIDIVirtualPort: settingsSetMIDIVirtualPort(cmd.json); break;
            case WebCommandKind::SetUiRenderEngine: settingsSetUiRenderEngine(cmd.json); break;
            case WebCommandKind::SetTheme: settingsSetTheme(cmd.json); break;
            case WebCommandKind::SetKeybinding: settingsSetKeybinding(cmd.json); break;
            case WebCommandKind::SetCountInBars: settingsSetCountInBars(cmd.json); break;
            case WebCommandKind::SetOutputChannels: settingsSetOutputChannels(cmd.json); break;
            case WebCommandKind::SetInputChannels: settingsSetInputChannels(cmd.json); break;
            case WebCommandKind::MIDILearn: settingsMIDILearn(cmd.json); break;
            case WebCommandKind::MIDILearnCancel: settingsMIDILearnCancel(); break;
            case WebCommandKind::MIDIClear: settingsMIDIClear(cmd.json); break;
            case WebCommandKind::Seek: transportSeek(cmd.json); break;
            case WebCommandKind::QuitDecision: handleQuitDecision(cmd.arg); break;
            case WebCommandKind::OpenDecision: handleOpenDecision(cmd.arg); break;
            case WebCommandKind::UiFocusState:
                // Legacy no-op: native MacKeyMonitor is gone; SPA handles focus.
                break;
            case WebCommandKind::PerformAction: {
                // From the Electron shell's menu / action bridge. cmd.json
                // carries {"action":"..."}.
                glz::generic doc;
                std::string action;
                if (builder_json::parseJson(cmd.json, doc)
                    && builder_json::getString(doc, "action", action) && !action.empty())
                    performAction(action);
                break;
            }
#if defined(RESOSTAGE_ENABLE_TEST_HOOKS)
            case WebCommandKind::TestCommandQueueNoop:
                // Saturation acceptance must not mutate project or transport state.
                break;
            case WebCommandKind::TestSetDeferredQueueHold:
                holdDeferredCommandsForTesting = cmd.arg != 0;
                setStatus(holdDeferredCommandsForTesting
                    ? "Test-only deferred command hold active"
                    : "Test-only deferred command hold released");
                publishWebState();
                break;
            case WebCommandKind::TestDeferredQueueFill:
                // Saturate the pending-project queue without publishing test state per item.
                break;
            case WebCommandKind::TestDeferredQueueProbe:
                // Transactional test probes deliberately produce no project edit.
                break;
            case WebCommandKind::TestFailNextPlaybackSnapshot:
                engine.failNextPlaybackSnapshotForTesting();
                setStatus("Test-only playback snapshot failure armed");
                publishWebState();
                break;
#endif
        }
        if (cmd.editorRequestId != 0) {
            const uint64_t revisionAfter = engine.projectHistoryRevision();
            const bool applied = revisionAfter != revisionBefore;
            const bool lightingDomain = isLightingMutation(cmd.kind);
            const bool lightingApplied = lightingDomain && applied;
            std::string error;
            uint64_t playbackProjectEpoch = 0;
            uint64_t playbackRevision = 0;
            bool playbackApplied = false;
            if (const auto graph = engine.mixGraph()) {
                playbackProjectEpoch = graph->projectEpoch;
                playbackRevision = graph->projectHistoryRevision;
                playbackApplied = playbackGraphCoversProjectRevision(
                    graph.get(), engine.currentProjectEpoch(),
                    revisionAfter);
            }
            if (!applied) {
                error = "Project edit did not create a new revision";
                if (lastStatusMessage != statusBefore && !lastStatusMessage.empty()
                    && lastStatusMessage.size() <= 256)
                    error = lastStatusMessage;
                setStatus(error);
            } else if (!lightingDomain && !playbackApplied) {
                error = "Project edit was stored, but its audio snapshot could not be published; audio continues from the last valid snapshot";
                setStatus(error);
            }
            WebUiState::EditorCommandResult result;
            result.requestId = cmd.editorRequestId;
            result.applied = applied;
            result.projectEpoch = projectEpoch_;
            result.projectRevision = revisionAfter;
            result.error = std::move(error);
            result.applicationDomain = lightingDomain ? "lighting" : "audio";
            result.playbackApplied = playbackApplied;
            result.playbackProjectEpoch = playbackProjectEpoch;
            result.playbackRevision = playbackRevision;
            // Each successful lighting handler synchronously replaces the
            // immutable LightEngine project snapshot before returning. This
            // does not claim that a physical DMX frame has already been sent.
            result.lightingApplied = lightingApplied;
            editorCommandResults_.push_back(std::move(result));
            while (editorCommandResults_.size() > 256)
                editorCommandResults_.pop_front();
            publishWebState();
        }
    };

    for (size_t i = 0; i < batch.size();) {
        if (!engine.isBusy() && isSongNav(batch[i].kind)) {
            size_t j = i + 1;
            while (j < batch.size() && isSongNav(batch[j].kind))
                ++j;
            // One stage for the whole hopscotch run (Select/Next/Prev).
            goToSong(foldSongNav(batch.data() + i, batch.data() + j));
            i = j;
            continue;
        }
        dispatchOne(batch[i]);
        ++i;
    }
}

} // namespace resostage
