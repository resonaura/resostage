/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "MainComponent.h"
#include "ActionCatalogue.h"
#include "midi/MidiContinuousTargets.h"
#include "project/ProjectJson.h"
#include "project/RecentProjects.h"
#include "timing/BarSeek.h"

#include <algorithm>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace resostage {

void MainComponent::performAction(const std::string& action) {
    // Covers MIDI, the Electron menu bar, and web action POSTs alike (see
    // field doc comment) -- publishWebState() mirrors this into WebUiState so
    // SettingsScreen can flash the one binding row that actually fired.
    lastAction_ = action;
    ++lastActionNonce_;

    if (action == "play")
        togglePlayback();
    else if (action == "record")
        engine.toggleRecording();
    else if (action == "stop")
        engine.stop();
    else if (action == "stop_to_start")
        engine.stopToStart();
    else if (action == "next")
        nextSong();
    else if (action == "prev")
        prevSong();
    else if (action == "mode_player")
        requestUiTab("player");
    else if (action == "mode_mixer")
        requestUiTab("mixer");
    else if (action == "mode_editor")
        requestUiTab("editor");
    else if (action == "mode_light")
        requestUiTab("light");
    else if (action == "mode_settings")
        requestUiTab("settings");
    else if (action == "section_prev")
        jumpToSectionRelative(-1);
    else if (action == "section_next")
        jumpToSectionRelative(+1);
    else if (action == "section_last")
        jumpToLastSection();
    else if (action == "bar_prev")
        jumpToBarRelative(-1);
    else if (action == "bar_next")
        jumpToBarRelative(+1);
    else if (action == "undo")
        performTimelineUndo();
    else if (action == "redo")
        performTimelineRedo();
    else if (action == "new_project")
        newProjectClicked();
    else if (action == "open_project")
        loadProjectClicked();
    else if (action == "save_project")
        saveProjectClicked(false);
    else if (action == "save_project_as")
        saveProjectClicked(true);
    else if (action == "cancel_save_as") {
        if (pendingSaveAsCallback) {
            auto cb = std::move(pendingSaveAsCallback);
            pendingSaveAsCallback = nullptr;
            if (cb) cb(false);
        }
        publishWebState();
    }
    else if (action == "import_song_folder")
        importSongFolderNative();
    else if (action == "clear_recent_projects") {
        appSettings.recentProjects.clear();
        saveAppSettingsToDisk();
        publishWebState();
    }
    else if (action == "quit") {
        if (auto* app = juce::JUCEApplication::getInstance())
            app->systemRequestedQuit();
    }
    else if (action == "restart_app") {
        // Settings > UI engine change: relaunch the app so the new display
        // framework takes effect. `open -n` forces a fresh instance; the 1s
        // delay lets this instance quit (and flush autosaves) first.
        const juce::File bundle = juce::File::getSpecialLocation(
            juce::File::currentApplicationFile);
        if (bundle.isDirectory()) {
            const juce::String cmd = "sleep 1; /usr/bin/open -n '" + bundle.getFullPathName() + "'";
            juce::ChildProcess spawner;
            spawner.start(cmd); // shell child is orphaned after quit and keeps running
        }
        if (auto* app = juce::JUCEApplication::getInstance())
            app->systemRequestedQuit();
    }
    else if (action.rfind("open_recent:", 0) == 0) {
        const std::string path = action.substr(std::string("open_recent:").size());
        // Native Electron Recent menu and renderer Recent list share the same
        // unsaved-change gate. Only a genuinely missing path is pruned; an
        // existing but invalid project remains available for recovery.
        openRecentProjectFromPath(path);
    }
    else if (action.rfind("open_path:", 0) == 0) {
        const std::string path = action.substr(std::string("open_path:").size());
        openProjectFromIpc(path);
    }
    else if (action.rfind("save_as_path:", 0) == 0) {
        const std::string path = action.substr(std::string("save_as_path:").size());
        saveProjectToPath(path);
    }
    else if (action.rfind("import_song_folder_path:", 0) == 0) {
        const std::string path = action.substr(std::string("import_song_folder_path:").size());
        importSongFolderFromPath(path);
    }
}

void MainComponent::performContinuousAction(const std::string& target, float normalizedVal) {
    const float val = std::clamp(normalizedVal, 0.0f, 1.0f);
    if (target.rfind("track_gain:", 0) == 0) {
        try {
            const size_t idx = static_cast<size_t>(std::stoul(target.substr(11)));
            const double gainDb = (val <= 0.001f) ? -100.0 : (val < 0.75f ? -60.0 + (val / 0.75f) * 60.0 : (val - 0.75f) / 0.25f * 6.0);
            engine.setTrackGainDb(engine.currentSongIndex(), idx, gainDb);
        } catch (...) {}
    } else if (target.rfind("track_pan:", 0) == 0) {
        const auto& project = engine.project();
        const auto idx = midi_control::trackIndexForTarget(
            project, std::string_view(target).substr(10));
        if (idx)
            engine.setTrackPan(engine.currentSongIndex(), *idx,
                               static_cast<double>(val * 2.0f - 1.0f));
    } else if (target == "master_pan") {
        engine.setBusPan(0, static_cast<double>(val * 2.0f - 1.0f));
    } else if (target == "click_pan") {
        engine.project().click.pan = static_cast<double>(val * 2.0f - 1.0f);
        engine.refreshClickState();
    } else if (target.rfind("bus_pan:", 0) == 0) {
        const auto& project = engine.project();
        const auto index = midi_control::sendBusIndexForTarget(
            project, std::string_view(target).substr(8));
        if (index)
            engine.setBusPan(*index, static_cast<double>(val * 2.0f - 1.0f));
    } else if (target.rfind("track_send:", 0) == 0) {
        const auto pair = midi_control::parseTrackSendTarget(
            std::string_view(target).substr(11));
        if (!pair)
            return;
        const auto& project = engine.project();
        const auto trackIndex = midi_control::trackIndexForTarget(project, pair->trackId);
        if (!trackIndex)
            return;
        auto& sends = engine.project().tracks[*trackIndex].output.sends;
        const auto send = std::find_if(sends.begin(), sends.end(),
            [busId = pair->busId](const SendConfig& candidate) { return candidate.bus == busId; });
        if (send == sends.end())
            return;
        SendConfig updated = *send;
        updated.level = sendDbToLevel(-60.0 + static_cast<double>(val) * 60.0);
        const auto sendIndex = static_cast<size_t>(send - sends.begin());
        engine.setTrackSend(engine.currentSongIndex(), *trackIndex,
                            sendIndex, updated);
    } else if (target.rfind("click_send:", 0) == 0) {
        auto& sends = engine.project().click.output.sends;
        const std::string_view busId = std::string_view(target).substr(11);
        const auto send = std::find_if(sends.begin(), sends.end(),
            [busId](const SendConfig& candidate) { return candidate.bus == busId; });
        if (send == sends.end())
            return;
        send->level = sendDbToLevel(-60.0 + static_cast<double>(val) * 60.0);
        engine.refreshClickState();
    } else if (target.rfind("track_arm:", 0) == 0) {
        try {
            const size_t idx = static_cast<size_t>(std::stoul(target.substr(10)));
            engine.setTrackRecordArmed(engine.currentSongIndex(), idx, val > 0.5f);
        } catch (...) {}
    } else if (target.rfind("track_monitor:", 0) == 0) {
        try {
            const size_t idx = static_cast<size_t>(std::stoul(target.substr(14)));
            engine.setTrackInputMonitoring(engine.currentSongIndex(), idx, val > 0.5f);
        } catch (...) {}
    } else if (target == "master_gain") {
        const double gainDb = (val <= 0.001f) ? -100.0 : (val < 0.75f ? -60.0 + (val / 0.75f) * 60.0 : (val - 0.75f) / 0.25f * 6.0);
        engine.setBusGainDb(0, gainDb);
    } else if (target == "master_pan") {
        const double pan = static_cast<double>(val * 2.0f - 1.0f);
        engine.setBusPan(0, pan);
    } else if (target.rfind("send_level:", 0) == 0) {
        try {
            const size_t busIdx = static_cast<size_t>(std::stoul(target.substr(11)));
            const double gainDb = (val <= 0.001f) ? -100.0 : (val < 0.75f ? -60.0 + (val / 0.75f) * 60.0 : (val - 0.75f) / 0.25f * 6.0);
            engine.setBusGainDb(busIdx, gainDb);
        } catch (...) {}
    } else if (target.rfind("plugin_param:", 0) == 0) {
        const std::string rest = target.substr(13);
        const auto colon1 = rest.find(':');
        if (colon1 != std::string::npos) {
            const auto colon2 = rest.find(':', colon1 + 1);
            if (colon2 != std::string::npos) {
                try {
                    const size_t stripIdx = static_cast<size_t>(std::stoul(rest.substr(0, colon1)));
                    const size_t slotIdx = static_cast<size_t>(std::stoul(rest.substr(colon1 + 1, colon2 - colon1 - 1)));
                    const int paramIdx = std::stoi(rest.substr(colon2 + 1));
                    engine.setPluginParameter(stripIdx, slotIdx, paramIdx, val);
                } catch (...) {}
            }
        }
    }
}


void MainComponent::jumpToSectionRelative(int delta) {
    if (!engine.isProjectLoaded() || delta == 0)
        return;
    const Project& proj = engine.project();
    const size_t songIdx = engine.currentSongIndex();
    if (songIdx >= proj.songs.size())
        return;
    const auto& sections = proj.songs[songIdx].sections;
    if (sections.empty())
        return;

    // Sorted copy by start time -- markers aren't required to be authored
    // in order, and "prev/next" only make sense along the timeline.
    std::vector<const SongSection*> ordered;
    ordered.reserve(sections.size());
    for (const auto& s : sections)
        ordered.push_back(&s);
    std::sort(ordered.begin(), ordered.end(),
              [](const SongSection* a, const SongSection* b) {
                  return a->startSeconds < b->startSeconds;
              });

    const double playhead = engine.transport().playheadSeconds.load(std::memory_order_relaxed);
    // Small epsilon so landing exactly on a marker still counts as "at" it
    // (prev then jumps to the previous one rather than re-seeking here).
    constexpr double kEps = 0.05;

    int at = -1;
    for (int i = 0; i < static_cast<int>(ordered.size()); ++i) {
        if (playhead + kEps >= ordered[static_cast<size_t>(i)]->startSeconds)
            at = i;
    }

    int target = at + delta;
    if (delta < 0 && at < 0)
        target = 0; // before first marker: prev snaps to the first
    if (target < 0 || target >= static_cast<int>(ordered.size()))
        return;

    std::string error;
    if (!engine.seekToSeconds(ordered[static_cast<size_t>(target)]->startSeconds, error))
        setStatus("Section seek failed: " + juce::String(error));
    else
        setStatus("Section: " + juce::String(ordered[static_cast<size_t>(target)]->name));
}

void MainComponent::jumpToLastSection() {
    if (!engine.isProjectLoaded())
        return;
    const Project& proj = engine.project();
    const size_t songIdx = engine.currentSongIndex();
    if (songIdx >= proj.songs.size())
        return;
    const auto& sections = proj.songs[songIdx].sections;
    if (sections.empty())
        return;

    const SongSection* last = &sections.front();
    for (const auto& s : sections) {
        if (s.startSeconds >= last->startSeconds)
            last = &s;
    }
    std::string error;
    if (!engine.seekToSeconds(last->startSeconds, error))
        setStatus("Section seek failed: " + juce::String(error));
    else
        setStatus("Section: " + juce::String(last->name));
}

void MainComponent::jumpToBarRelative(int direction) {
    if (!engine.isProjectLoaded() || direction == 0)
        return;
    const Project& proj = engine.project();
    const size_t songIdx = engine.currentSongIndex();
    if (songIdx >= proj.songs.size())
        return;
    const SongDef& song = proj.songs[songIdx];

    const double playhead = engine.transport().playheadSeconds.load(std::memory_order_relaxed);
    const double target = barSeekTargetSeconds(playhead, song.bpm, song.timeSignature.numerator, direction);

    std::string error;
    if (!engine.seekToSeconds(target, error))
        setStatus("Bar seek failed: " + juce::String(error));
}


void MainComponent::handleMidiLearnMessage(MidiTriggerType type, int channel1to16, int number) {
    // Web UI learn: one-shot arm for a named action.
    if (midiLearnAction.empty())
        return;
    if (!supportsMidiTriggerForTarget(midiLearnAction, type)) {
        setStatus("Continuous MIDI controls require a Control Change (CC); learn remains armed");
        return;
    }
    const std::string action = midiLearnAction;
    midiLearnAction.clear();

    auto& mappings = appSettings.midiMappings;
    MidiMapping* existing = nullptr;
    for (auto& m : mappings) {
        if (m.action == action) {
            existing = &m;
            break;
        }
    }
    if (existing == nullptr) {
        mappings.push_back(MidiMapping{});
        existing = &mappings.back();
        existing->action = action;
    }
    existing->triggerType = type;
    existing->channel = channel1to16;
    existing->number = number;
    applyGlobalBindings();
    saveAppSettingsToDisk();
    setStatus("MIDI learn: " + juce::String(action)
              + " <- ch" + juce::String(channel1to16)
              + (type == MidiTriggerType::ControlChange ? " CC" : " note")
              + juce::String(number));
}


void MainComponent::applyGlobalBindings() {
    // Global (Application Support), not per-project -- see AppSettings.h.
    // Backfill missing actions with compiled-in defaults; saved settings win.
    bool migratedLegacyBarKeys = false;
    if (const auto previous = appSettings.keybindings.find("bar_prev");
        previous != appSettings.keybindings.end() && previous->second == "left") {
        previous->second = ",";
        migratedLegacyBarKeys = true;
    }
    if (const auto next = appSettings.keybindings.find("bar_next");
        next != appSettings.keybindings.end() && next->second == "right") {
        next->second = ".";
        migratedLegacyBarKeys = true;
    }
    for (const auto& [action, description] : keyBindings)
        appSettings.keybindings.try_emplace(action, description);

    const auto oldMappingCount = appSettings.midiMappings.size();
    std::erase_if(appSettings.midiMappings, [](const MidiMapping& mapping) {
        return !isMidiMappableAction(mapping.action);
    });
    if (migratedLegacyBarKeys || oldMappingCount != appSettings.midiMappings.size())
        saveAppSettingsToDisk();

    for (const auto& [action, description] : appSettings.keybindings)
        keyBindings[action] = description;
    midiInput.setMappings(appSettings.midiMappings);
}


} // namespace resostage
