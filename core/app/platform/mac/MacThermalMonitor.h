/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "PlatformThermalMonitor.h"

namespace resostage {

class MacThermalMonitor final : public PlatformThermalMonitor {
public:
    ThermalState currentThermalState() override;
};

} // namespace resostage
