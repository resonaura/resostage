// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#pragma once

#include <cstddef>

namespace resostage {

// A bounded, allocation-free activity snapshot can represent every MIDI pitch
// on a deliberately generous number of project tracks. Core's callback-owned
// counters and the v9 live telemetry codec share these limits.
inline constexpr size_t kMaxActiveMidiTracks = 1024;
inline constexpr size_t kMidiPitchCount = 128;

} // namespace resostage
