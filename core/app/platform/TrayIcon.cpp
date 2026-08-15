#include "TrayIcon.h"
#include "PlatformShellMode.h"
#include "BinaryData.h"

namespace resostage {

TrayIcon::TrayIcon(TrayCallbacks callbacks) : cb(std::move(callbacks)) {
    const auto image = juce::ImageFileFormat::loadFrom(
        BinaryData::tray_png, static_cast<size_t>(BinaryData::tray_pngSize));
    setIconImage(image, image);
    setIconTooltip("ResoStage -- running in the background");
}

void TrayIcon::mouseDown(const juce::MouseEvent& e) {
    if (!e.mods.isPopupMenu()) {
        activateElectronShell();
        return;
    }

    // Transport from the menu bar is the point of this thing: the shell can be
    // behind a full-screen browser or on another Space, and the one moment you
    // need to stop the music is the one moment you cannot find the window.
    const bool playing = cb.isPlaying && cb.isPlaying();
    const std::string song = cb.currentSongName ? cb.currentSongName() : std::string();

    juce::PopupMenu menu;
    if (!song.empty()) {
        // A disabled header, not a title: it says WHICH song the transport
        // items below are about, which is the thing you check before hitting
        // Next on a stage.
        menu.addSectionHeader(juce::String(song));
    }
    const auto act = [this](const char* name) {
        return [this, name] {
            if (cb.perform)
                cb.perform(name);
        };
    };
    menu.addItem(playing ? "Pause" : "Play", act("play"));
    menu.addItem("Stop", act("stop"));
    menu.addSeparator();
    menu.addItem("Previous Song", act("prev"));
    menu.addItem("Next Song", act("next"));
    menu.addSeparator();
    menu.addItem("Show ResoStage", [] { activateElectronShell(); });
    menu.addItem("Quit", [this] {
        if (cb.quit)
            cb.quit();
    });

#if JUCE_MAC
    showDropdownMenu(menu);
#else
    menu.showMenuAsync(juce::PopupMenu::Options());
#endif
}

} // namespace resostage
