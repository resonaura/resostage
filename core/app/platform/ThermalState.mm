/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "ThermalState.h"

#import <Foundation/Foundation.h>

namespace resostage {

ThermalState currentThermalState() {
    // NSProcessInfo caches this; the property is a cheap read of state the
    // system already maintains, so polling it at telemetry rate costs nothing
    // worth measuring.
    if (@available(macOS 10.10.3, *)) {
        switch ([[NSProcessInfo processInfo] thermalState]) {
            case NSProcessInfoThermalStateNominal:  return ThermalState::Nominal;
            case NSProcessInfoThermalStateFair:     return ThermalState::Fair;
            case NSProcessInfoThermalStateSerious:  return ThermalState::Serious;
            case NSProcessInfoThermalStateCritical: return ThermalState::Critical;
        }
    }
    return ThermalState::Nominal;
}

} // namespace resostage
