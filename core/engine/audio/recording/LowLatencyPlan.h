#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_set>
#include <vector>

namespace resostage {

struct LowLatencySlotBypass {
    uint32_t stripIndex = 0;
    uint32_t slotIndex = 0;
    std::string pluginId;
    int64_t latencySamples = 0;
};

struct LowLatencySendOverride {
    uint32_t sourceStripIndex = 0;
    uint32_t sendIndex = 0;
    bool muted = true;
};

/**
 * Immutable low-latency monitoring plan.
 * Published alongside MixGraph and PluginDelayBank snapshots.
 */
struct LowLatencyPlan {
    bool enabled = false;
    double limitMs = 5.0;
    int64_t limitSamples = 240; // 5ms @ 48kHz

    std::vector<LowLatencySlotBypass> bypassedSlots;
    std::vector<LowLatencySendOverride> sendOverrides;

    [[nodiscard]] bool isSlotBypassed(uint32_t stripIndex, uint32_t slotIndex) const noexcept {
        if (!enabled) return false;
        for (const auto& b : bypassedSlots) {
            if (b.stripIndex == stripIndex && b.slotIndex == slotIndex)
                return true;
        }
        return false;
    }

    [[nodiscard]] bool isSendMuted(uint32_t sourceStripIndex, uint32_t sendIndex) const noexcept {
        if (!enabled) return false;
        for (const auto& s : sendOverrides) {
            if (s.sourceStripIndex == sourceStripIndex && s.sendIndex == sendIndex)
                return s.muted;
        }
        return false;
    }
};

struct PluginSlotLatencyInfo {
    uint32_t stripIndex = 0;
    uint32_t slotIndex = 0;
    std::string pluginId;
    int64_t latencySamples = 0;
};

struct StripSendInfo {
    uint32_t sourceStripIndex = 0;
    uint32_t sendIndex = 0;
    bool lowLatencySafe = false;
};

inline LowLatencyPlan buildLowLatencyPlan(
    bool enabled,
    double limitMs,
    double sampleRate,
    const std::unordered_set<uint32_t>& activeMonitoredStrips,
    const std::vector<PluginSlotLatencyInfo>& slotLatencies,
    const std::vector<StripSendInfo>& sends)
{
    LowLatencyPlan plan;
    plan.enabled = enabled;
    plan.limitMs = limitMs;
    plan.limitSamples = static_cast<int64_t>(std::llround((limitMs / 1000.0) * sampleRate));

    if (!enabled || activeMonitoredStrips.empty())
        return plan;

    for (const auto& slot : slotLatencies) {
        if (activeMonitoredStrips.contains(slot.stripIndex)) {
            if (slot.latencySamples > plan.limitSamples) {
                plan.bypassedSlots.push_back({
                    slot.stripIndex,
                    slot.slotIndex,
                    slot.pluginId,
                    slot.latencySamples
                });
            }
        }
    }

    for (const auto& send : sends) {
        if (activeMonitoredStrips.contains(send.sourceStripIndex)) {
            if (!send.lowLatencySafe) {
                plan.sendOverrides.push_back({
                    send.sourceStripIndex,
                    send.sendIndex,
                    true
                });
            }
        }
    }

    return plan;
}

} // namespace resostage
