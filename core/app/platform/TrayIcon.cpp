#include "TrayIcon.h"
#include "MacShellMode.h"
#include "BinaryData.h"

namespace resostage {

TrayIcon::TrayIcon(std::function<void()> onQuit_) : onQuit(std::move(onQuit_)) {
    const auto image = juce::ImageFileFormat::loadFrom(
        BinaryData::tray_png, static_cast<size_t>(BinaryData::tray_pngSize));
    setIconImage(image, image);
    setIconTooltip("ResoStage -- running in the background");
}

void TrayIcon::mouseDown(const juce::MouseEvent& e) {
    if (e.mods.isPopupMenu()) {
        juce::PopupMenu menu;
        menu.addItem("Show ResoStage", [] { activateElectronShell(); });
        menu.addItem("Quit", [this] {
            if (onQuit)
                onQuit();
        });
#if JUCE_MAC
        showDropdownMenu(menu);
#else
        menu.showMenuAsync(juce::PopupMenu::Options());
#endif
    } else {
        activateElectronShell();
    }
}

} // namespace resostage
