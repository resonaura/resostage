/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "PlatformShellMode.h"
#include "mac/MacShellMode.h"
#include "win/WinShellMode.h"
#include "linux/LinuxShellMode.h"

namespace resostage {

PlatformShellMode& PlatformShellMode::getInstance() {
#if defined(__APPLE__)
    static MacShellMode instance;
#elif defined(_WIN32)
    static WinShellMode instance;
#else
    static LinuxShellMode instance;
#endif
    return instance;
}

} // namespace resostage
