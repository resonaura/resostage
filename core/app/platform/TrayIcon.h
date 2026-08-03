#pragma once

#include <functional>
#include <juce_gui_extra/juce_gui_extra.h>

namespace resostage {

// Menu-bar presence for the headless Core process when the Electron shell
// owns the Dock icon (see RESOSTAGE_SPAWNED_BY_SHELL in MainComponent.cpp)
// -- it deliberately never gets a Dock icon of its own, so this gives the
// user somewhere to see it's running and quit it if needed.
class TrayIcon final : public juce::SystemTrayIconComponent {
public:
    explicit TrayIcon(std::function<void()> onQuit);

    void mouseDown(const juce::MouseEvent&) override;

private:
    std::function<void()> onQuit;
};

} // namespace resostage
