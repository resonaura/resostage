#pragma once

#include <string>
#include <vector>

namespace resostage {

// Single source of truth for the *application menu structure* served to the
// Electron shell as JSON (GET /api/v1/ui/menu). Not an AppKit/JUCE menu --
// Core is headless; Electron builds the real NSMenu from this table.
// Edit only here.
struct MenuItemModel {
    enum class Kind {
        Item,
        Separator,
        // "Open Recent" -- File > Open Recent. The concrete items are
        // project-dependent, so the Electron shell fills the submenu at
        // runtime from the recentProjects array in the same JSON.
        OpenRecent,
    };

    Kind kind = Kind::Item;
    std::string title;
    // Dispatched via performAction() / POST /api/v1/action. "quit" is special
    // (runs the unsaved-changes prompt before quitting).
    std::string actionId;
    // Fixed accelerator description in "cmd + shift + s" form; empty = none.
    // dynamicKey items instead follow the user's Settings > Keybindings.
    std::string key;
    bool dynamicKey = false;
    // System item the OS/Electron handle natively: "about" | "quit" |
    // "minimize" | "zoom". When set, actionId is ignored.
    std::string role;
    std::vector<MenuItemModel> children;
};

struct MenuSectionModel {
    std::string title;
    std::vector<MenuItemModel> items;
};

// Touch Bar screen buttons -- the same five SPA tabs everywhere (the
// Electron shell's main process builds these from /api/v1/ui/menu).
struct TouchBarTabModel {
    std::string id;
    std::string label;
};

// Menu sections, top-level order. Returned by value (cheap; built once).
const std::vector<MenuSectionModel>& menuModel();
const std::vector<TouchBarTabModel>& touchBarTabs();

} // namespace resostage
