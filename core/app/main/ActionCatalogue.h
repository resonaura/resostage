/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <string>

namespace resostage {

// Canonical list of hotkey/MIDI/menu action ids -- the single source of
// truth `isKnownActionId()` validates against (MainComponentSettings.cpp's
// settingsSetKeybinding/settingsMidiLearn) and populateSettingsState()
// iterates to build the Settings screen's binding rows.
//
// This does NOT eliminate every duplicate: MainComponent.h's keyBindings/
// extraKeyBindings maps still carry each action's *default* key description
// (an id list alone can't), MenuModel.h's per-item action ids are
// structurally tied to the menu layout (submenu grouping, titles),
// and the frontend's ACTION_GROUPS/ACTION_LABELS (ui/src/screens/
// SettingsScreen.tsx) has no build-time link to this C++ list. Keep all of
// those in sync by hand when adding a new action; this header at least
// collapses the two hand-maintained *validation* lists that used to drift
// independently (MainComponentSettings.cpp's old kActions[] and
// MainComponent.h's keyBindings) into one.
inline constexpr const char* kActionIds[] = {
    "play",
    "record",
    "stop",
    "stop_to_start",
    "next",
    "prev",
    "mode_player",
    "mode_mixer",
    "mode_editor",
    "mode_light",
    "mode_settings",
    "section_prev",
    "section_next",
    "section_last",
    "bar_prev",
    "bar_next",
    "undo",
    "redo",
};

inline bool hasNonEmptyTarget(const std::string& action, const char* prefix) {
    const std::string prefixText(prefix);
    return action.rfind(prefixText, 0) == 0
        && action.size() > prefixText.size();
}

inline bool hasTargetPair(const std::string& action, const char* prefix) {
    const std::string prefixText(prefix);
    if (action.rfind(prefixText, 0) != 0)
        return false;
    const auto separator = action.find('|', prefixText.size());
    return separator != std::string::npos
        && separator > prefixText.size()
        && separator + 1 < action.size()
        && action.find('|', separator + 1) == std::string::npos;
}

inline bool isKnownActionId(const std::string& action) {
    for (const char* a : kActionIds) {
        if (action == a)
            return true;
    }
    // Continuous parameters & dynamic targets
    if (hasNonEmptyTarget(action, "track_gain:") ||
        hasNonEmptyTarget(action, "track_pan:") ||
        hasNonEmptyTarget(action, "bus_pan:") ||
        action == "master_gain" ||
        action == "master_pan" ||
        action == "click_pan" ||
        action.rfind("send_level:", 0) == 0 ||
        action.rfind("plugin_param:", 0) == 0 ||
        hasNonEmptyTarget(action, "click_send:") ||
        hasTargetPair(action, "track_send:") ||
        action.rfind("track_arm:", 0) == 0 ||
        action.rfind("track_monitor:", 0) == 0) {
        return true;
    }
    return false;
}

// MIDI learn is intentionally narrower than keyboard rebinds: performer
// controls should trigger transport/navigation or continuous parameters, not
// switch application modes or mutate edit history from a footswitch.
inline bool isMidiMappableAction(const std::string& action) {
    for (const char* a : {"play", "record", "stop", "stop_to_start", "next", "prev",
                          "section_prev", "section_next", "section_last", "bar_prev", "bar_next"}) {
        if (action == a)
            return true;
    }
    return hasNonEmptyTarget(action, "track_gain:") ||
           hasNonEmptyTarget(action, "track_pan:") ||
           hasNonEmptyTarget(action, "bus_pan:") ||
           action == "master_gain" ||
           action == "master_pan" ||
           action == "click_pan" ||
           hasNonEmptyTarget(action, "send_level:") ||
           hasNonEmptyTarget(action, "plugin_param:") ||
           hasNonEmptyTarget(action, "click_send:") ||
           hasTargetPair(action, "track_send:") ||
           hasNonEmptyTarget(action, "track_arm:") ||
           hasNonEmptyTarget(action, "track_monitor:");
}

} // namespace resostage
