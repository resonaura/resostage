#pragma once

#include <functional>
#include <string>
#include <juce_gui_extra/juce_gui_extra.h>

namespace resostage {

// Menu-bar presence for the headless Core process when the Electron shell
// owns the Dock icon (see RESOSTAGE_SPAWNED_BY_SHELL in MainComponent.cpp)
// -- it deliberately never gets a Dock icon of its own, so this gives the
// user somewhere to see it's running and quit it if needed.
// What the menu can do and what it needs to know to label itself. Passed in
// rather than reached for, so this file stays free of the engine.
struct TrayCallbacks {
    // Action names as understood by MainComponent::performAction -- the same
    // path hotkeys and MIDI take, so the tray cannot drift from them.
    std::function<void(const std::string&)> perform;
    std::function<bool()> isPlaying;
    std::function<std::string()> currentSongName;
    std::function<void()> quit;
};

class TrayIcon final : public juce::SystemTrayIconComponent {
public:
    explicit TrayIcon(TrayCallbacks callbacks);

    void mouseDown(const juce::MouseEvent&) override;

private:
    TrayCallbacks cb;
};

} // namespace resostage
