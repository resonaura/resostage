/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "ThermalState.h"

namespace resostage {

const char* thermalStateName(ThermalState state) {
    switch (state) {
        case ThermalState::Fair:     return "fair";
        case ThermalState::Serious:  return "serious";
        case ThermalState::Critical: return "critical";
        case ThermalState::Nominal:  break;
    }
    return "nominal";
}

} // namespace resostage
