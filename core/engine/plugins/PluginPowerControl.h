/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <cstdint>
#include <string_view>

namespace resostage {

/** Runtime DSP state. Parking skips processing; it does not unload the instance. */
enum class PluginPowerState : uint8_t {
    Active = 0,
    Quiescent = 1,
    Suspended = 2,
    Parked = 3,
};

inline const char* pluginPowerStateToString(PluginPowerState state) noexcept {
    switch (state) {
        case PluginPowerState::Active: return "active";
        case PluginPowerState::Quiescent: return "quiescent";
        case PluginPowerState::Suspended: return "suspended";
        case PluginPowerState::Parked: return "parked";
    }
    return "active";
}

inline PluginPowerState pluginPowerStateFromString(std::string_view str) noexcept {
    if (str == "quiescent") return PluginPowerState::Quiescent;
    if (str == "suspended") return PluginPowerState::Suspended;
    if (str == "parked") return PluginPowerState::Parked;
    return PluginPowerState::Active;
}

/** Coalesced DSP enable/power controls; paired choices are latest-wins. */
enum class PluginPowerControl : uint32_t {
    Wake = 1u,
    Park = 2u,
    Unpark = 4u,
    KeepAwakeEnable = 8u,
    KeepAwakeDisable = 16u,
    BypassEnable = 32u,
    BypassDisable = 64u,
};

constexpr uint32_t pluginPowerControlMask(PluginPowerControl control) noexcept {
    return static_cast<uint32_t>(control);
}

constexpr bool hasPluginPowerControl(uint32_t mask, PluginPowerControl control) noexcept {
    return (mask & pluginPowerControlMask(control)) != 0;
}

} // namespace resostage
