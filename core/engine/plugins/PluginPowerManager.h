#pragma once

#include "audio/EnvelopeFollower.h"
#include "project/ProjectSchema.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace resostage {

/**
 * 4-tier power states specified in docs/architecture/PLUGIN_POWER_MANAGEMENT.md
 */
enum class PluginPowerState : uint8_t {
    Active = 0,    ///< Processing every block. Full DSP consumption.
    Quiescent = 1, ///< Input silent; output envelope monitored as tails ring out.
    Suspended = 2, ///< Tail decayed < -90 dBFS; processBlock is bypassed O(1).
    Parked = 3     ///< State serialized; plugin binary instance unloaded.
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

struct PluginPowerConfig {
    float silenceThresholdDb = -90.0f;
    double defaultTailSeconds = 5.0;
    double lookaheadBars = 2.0;
    double quiescenceBars = 8.0;
};

struct PluginPowerFlags {
    bool keepAwake = false;            ///< User explicitly pinned awake
    bool neverSuspend = false;         ///< Continuous noise generator / vinyl / tape hiss
    bool isInstrument = false;         ///< Instrument / synthesizer
    bool infiniteTail = false;         ///< Reports infinite reverb / delay tail
    bool trackRecordArmed = false;     ///< Strip is armed for recording
    bool trackInputMonitoring = false; ///< Strip is monitoring live input
};

/**
 * Tracks power state, tail decay, and real-time bypass status for a single plugin slot.
 * Real-time safe: zero heap allocations, zero blocking locks.
 */
class PluginSlotPowerTracker final {
public:
    PluginSlotPowerTracker() noexcept = default;

    void prepare(std::string slotIdIn, double sampleRateIn, double tailSecondsIn,
                 const PluginPowerFlags& flagsIn, float silenceThresholdDb = -90.0f) noexcept {
        slotId = std::move(slotIdIn);
        sampleRate = std::max(1.0, sampleRateIn);
        tailSeconds = (tailSecondsIn > 0.0 && std::isfinite(tailSecondsIn))
                          ? tailSecondsIn
                          : 5.0;
        flags = flagsIn;
        if (std::isinf(tailSecondsIn)) {
            flags.infiniteTail = true;
        }

        silenceThresholdLinear = std::pow(10.0f, silenceThresholdDb / 20.0f);
        tailSamplesThreshold = static_cast<int64_t>(tailSeconds * sampleRate);
        silentSamplesAccumulated = 0;

        follower.prepare(sampleRate, 5.0, 50.0, EnvelopeDetectorMode::Peak);

        if (flags.keepAwake || flags.neverSuspend || flags.infiniteTail
            || flags.trackRecordArmed || flags.trackInputMonitoring) {
            currentState.store(PluginPowerState::Active, std::memory_order_relaxed);
            processingNeeded.store(true, std::memory_order_relaxed);
        } else {
            currentState.store(PluginPowerState::Active, std::memory_order_relaxed);
            processingNeeded.store(true, std::memory_order_relaxed);
        }
    }

    /** Real-time O(1) branch test for processChain. */
    [[nodiscard]] bool isProcessingNeeded() const noexcept {
        return processingNeeded.load(std::memory_order_relaxed);
    }

    [[nodiscard]] PluginPowerState state() const noexcept {
        return currentState.load(std::memory_order_relaxed);
    }

    [[nodiscard]] const std::string& getSlotId() const noexcept {
        return slotId;
    }

    [[nodiscard]] const PluginPowerFlags& getFlags() const noexcept {
        return flags;
    }

    [[nodiscard]] double getTailSeconds() const noexcept {
        return tailSeconds;
    }

    /**
     * Real-time audio thread callback hook. Called after plugin process.
     * Evaluates output envelope follower and drives Active -> Quiescent -> Suspended transitions.
     */
    void processBlockRealtime(const float* outL, const float* outR, int numSamples,
                              bool hasInputOrEvents) noexcept {
        const auto st = currentState.load(std::memory_order_relaxed);
        if (st == PluginPowerState::Parked) {
            return;
        }

        if (hasInputOrEvents) {
            silentSamplesAccumulated = 0;
            if (st == PluginPowerState::Quiescent || st == PluginPowerState::Suspended) {
                currentState.store(PluginPowerState::Active, std::memory_order_relaxed);
            }
            processingNeeded.store(true, std::memory_order_relaxed);
            return;
        }

        if (st == PluginPowerState::Suspended) {
            // Already suspended: O(1) no-op
            return;
        }

        // No input or MIDI events
        if (st == PluginPowerState::Active) {
            // Begin monitoring decay in Quiescent state
            currentState.store(PluginPowerState::Quiescent, std::memory_order_relaxed);
            silentSamplesAccumulated = 0;
        }

        // Quiescent state: monitor output tail decay
        follower.processStereo(outL, outR, nullptr, numSamples);
        const float peak = follower.getCurrentValue();

        if (peak < silenceThresholdLinear) {
            silentSamplesAccumulated += numSamples;

            // Check guard rails before allowing suspension
            const bool guarded = flags.keepAwake || flags.neverSuspend
                                 || flags.infiniteTail || flags.trackRecordArmed
                                 || flags.trackInputMonitoring;

            if (!guarded && silentSamplesAccumulated >= tailSamplesThreshold) {
                // Transition Quiescent -> Suspended
                currentState.store(PluginPowerState::Suspended, std::memory_order_relaxed);
                processingNeeded.store(false, std::memory_order_relaxed);
            }
        } else {
            // Output still ringing above -90 dBFS; reset silent accumulator
            silentSamplesAccumulated = 0;
        }
    }

    /** Pre-warm or awaken plugin to Active state (< 0.05 ms, zero lock). */
    void forceAwake() noexcept {
        silentSamplesAccumulated = 0;
        currentState.store(PluginPowerState::Active, std::memory_order_release);
        processingNeeded.store(true, std::memory_order_release);
    }

    /** Suspend immediately if guard rails permit. */
    void forceSuspend() noexcept {
        const bool guarded = flags.keepAwake || flags.neverSuspend
                             || flags.infiniteTail || flags.trackRecordArmed
                             || flags.trackInputMonitoring;
        if (!guarded) {
            currentState.store(PluginPowerState::Suspended, std::memory_order_release);
            processingNeeded.store(false, std::memory_order_release);
        }
    }

    void park() noexcept {
        currentState.store(PluginPowerState::Parked, std::memory_order_release);
        processingNeeded.store(false, std::memory_order_release);
    }

    void unpark() noexcept {
        silentSamplesAccumulated = 0;
        currentState.store(PluginPowerState::Active, std::memory_order_release);
        processingNeeded.store(true, std::memory_order_release);
    }

    void setKeepAwake(bool keepAwakeIn) noexcept {
        flags.keepAwake = keepAwakeIn;
        if (flags.keepAwake) {
            forceAwake();
        }
    }

    void setRecordArmed(bool armed) noexcept {
        flags.trackRecordArmed = armed;
        if (armed) {
            forceAwake();
        }
    }

    void setInputMonitoring(bool mon) noexcept {
        flags.trackInputMonitoring = mon;
        if (mon) {
            forceAwake();
        }
    }

private:
    std::string slotId;
    double sampleRate = 48000.0;
    double tailSeconds = 5.0;
    float silenceThresholdLinear = 3.16227766e-5f; // -90 dBFS
    int64_t tailSamplesThreshold = 240000;
    int64_t silentSamplesAccumulated = 0;

    EnvelopeFollower follower;
    PluginPowerFlags flags;

    std::atomic<PluginPowerState> currentState{PluginPowerState::Active};
    std::atomic<bool> processingNeeded{true};
};

struct PluginPowerStats {
    size_t totalSlots = 0;
    size_t activeCount = 0;
    size_t quiescentCount = 0;
    size_t suspendedCount = 0;
    size_t parkedCount = 0;
    float estimatedDspSavingsPercent = 0.0f;
};

/**
 * Coordinates power management, arrangement lookahead scanning, and statistics across strips.
 */
class PluginPowerManager final {
public:
    PluginPowerManager() = default;

    void setConfig(const PluginPowerConfig& configIn) noexcept {
        config = configIn;
    }

    [[nodiscard]] const PluginPowerConfig& getConfig() const noexcept {
        return config;
    }

    /** Register or retrieve power tracker for a slot ID. */
    std::shared_ptr<PluginSlotPowerTracker> getOrCreateTracker(const std::string& slotId) {
        auto it = trackers.find(slotId);
        if (it != trackers.end()) {
            return it->second;
        }
        auto tracker = std::make_shared<PluginSlotPowerTracker>();
        trackers[slotId] = tracker;
        return tracker;
    }

    std::shared_ptr<PluginSlotPowerTracker> findTracker(const std::string& slotId) const noexcept {
        auto it = trackers.find(slotId);
        return it != trackers.end() ? it->second : nullptr;
    }

    /** Clear all tracked slots (e.g. on project close or bank rebuild). */
    void clear() {
        trackers.clear();
    }

    /**
     * Arrangement Lookahead Scanner:
     * Scans incoming audio regions, MIDI notes, and automation points in [currentBeat, currentBeat + lookaheadBars * beatsPerBar].
     * Pre-warms (forceAwake()) any quiescent/suspended plugins on upcoming active tracks.
     */
    void lookaheadScan(const Project& project, size_t activeSongIndex,
                       double currentBeat, double beatsPerBar) noexcept;

    /** Aggregate power telemetry metrics. */
    [[nodiscard]] PluginPowerStats getStats() const noexcept {
        PluginPowerStats s;
        s.totalSlots = trackers.size();
        for (const auto& [_, tracker] : trackers) {
            if (tracker == nullptr) continue;
            switch (tracker->state()) {
                case PluginPowerState::Active: ++s.activeCount; break;
                case PluginPowerState::Quiescent: ++s.quiescentCount; break;
                case PluginPowerState::Suspended: ++s.suspendedCount; break;
                case PluginPowerState::Parked: ++s.parkedCount; break;
            }
        }
        if (s.totalSlots > 0) {
            const size_t saved = s.suspendedCount + s.parkedCount;
            s.estimatedDspSavingsPercent =
                (static_cast<float>(saved) / static_cast<float>(s.totalSlots)) * 100.0f;
        }
        return s;
    }

private:
    PluginPowerConfig config;
    std::unordered_map<std::string, std::shared_ptr<PluginSlotPowerTracker>> trackers;
};

} // namespace resostage
