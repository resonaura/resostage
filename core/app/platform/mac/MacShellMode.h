/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

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
