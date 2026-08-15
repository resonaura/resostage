#pragma once

#include "PlatformThermalMonitor.h"

namespace resostage {

class LinuxThermalMonitor final : public PlatformThermalMonitor {
public:
    ThermalState currentThermalState() override { return ThermalState::Nominal; }
};

} // namespace resostage
