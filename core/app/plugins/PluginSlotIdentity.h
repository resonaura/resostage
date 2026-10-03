/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <cstddef>
#include <string_view>

namespace resostage {

/** Result of a bounded bank scan for one exact or legacy plug-in slot target. */
struct PluginSlotLookup {
    static constexpr size_t kNoIndex = static_cast<size_t>(-1);

    size_t stripIndex = kNoIndex;
    size_t slotIndex = kNoIndex;
    bool ambiguous = false;

    [[nodiscard]] bool found() const noexcept { return stripIndex != kNoIndex; }
    [[nodiscard]] bool unique() const noexcept { return found() && !ambiguous; }
};

/**
 * Records a bank slot only when the requested identity matches. An empty
 * requested strip is the pre-scoped compatibility path and succeeds only if
 * exactly one physical strip owns the slot ID.
 */
inline void considerPluginSlot(
    PluginSlotLookup& result,
    std::string_view requestedStripId,
    std::string_view requestedSlotId,
    std::string_view candidateStripId,
    std::string_view candidateSlotId,
    size_t candidateStripIndex,
    size_t candidateSlotIndex) noexcept {
    if (requestedSlotId != candidateSlotId
        || (!requestedStripId.empty() && requestedStripId != candidateStripId))
        return;

    if (!result.found()) {
        result.stripIndex = candidateStripIndex;
        result.slotIndex = candidateSlotIndex;
        return;
    }

    if (result.stripIndex != candidateStripIndex
        || result.slotIndex != candidateSlotIndex)
        result.ambiguous = true;
}

} // namespace resostage
