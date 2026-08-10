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
