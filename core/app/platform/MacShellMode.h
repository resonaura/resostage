#pragma once

#include "PlatformShellMode.h"

namespace resostage {

class MacShellMode final : public PlatformShellMode {
public:
    void backOffToHeadlessShell() override;
    void restoreForegroundShell() override;
    void activateElectronShell() override;
    void triggerLocalNetworkPermission() override;
    void makeWindowKeyAndActive(void* nativeHandle) override;
    void forwardFocusToPluginNativeView(void* nativeHandle) override;
    bool isNativeTextInputFocused(void* nativeHandle) override;
    void setupPluginWindow(void* nativeHandle,
                           std::function<void()> onTogglePlay = nullptr,
                           std::function<void()> onClose = nullptr) override;
    void cleanupPluginWindow(void* nativeHandle) override;
    void hidePluginWindow(void* nativeHandle) override;
};

} // namespace resostage
