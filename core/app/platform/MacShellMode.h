#pragma once

#include "PlatformShellMode.h"

namespace resostage {

class MacShellMode final : public PlatformShellMode {
public:
    void backOffToHeadlessShell() override;
    void restoreForegroundShell() override;
    void activateElectronShell() override;
    void triggerLocalNetworkPermission() override;
};

} // namespace resostage
