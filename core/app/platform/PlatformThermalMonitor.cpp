// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#include "PlatformThermalMonitor.h"
#include "mac/MacThermalMonitor.h"
#include "win/WinThermalMonitor.h"
#include "linux/LinuxThermalMonitor.h"

namespace resostage {

PlatformThermalMonitor& PlatformThermalMonitor::getInstance() {
#if defined(__APPLE__)
    static MacThermalMonitor instance;
#elif defined(_WIN32)
    static WinThermalMonitor instance;
#else
    static LinuxThermalMonitor instance;
#endif
    return instance;
}

ThermalState currentThermalState() {
    return PlatformThermalMonitor::getInstance().currentThermalState();
}

} // namespace resostage
