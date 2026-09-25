#pragma once

#include <functional>

namespace resostage {

class PlatformShellMode {
public:
    virtual ~PlatformShellMode() = default;

    // Electron shell mode: the on-screen UI lives in the Electron window (which
    // has its own dock icon and menu bar), so the JUCE process backs off to a
    // headless accessory -- no window, and removed from the Dock so there aren't
    // two ResoStage icons fighting for the user's attention. The backend (audio,
    // web server, transport) keeps running untouched. No-ops on non-macOS.
    virtual void backOffToHeadlessShell() = 0;
    virtual void restoreForegroundShell() = 0;

    // Brings the Electron shell's window to the front -- used by the tray icon
    // (platform/TrayIcon.cpp) since this process has no window of its own to
    // show. No-op if the shell isn't running.
    virtual void activateElectronShell() = 0;

    // Explicitly triggers macOS Local Network Privacy prompt on startup
    virtual void triggerLocalNetworkPermission() {}

    // Native window key focus and plug-in subview event routing
    virtual void makeWindowKeyAndActive(void* /*nativeHandle*/) {}
    virtual void forwardFocusToPluginNativeView(void* /*nativeHandle*/) {}
    virtual bool isNativeTextInputFocused(void* /*nativeHandle*/) { return false; }
    virtual void setupPluginWindow(void* /*nativeHandle*/,
                                   std::function<void()> /*onTogglePlay*/ = nullptr,
                                   std::function<void()> /*onClose*/ = nullptr) {}
    virtual void cleanupPluginWindow(void* /*nativeHandle*/) {}
    virtual void hidePluginWindow(void* /*nativeHandle*/) {}

    // Singleton access for current host platform
    static PlatformShellMode& getInstance();
};

// Global inline wrappers for backwards compatibility
inline void backOffToHeadlessShell() {
    PlatformShellMode::getInstance().backOffToHeadlessShell();
}

inline void restoreForegroundShell() {
    PlatformShellMode::getInstance().restoreForegroundShell();
}

inline void activateElectronShell() {
    PlatformShellMode::getInstance().activateElectronShell();
}

inline void triggerLocalNetworkPermission() {
    PlatformShellMode::getInstance().triggerLocalNetworkPermission();
}

} // namespace resostage
