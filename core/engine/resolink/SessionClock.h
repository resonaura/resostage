#pragma once

#include "resolink/ResoLinkProtocol.h"
#include "telemetry/SeqLock.h"
#include <atomic>
#include <cstdint>

namespace resostage {
namespace resolink {

enum class SessionRole : uint8_t {
    Standalone = 0,
    Leader = 1,
    Follower = 2,
};

enum class SessionLockState : uint8_t {
    Unlocked = 0,
    Acquiring = 1,
    Locked = 2,
    Holdover = 3,
};

struct SessionClockSnapshot {
    SessionRole role = SessionRole::Standalone;
    SessionLockState lockState = SessionLockState::Unlocked;
    uint16_t reserved = 0;
    uint32_t consecutiveLockedBeacons = 0;
    double driftPpm = 0.0;
    double rateMultiplier = 1.0;
    double phaseErrorSeconds = 0.0;
    double estimatedRttMs = 0.0;
    uint64_t lastBeaconTimeNs = 0;
};
static_assert(std::is_trivially_copyable_v<SessionClockSnapshot>, "SessionClockSnapshot must be trivially copyable");

struct SessionClockConfig {
    double maxDriftPpm = 100.0;                    // Maximum PLL frequency slew in PPM
    double lockToleranceSec = 0.001;               // 1 ms phase error threshold to declare Locked
    double snapThresholdSec = 0.050;               // 50 ms error threshold to snap sample position
    uint64_t beaconTimeoutNs = 500'000'000ull;     // 500 ms without beacon -> enter Holdover
    uint64_t holdoverTimeoutNs = 2'000'000'000ull; // 2.0 s without beacon -> enter Unlocked
    double kp = 0.08;                             // Proportional gain
    double ki = 0.008;                            // Integral gain
};

/**
 * SessionClock: High-precision Phase-Locked Loop (PLL) for multi-machine Core synchronization.
 *
 * Implements bounded rate slewing, PTP-grade clock offset estimation, and
 * seamless holdover mode without blocking locks in the real-time audio thread.
 */
class SessionClock {
public:
    explicit SessionClock(SessionClockConfig config = {}) noexcept;

    // Configuration & role
    void setRole(SessionRole newRole) noexcept;
    [[nodiscard]] SessionRole role() const noexcept;
    void setConfig(const SessionClockConfig& config) noexcept;
    [[nodiscard]] const SessionClockConfig& config() const noexcept;

    // Real-time queries (safe from audio thread - non-blocking & bounded SeqLock read)
    [[nodiscard]] SessionClockSnapshot snapshot() const noexcept;
    [[nodiscard]] double rateMultiplier() const noexcept;
    [[nodiscard]] SessionLockState lockState() const noexcept;
    [[nodiscard]] bool isLocked() const noexcept;

    // Beacon & Ping/Pong handlers (called from network/session worker thread)
    // Returns true if a sample snap is requested (e.g. seek / jump > snapThresholdSec)
    bool onBeaconReceived(
        const ResoLinkBeacon& beacon,
        uint64_t localMonotonicNs,
        int64_t currentLocalSamplePosition,
        double localSampleRate,
        int64_t& outSnapSamplePosition) noexcept;

    void onPongReceived(const ResoLinkPingPong& pong, uint64_t localMonotonicNs) noexcept;

    // Periodic tick to handle timeouts (called from timer/session thread)
    void update(uint64_t nowMonotonicNs) noexcept;

    // Reset PLL state to initial/unlocked
    void reset() noexcept;

private:
    void publishSnapshot() noexcept;

    SessionClockConfig config_;
    std::atomic<SessionRole> role_{SessionRole::Standalone};
    mutable SeqLock<SessionClockSnapshot> snapshotLock_;
    SessionClockSnapshot currentSnapshot_;

    // Internal PLL integration state
    double integralTerm_ = 0.0;
    double filteredRttNs_ = 1'000'000.0; // 1 ms initial RTT estimate
    int64_t clockOffsetNs_ = 0;          // Offset between leader and follower monotonic clocks
    uint64_t lastBeaconMonotonicNs_ = 0;
    uint32_t consecutiveLocked_ = 0;
    bool hasClockOffset_ = false;
};

} // namespace resolink
} // namespace resostage
