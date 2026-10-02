/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>

namespace resostage {

struct PluginParameterBinding {
    std::string id;
    uint32_t index = 0;
};

/**
 * Callback-safe lookup in a table sorted during bank preparation. New lanes
 * use vendor identities; legacy param:N/numeric targets keep their index.
 * Missing vendor IDs never fall back to another parameter at the old index.
 */
inline int resolvePluginParameterBinding(std::span<const PluginParameterBinding> bindings,
                                        std::string_view id) noexcept {
    if (id.starts_with("id:")) {
        const auto found = std::lower_bound(bindings.begin(), bindings.end(), id,
            [](const PluginParameterBinding& binding, std::string_view key) {
                return binding.id < key;
            });
        return found != bindings.end() && found->id == id
            ? static_cast<int>(found->index) : -1;
    }
    if (id.starts_with("param:")) id.remove_prefix(6);
    if (id.empty()) return -1;
    int index = -1;
    const auto parsed = std::from_chars(id.data(), id.data() + id.size(), index);
    return !id.empty() && parsed.ec == std::errc{}
        && parsed.ptr == id.data() + id.size() && index >= 0 ? index : -1;
}

} // namespace resostage
