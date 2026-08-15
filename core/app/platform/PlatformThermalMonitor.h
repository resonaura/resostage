#pragma once

#include "ThermalState.h"

namespace resostage {

class PlatformThermalMonitor {
public:
    virtual ~PlatformThermalMonitor() = default;
    virtual ThermalState currentThermalState() = 0;

    static PlatformThermalMonitor& getInstance();
};

} // namespace resostage
