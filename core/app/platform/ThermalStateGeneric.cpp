#include "ThermalState.h"

namespace resostage {

#if !defined(__APPLE__)
ThermalState currentThermalState() {
    // Windows and Linux have no single equivalent of NSProcessInfo's thermal
    // state. Both expose *something* -- ACPI thermal zones, WMI, RAPL power
    // caps -- but each needs its own interpretation and none of them is a
    // ready answer to "is the OS throttling me". Reporting Nominal is the
    // honest placeholder: this number exists to be believed when everything
    // else looks healthy, so a guess would be worse than an admission.
    return ThermalState::Nominal;
}
#endif

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
