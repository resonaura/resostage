/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "audio/dsp/EnvelopeFollower.h"
#include "plugins/PluginPowerControl.h"
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
 * After prepare(), the DSP thread alone writes the follower, silence counter,
 * and published state. Controls from any thread only update atomic intents or
 * guards. Instances must not be prepared again while processing is possible.
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
        if (std::isinf(tailSecondsIn) || tailSecondsIn >= 3600.0) {
            flags.infiniteTail = true;
        }

        silenceThresholdLinear = std::pow(10.0f, silenceThresholdDb / 20.0f);
        tailSamplesThreshold = static_cast<int64_t>(tailSeconds * sampleRate);
        silentSamplesAccumulated = 0;
        mutableGuards.store((flags.keepAwake ? kKeepAwake : 0u)
                                | (flags.trackRecordArmed ? kRecordArmed : 0u)
                                | (flags.trackInputMonitoring ? kInputMonitoring : 0u),
                            std::memory_order_relaxed);
        pendingIntent.store(Intent::None, std::memory_order_relaxed);
        explicitlyParked.store(false, std::memory_order_relaxed);

        follower.prepare(sampleRate, 5.0, 50.0, EnvelopeDetectorMode::Peak);
        currentState.store(PluginPowerState::Active, std::memory_order_relaxed);
    }

    /** Real-time O(1) branch test for processChain. */
    [[nodiscard]] bool isProcessingNeeded() const noexcept {
        const auto powerState = state();
        return powerState != PluginPowerState::Suspended
            && powerState != PluginPowerState::Parked;
    }

    [[nodiscard]] PluginPowerState state() const noexcept {
        if (explicitlyParked.load(std::memory_order_acquire))
            return PluginPowerState::Parked;
        const auto intent = pendingIntent.load(std::memory_order_acquire);
        if (intent == Intent::Wake)
            return PluginPowerState::Active;
        if (intent == Intent::Suspend && !guarded())
            return PluginPowerState::Suspended;
        const auto published = currentState.load(std::memory_order_relaxed);
        if (published == PluginPowerState::Parked
            || (published == PluginPowerState::Suspended && guarded()))
            return PluginPowerState::Active;
        return published;
    }

    [[nodiscard]] const std::string& getSlotId() const noexcept {
        return slotId;
    }

    /** Thread-safe value snapshot; never returns a reference to mutable flags. */
    [[nodiscard]] PluginPowerFlags getFlags() const noexcept {
        auto snapshot = flags;
        const auto guards = mutableGuards.load(std::memory_order_acquire);
        snapshot.keepAwake = (guards & kKeepAwake) != 0;
        snapshot.trackRecordArmed = (guards & kRecordArmed) != 0;
        snapshot.trackInputMonitoring = (guards & kInputMonitoring) != 0;
        return snapshot;
    }

    [[nodiscard]] double getTailSeconds() const noexcept {
        return tailSeconds;
    }

    /** DSP thread only, including suspended blocks before the bypass decision. */
    void beginBlockRealtime() noexcept {
        // Avoid a cache-line RMW on every silent/active block when no producer
        // published a request. A request racing this load remains for the next
        // block, and state()/isProcessingNeeded() already observe its intent.
        const auto intent = pendingIntent.load(std::memory_order_relaxed) == Intent::None
            ? Intent::None : pendingIntent.exchange(Intent::None, std::memory_order_acq_rel);
        if (explicitlyParked.load(std::memory_order_acquire)) {
            currentState.store(PluginPowerState::Parked, std::memory_order_relaxed);
            silentSamplesAccumulated = 0;
        } else if (intent == Intent::Wake
                   || currentState.load(std::memory_order_relaxed) == PluginPowerState::Parked
                   || (guarded() && currentState.load(std::memory_order_relaxed)
                       == PluginPowerState::Suspended)) {
            silentSamplesAccumulated = 0;
            currentState.store(PluginPowerState::Active, std::memory_order_relaxed);
        } else if (intent == Intent::Suspend && !guarded()) {
            currentState.store(PluginPowerState::Suspended, std::memory_order_relaxed);
        }
    }

    /**
     * Real-time audio thread callback hook. Called after plugin process.
     * Evaluates output envelope follower and drives Active -> Quiescent -> Suspended transitions.
     */
    void processBlockRealtime(const float* outL, const float* outR, int numSamples,
                              bool hasInputOrEvents) noexcept {
        if (numSamples <= 0) return;
        beginBlockRealtime();
        const auto st = currentState.load(std::memory_order_relaxed);
        if (st == PluginPowerState::Parked) {
            return;
        }

        if (hasInputOrEvents) {
            silentSamplesAccumulated = 0;
            if (st == PluginPowerState::Quiescent || st == PluginPowerState::Suspended) {
                currentState.store(PluginPowerState::Active, std::memory_order_relaxed);
            }
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

        if (guarded()) {
            // No decay decision is possible while pinned/armed/monitored or
            // infinitely ringing. Avoid a per-sample detector on these quiet
            // blocks. Start a complete new quiet hold when the guard leaves,
            // so omitted envelope history cannot cause premature suspension.
            silentSamplesAccumulated = 0;
            follower.reset();
            return;
        }

        // Quiescent state: monitor output tail decay
        follower.processStereo(outL, outR, nullptr, numSamples);
        const float peak = follower.getCurrentValue();

        if (peak < silenceThresholdLinear) {
            silentSamplesAccumulated += numSamples;

            // Check guard rails before allowing suspension
            if (!guarded() && silentSamplesAccumulated >= tailSamplesThreshold) {
                // Transition Quiescent -> Suspended
                currentState.store(PluginPowerState::Suspended, std::memory_order_relaxed);
            }
        } else {
            // Output still ringing above -90 dBFS; reset silent accumulator
            silentSamplesAccumulated = 0;
        }
    }

    /** Any thread: coalesced wake intent; explicit parking requires unpark(). */
    void forceAwake() noexcept {
        pendingIntent.store(Intent::Wake, std::memory_order_release);
    }

    /** Suspend immediately if guard rails permit. */
    void forceSuspend() noexcept {
        if (!guarded())
            pendingIntent.store(Intent::Suspend, std::memory_order_release);
    }

    void park() noexcept {
        explicitlyParked.store(true, std::memory_order_release);
    }

    void unpark() noexcept {
        explicitlyParked.store(false, std::memory_order_release);
        forceAwake();
    }

    void setKeepAwake(bool keepAwakeIn) noexcept {
        setGuard(kKeepAwake, keepAwakeIn);
    }

    void setRecordArmed(bool armed) noexcept {
        setGuard(kRecordArmed, armed);
    }

    void setInputMonitoring(bool mon) noexcept {
        setGuard(kInputMonitoring, mon);
    }

private:
    enum class Intent : uint8_t { None, Wake, Suspend };
    static constexpr uint8_t kKeepAwake = 1u;
    static constexpr uint8_t kRecordArmed = 2u;
    static constexpr uint8_t kInputMonitoring = 4u;

    [[nodiscard]] bool guarded() const noexcept {
        return mutableGuards.load(std::memory_order_acquire) != 0
            || flags.neverSuspend || flags.infiniteTail;
    }

    void setGuard(uint8_t bit, bool enabled) noexcept {
        if (enabled) {
            mutableGuards.fetch_or(bit, std::memory_order_release);
            forceAwake();
        } else {
            mutableGuards.fetch_and(static_cast<uint8_t>(~bit), std::memory_order_release);
        }
    }

    std::string slotId;
    double sampleRate = 48000.0;
    double tailSeconds = 5.0;
    float silenceThresholdLinear = 3.16227766e-5f; // -90 dBFS
    int64_t tailSamplesThreshold = 240000;
    int64_t silentSamplesAccumulated = 0;

    EnvelopeFollower follower;
    PluginPowerFlags flags;

    std::atomic<PluginPowerState> currentState{PluginPowerState::Active};
    std::atomic<Intent> pendingIntent{Intent::None};
    std::atomic<uint8_t> mutableGuards{0};
    std::atomic<bool> explicitlyParked{false};
};

struct PluginPowerStats {
    size_t totalSlots = 0;
    size_t activeCount = 0;
    size_t quiescentCount = 0;
    size_t suspendedCount = 0;
    size_t parkedCount = 0;
    float estimatedDSPSavingsPercent = 0.0f;
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
            s.estimatedDSPSavingsPercent =
                (static_cast<float>(saved) / static_cast<float>(s.totalSlots)) * 100.0f;
            s.estimatedDspSavingsPercent = s.estimatedDSPSavingsPercent;
        }
        return s;
    }

private:
    PluginPowerConfig config;
    std::unordered_map<std::string, std::shared_ptr<PluginSlotPowerTracker>> trackers;
};

} // namespace resostage
