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
