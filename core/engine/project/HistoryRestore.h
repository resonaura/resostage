/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "ProjectSchema.h"

#include <algorithm>
#include <optional>
#include <string_view>

namespace resostage {

/** Keep runtime song focus attached to its stable ID across history reorder. */
inline std::optional<size_t> resolveHistorySongIndex(const Project& restored,
                                                    std::string_view selectedId,
                                                    size_t previousIndex) {
    for (size_t i = 0; i < restored.songs.size(); ++i) {
        if (!selectedId.empty() && restored.songs[i].id == selectedId)
            return i;
    }
    if (restored.songs.empty())
        return std::nullopt;
    // If the selected song was removed, choose the nearest surviving slot.
    // An invalid index (no staged song) selects the first, not the last.
    return previousIndex == static_cast<size_t>(-1)
        ? size_t{0} : std::min(previousIndex, restored.songs.size() - 1);
}

} // namespace resostage
