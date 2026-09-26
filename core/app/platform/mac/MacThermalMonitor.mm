#if defined(__APPLE__)
#import <Foundation/Foundation.h>
#include "MacThermalMonitor.h"

namespace resostage {

ThermalState MacThermalMonitor::currentThermalState() {
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
#endif
