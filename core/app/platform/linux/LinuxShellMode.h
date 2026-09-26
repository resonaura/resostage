#pragma once

#include "PlatformShellMode.h"

namespace resostage {

class LinuxShellMode final : public PlatformShellMode {
public:
    void backOffToHeadlessShell() override {}
    void restoreForegroundShell() override {}
    void activateElectronShell() override {}
};

} // namespace resostage
