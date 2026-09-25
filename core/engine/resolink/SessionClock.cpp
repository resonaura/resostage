#include "resolink/SessionClock.h"

#include <algorithm>
#include <cmath>

namespace resostage {
namespace resolink {

SessionClock::SessionClock(SessionClockConfig config) noexcept
    : config_(config) {
    currentSnapshot_.role = SessionRole::Standalone;
    currentSnapshot_.lockState = SessionLockState::Unlocked;
    currentSnapshot_.rateMultiplier = 1.0;
    publishSnapshot();
}

void SessionClock::setRole(SessionRole newRole) noexcept {
    role_.store(newRole, std::memory_order_release);
    currentSnapshot_.role = newRole;
    if (newRole == SessionRole::Standalone || newRole == SessionRole::Follower) {
        currentSnapshot_.lockState = SessionLockState::Unlocked;
        currentSnapshot_.driftPpm = 0.0;
        currentSnapshot_.rateMultiplier = 1.0;
        currentSnapshot_.phaseErrorSeconds = 0.0;
        integralTerm_ = 0.0;
        consecutiveLocked_ = 0;
        currentSnapshot_.consecutiveLockedBeacons = 0;
    } else if (newRole == SessionRole::Leader) {
        currentSnapshot_.lockState = SessionLockState::Locked;
        currentSnapshot_.driftPpm = 0.0;
        currentSnapshot_.rateMultiplier = 1.0;
        currentSnapshot_.phaseErrorSeconds = 0.0;
        integralTerm_ = 0.0;
        consecutiveLocked_ = 0;
        currentSnapshot_.consecutiveLockedBeacons = 0;
    }
    publishSnapshot();
}

SessionRole SessionClock::role() const noexcept {
    return role_.load(std::memory_order_relaxed);
}

void SessionClock::setConfig(const SessionClockConfig& config) noexcept {
    config_ = config;
    if (config_.maxDriftPpm < 1.0) config_.maxDriftPpm = 1.0;
    if (config_.lockToleranceSec <= 0.0) config_.lockToleranceSec = 0.001;
    if (config_.snapThresholdSec <= 0.0) config_.snapThresholdSec = 0.050;
}

const SessionClockConfig& SessionClock::config() const noexcept {
    return config_;
}

SessionClockSnapshot SessionClock::snapshot() const noexcept {
    SessionClockSnapshot result;
    if (snapshotLock_.read(result)) {
        return result;
    }
    // Reader contention fallback: return safe defaults or current copy
    result.role = role_.load(std::memory_order_relaxed);
    result.lockState = (result.role == SessionRole::Leader) ? SessionLockState::Locked : SessionLockState::Unlocked;
    result.rateMultiplier = 1.0;
    return result;
}

double SessionClock::rateMultiplier() const noexcept {
    return snapshot().rateMultiplier;
}

SessionLockState SessionClock::lockState() const noexcept {
    return snapshot().lockState;
}

bool SessionClock::isLocked() const noexcept {
    return snapshot().lockState == SessionLockState::Locked;
}

void SessionClock::publishSnapshot() noexcept {
    snapshotLock_.write(currentSnapshot_);
}

bool SessionClock::onBeaconReceived(
    const ResoLinkBeacon& beacon,
    uint64_t localMonotonicNs,
    int64_t currentLocalSamplePosition,
    double localSampleRate,
    int64_t& outSnapSamplePosition) noexcept {
    if (role_.load(std::memory_order_relaxed) != SessionRole::Follower) {
        return false;
    }

    lastBeaconMonotonicNs_ = localMonotonicNs;
    currentSnapshot_.lastBeaconTimeNs = localMonotonicNs;

    if (!std::isfinite(localSampleRate) || localSampleRate <= 0.0) {
        localSampleRate = 48000.0;
    }

    // Estimate leader monotonic timestamp mapped to local timeline
    // If no Ping/Pong offset measured yet, seed directly from first beacon
    if (!hasClockOffset_) {
        clockOffsetNs_ = static_cast<int64_t>(beacon.leaderMonotonicNs) -
                         static_cast<int64_t>(localMonotonicNs);
        hasClockOffset_ = true;
    }

    // Extrapolate leader's current position to localMonotonicNs
    const int64_t localProjectedLeaderNs = static_cast<int64_t>(localMonotonicNs) + clockOffsetNs_;
    const double elapsedSec = (static_cast<double>(localProjectedLeaderNs) -
                               static_cast<double>(beacon.leaderMonotonicNs)) * 1.0e-9;
    const double expectedLeaderSamples = static_cast<double>(beacon.samplePosition) +
                                         (elapsedSec * beacon.sampleRate);

    // Compute phase error in seconds
    const double errorSamples = expectedLeaderSamples - static_cast<double>(currentLocalSamplePosition);
    const double phaseErrorSec = errorSamples / localSampleRate;
    currentSnapshot_.phaseErrorSeconds = phaseErrorSec;

    // Hard snap check (e.g. seek or transport jump by leader)
    if (std::abs(phaseErrorSec) > config_.snapThresholdSec ||
        (beacon.flags & BeaconFlag::Seeking)) {
        outSnapSamplePosition = static_cast<int64_t>(std::llround(expectedLeaderSamples));
        integralTerm_ = 0.0;
        consecutiveLocked_ = 0;
        currentSnapshot_.lockState = SessionLockState::Acquiring;
        currentSnapshot_.driftPpm = 0.0;
        currentSnapshot_.rateMultiplier = 1.0;
        currentSnapshot_.consecutiveLockedBeacons = 0;
        publishSnapshot();
        return true;
    }

    // PI phase-locked loop filter
    const double pTerm = config_.kp * phaseErrorSec;
    integralTerm_ += config_.ki * phaseErrorSec;

    const double maxDriftSecPerSec = config_.maxDriftPpm * 1.0e-6;
    integralTerm_ = std::clamp(integralTerm_, -maxDriftSecPerSec, maxDriftSecPerSec);

    const double deltaRate = std::clamp(pTerm + integralTerm_, -maxDriftSecPerSec, maxDriftSecPerSec);
    currentSnapshot_.driftPpm = deltaRate * 1.0e6;
    currentSnapshot_.rateMultiplier = 1.0 + deltaRate;

    // Lock condition detection
    if (std::abs(phaseErrorSec) <= config_.lockToleranceSec) {
        consecutiveLocked_++;
        if (consecutiveLocked_ >= 3) {
            currentSnapshot_.lockState = SessionLockState::Locked;
        } else {
            currentSnapshot_.lockState = SessionLockState::Acquiring;
        }
    } else {
        consecutiveLocked_ = 0;
        currentSnapshot_.lockState = SessionLockState::Acquiring;
    }

    currentSnapshot_.consecutiveLockedBeacons = consecutiveLocked_;
    publishSnapshot();
    return false;
}

void SessionClock::onPongReceived(const ResoLinkPingPong& pong, uint64_t localMonotonicNs) noexcept {
    if (localMonotonicNs <= pong.t1_sendNs || pong.t3_replyNs < pong.t2_recvNs) {
        return;
    }

    const uint64_t rawRttNs = (localMonotonicNs - pong.t1_sendNs) - (pong.t3_replyNs - pong.t2_recvNs);
    filteredRttNs_ = 0.85 * filteredRttNs_ + 0.15 * static_cast<double>(rawRttNs);
    currentSnapshot_.estimatedRttMs = filteredRttNs_ * 1.0e-6;

    // NTP / IEEE 1588 PTP clock offset calculation
    // offset = ((t2 - t1) + (t3 - t4)) / 2
    const int64_t d1 = static_cast<int64_t>(pong.t2_recvNs) - static_cast<int64_t>(pong.t1_sendNs);
    const int64_t d2 = static_cast<int64_t>(pong.t3_replyNs) - static_cast<int64_t>(localMonotonicNs);
    const int64_t measuredOffset = (d1 + d2) / 2;

    if (!hasClockOffset_) {
        clockOffsetNs_ = measuredOffset;
        hasClockOffset_ = true;
    } else {
        clockOffsetNs_ = static_cast<int64_t>(0.90 * static_cast<double>(clockOffsetNs_) +
                                              0.10 * static_cast<double>(measuredOffset));
    }

    publishSnapshot();
}

void SessionClock::update(uint64_t nowMonotonicNs) noexcept {
    const SessionRole currentRole = role_.load(std::memory_order_relaxed);
    if (currentRole != SessionRole::Follower) {
        return;
    }

    if (lastBeaconMonotonicNs_ == 0 || nowMonotonicNs < lastBeaconMonotonicNs_) {
        return;
    }

    const uint64_t elapsedNs = nowMonotonicNs - lastBeaconMonotonicNs_;
    if (elapsedNs > config_.holdoverTimeoutNs) {
        // Holdover expired -> Unlocked
        if (currentSnapshot_.lockState != SessionLockState::Unlocked) {
            currentSnapshot_.lockState = SessionLockState::Unlocked;
            currentSnapshot_.driftPpm = 0.0;
            currentSnapshot_.rateMultiplier = 1.0;
            consecutiveLocked_ = 0;
            currentSnapshot_.consecutiveLockedBeacons = 0;
            publishSnapshot();
        }
    } else if (elapsedNs > config_.beaconTimeoutNs) {
        // Missed beacons -> Holdover mode
        if (currentSnapshot_.lockState == SessionLockState::Locked ||
            currentSnapshot_.lockState == SessionLockState::Acquiring) {
            currentSnapshot_.lockState = SessionLockState::Holdover;
            consecutiveLocked_ = 0;
            currentSnapshot_.consecutiveLockedBeacons = 0;
            publishSnapshot();
        }
    }
}

void SessionClock::reset() noexcept {
    integralTerm_ = 0.0;
    filteredRttNs_ = 1'000'000.0;
    clockOffsetNs_ = 0;
    lastBeaconMonotonicNs_ = 0;
    consecutiveLocked_ = 0;
    hasClockOffset_ = false;

    currentSnapshot_.lockState = SessionLockState::Unlocked;
    currentSnapshot_.driftPpm = 0.0;
    currentSnapshot_.rateMultiplier = 1.0;
    currentSnapshot_.phaseErrorSeconds = 0.0;
    currentSnapshot_.estimatedRttMs = 0.0;
    currentSnapshot_.consecutiveLockedBeacons = 0;
    publishSnapshot();
}

} // namespace resolink
} // namespace resostage
