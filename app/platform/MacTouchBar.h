#pragma once

#include <functional>
#include <string>

namespace resostage {

// Optional macOS Touch Bar: screen/mode switcher.
//
// Safe on Macs *without* a Touch Bar — AppKit simply never shows the bar;
// install is a no-op on non-Apple builds. No runtime hardware probe needed
// (Apple documents that apps should not branch on Touch Bar presence).
//
// `onSelect` receives SPA tab ids: "player" | "mixer" | "editor" | "light" |
// "settings".
// `nsViewOrWindow` may be an NSView* (JUCE peer handle) or NSWindow* — we
// resolve the NSWindow internally (ObjC stays in the .mm).
//
// Call after the native window is visible. Call uninstall on shutdown / window
// close (or when replacing the window).
void installMacTouchBar(void* nsViewOrWindow, std::function<void(const std::string& tabId)> onSelect);
void uninstallMacTouchBar(void* nsViewOrWindow);
void setMacTouchBarActiveTab(void* nsViewOrWindow, const std::string& tabId);

} // namespace resostage
