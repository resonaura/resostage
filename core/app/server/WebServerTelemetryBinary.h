#pragma once

#include "WebServer.h"

#include <cstdint>
#include <vector>

namespace resostage {

// Build the versioned binary snapshot consumed by Electron and remote UDP
// telemetry clients. Kept separate from HTTP/WebSocket serialization.
std::vector<uint8_t> buildBinaryTelemetryFrame(const WebUiState& state, uint32_t sequence);

} // namespace resostage
