#pragma once

#include <functional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace resostage {

using MacMenuBarCallback = std::function<void(const std::string& action)>;

void installMacMenuBar(MacMenuBarCallback onAction,
    const std::unordered_map<std::string, std::string>* initialBindings = nullptr);
void uninstallMacMenuBar();
void updateMacMenuKeyBindings(
    const std::unordered_map<std::string, std::string>& bindings);
void updateMacMenuUndoRedo(bool canUndo, bool canRedo,
                            const std::string& undoLabel,
                            const std::string& redoLabel);

// Rebuilds File > Open Recent from `recents` (most-recent-first, {path,
// displayLabel} pairs). Each item dispatches action id "open_recent:<path>"
// through the same callback passed to installMacMenuBar. An empty list
// renders a single disabled "No Recent Projects" placeholder.
void updateMacMenuRecentProjects(
    const std::vector<std::pair<std::string, std::string>>& recents);

} // namespace resostage
