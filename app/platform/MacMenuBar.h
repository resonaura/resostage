#pragma once

#include <functional>
#include <string>
#include <unordered_map>

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

} // namespace resostage
