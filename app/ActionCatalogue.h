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
// (an id list alone can't), MacMenuBar.mm's per-item action ids are
// structurally tied to the native menu layout (submenu grouping, titles),
// and the frontend's ACTION_GROUPS/ACTION_LABELS (ui/src/screens/
// SettingsScreen.tsx) has no build-time link to this C++ list. Keep all of
// those in sync by hand when adding a new action; this header at least
// collapses the two hand-maintained *validation* lists that used to drift
// independently (MainComponentSettings.cpp's old kActions[] and
// MainComponent.h's keyBindings) into one.
inline constexpr const char* kActionIds[] = {
    "play",
    "stop",
    "stop_to_start",
    "next",
    "prev",
    "mode_player",
    "mode_mixer",
    "mode_editor",
    "mode_settings",
    "section_prev",
    "section_next",
    "section_last",
    "undo",
    "redo",
};

inline bool isKnownActionId(const std::string& action) {
    for (const char* a : kActionIds) {
        if (action == a)
            return true;
    }
    return false;
}

} // namespace resostage
