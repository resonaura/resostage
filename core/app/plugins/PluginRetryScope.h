/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <string_view>

namespace resostage {

/** An empty retry scope means all chains; otherwise only the exact stable strip. */
inline bool pluginRetryIncludesStrip(std::string_view retryStripId,
                                     std::string_view stripId) noexcept {
    return retryStripId.empty() || retryStripId == stripId;
}

} // namespace resostage
