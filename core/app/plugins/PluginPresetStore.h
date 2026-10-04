/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <cstdint>
#include <cstddef>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace resostage {

struct PluginPresetInfo {
    std::string id;
    std::string name;
    std::string pluginIdentifier;
    uint64_t stateBytes = 0;
};

struct PluginPresetData {
    PluginPresetInfo info;
    std::vector<uint8_t> state;
};

/**
 * Bounded device-local store for opaque vendor plug-in state.
 *
 * Files are versioned, self-describing and scoped by the exact catalog
 * identifier. The file is written to a unique sibling and renamed into place;
 * a partial write is never listed as a preset. The store does not inspect or
 * deserialize vendor bytes.
 */
class PluginPresetStore final {
public:
    static constexpr uint64_t kMaximumStateBytes = 64ull * 1024ull * 1024ull;
    static constexpr size_t kMaximumPluginIdentifierBytes = 2048;
    static constexpr size_t kMaximumPresetNameBytes = 128;
    static constexpr size_t kMaximumListedPresets = 256;

    static bool list(const std::filesystem::path& root,
                     const std::string& pluginIdentifier,
                     std::vector<PluginPresetInfo>& presets,
                     std::string& error);

    static bool save(const std::filesystem::path& root,
                     const std::string& pluginIdentifier,
                     const std::string& name,
                     const std::vector<uint8_t>& state,
                     PluginPresetInfo& saved,
                     std::string& error);

    static bool load(const std::filesystem::path& root,
                     const std::string& pluginIdentifier,
                     const std::string& presetId,
                     PluginPresetData& preset,
                     std::string& error);

    static bool validPresetId(const std::string& presetId) noexcept;
    static std::filesystem::path userPresetRoot();
    static std::filesystem::path pluginDirectory(
        const std::filesystem::path& root,
        const std::string& pluginIdentifier);
    static std::string projectResourceForSlot(const std::string& stripId,
                                              const std::string& slotId,
                                              const std::string& presetId);
    static std::optional<std::string> presetIdForProjectResource(
        const std::string& stripId, const std::string& slotId,
        const std::string& resource);
};

} // namespace resostage
