// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#pragma once

#include "WebServer.h"

#include <cstdint>
#include <vector>

namespace resostage {

// Build the versioned binary snapshot consumed by Electron and remote UDP
// telemetry clients. Kept separate from HTTP/WebSocket serialization.
std::vector<uint8_t> buildBinaryTelemetryFrame(const WebUiState& state, uint32_t sequence);

} // namespace resostage
