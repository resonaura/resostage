#pragma once

#include "PlatformThermalMonitor.h"

namespace resostage {

class MacThermalMonitor final : public PlatformThermalMonitor {
public:
    ThermalState currentThermalState() override;
};

} // namespace resostage
