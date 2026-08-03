#pragma once

namespace resostage {

// Electron shell mode: the on-screen UI lives in the Electron window (which
// has its own dock icon and menu bar), so the JUCE process backs off to a
// headless accessory -- no window, and removed from the Dock so there aren't
// two ResoStage icons fighting for the user's attention. The backend (audio,
// web server, transport) keeps running untouched. No-ops on non-macOS.
void backOffToHeadlessShell();
void restoreForegroundShell();

} // namespace resostage
