#pragma once

namespace resostage {

// Electron shell mode: the on-screen UI lives in the Electron window (which
// has its own dock icon and menu bar), so the JUCE process backs off to a
// headless accessory -- no window, and removed from the Dock so there aren't
// two ResoStage icons fighting for the user's attention. The backend (audio,
// web server, transport) keeps running untouched. No-ops on non-macOS.
void backOffToHeadlessShell();
void restoreForegroundShell();

// Brings the Electron shell's window to the front -- used by the tray icon
// (platform/TrayIcon.cpp) since this process has no window of its own to
// show. No-op if the shell isn't running.
void activateElectronShell();

} // namespace resostage
