#pragma once

#include "PlatformThermalMonitor.h"

namespace resostage {

class WinThermalMonitor final : public PlatformThermalMonitor {
public:
    ThermalState currentThermalState() override { return ThermalState::Nominal; }
};

} // namespace resostage
