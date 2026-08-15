#include "TrayIcon.h"
#include "PlatformShellMode.h"
#include "BinaryData.h"

#if JUCE_WINDOWS
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

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

    const bool playing = cb.isPlaying && cb.isPlaying();
    const std::string song = cb.currentSongName ? cb.currentSongName() : std::string();

#if JUCE_MAC
    juce::PopupMenu menu;
    if (!song.empty()) {
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
    showDropdownMenu(menu);
#elif JUCE_WINDOWS
    // Native Win32 TrackPopupMenuEx for 100% OS native Windows tray popup menu
    HMENU hMenu = ::CreatePopupMenu();
    if (!song.empty()) {
        const std::wstring wSong(song.begin(), song.end());
        ::AppendMenuW(hMenu, MF_STRING | MF_DISABLED, 0, wSong.c_str());
        ::AppendMenuW(hMenu, MF_SEPARATOR, 0, NULL);
    }
    ::AppendMenuW(hMenu, MF_STRING, 1, playing ? L"Pause" : L"Play");
    ::AppendMenuW(hMenu, MF_STRING, 2, L"Stop");
    ::AppendMenuW(hMenu, MF_SEPARATOR, 0, NULL);
    ::AppendMenuW(hMenu, MF_STRING, 3, L"Previous Song");
    ::AppendMenuW(hMenu, MF_STRING, 4, L"Next Song");
    ::AppendMenuW(hMenu, MF_SEPARATOR, 0, NULL);
    ::AppendMenuW(hMenu, MF_STRING, 5, L"Show ResoStage");
    ::AppendMenuW(hMenu, MF_STRING, 6, L"Exit");

    POINT pt;
    ::GetCursorPos(&pt);
    HWND dummyHwnd = static_cast<HWND>(getNativeHandle());
    if (dummyHwnd != NULL) {
        ::SetForegroundWindow(dummyHwnd);
    }
    const int cmd = ::TrackPopupMenuEx(hMenu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON, pt.x, pt.y, dummyHwnd, NULL);
    ::DestroyMenu(hMenu);

    if (cmd == 1) { if (cb.perform) cb.perform("play"); }
    else if (cmd == 2) { if (cb.perform) cb.perform("stop"); }
    else if (cmd == 3) { if (cb.perform) cb.perform("prev"); }
    else if (cmd == 4) { if (cb.perform) cb.perform("next"); }
    else if (cmd == 5) { activateElectronShell(); }
    else if (cmd == 6) { if (cb.quit) cb.quit(); }
#else
    juce::PopupMenu menu;
    menu.addItem(playing ? "Pause" : "Play", [this] { if (cb.perform) cb.perform("play"); });
    menu.addItem("Show ResoStage", [] { activateElectronShell(); });
    menu.addItem("Quit", [this] { if (cb.quit) cb.quit(); });
    menu.showMenuAsync(juce::PopupMenu::Options());
#endif
}

} // namespace resostage
