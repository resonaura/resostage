#pragma once

#include "lighting/LightCueInterpolation.h"
#include "lighting/LightOutputResolver.h"
#include "lighting/ResoLightChannelMap.h"
#include "project/ProjectSchema.h"
#include "events/EventDispatcher.h"
#include "timing/MasterClock.h"

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>

namespace resostage {

// Forward declarations — LightEngine only holds pointers, never owns these.
class MasterClock;
class EventDispatcher;

// LightEngine — dedicated high-priority thread that drives continuous DMX
// output from the light cue timeline.
//
// Priority model:
//   Audio callback (SCHED_RR ~96)   — MasterClock::onAudioCallback()
//   LightEngine   (SCHED_RR  ~45)   — this class
//   UI / HTTP     (<20)              — JUCE message thread, EventDispatcher worker
//
// The engine reads MasterClock::currentSeconds() / currentSongIndex() every
// frame (wall-clock derived, lockfree), resolves the active LightCue for
// every track, applies audio-reactive effects, assembles a 512-byte DMX
// universe frame per universe, and enqueues it to EventDispatcher for UDP
// dispatch.
//
// Project data is handed in via setProject() as a shared_ptr<const Project>.
// The message thread calls this whenever the project changes; the engine
// atomically swaps the pointer, so there is never a lock on either thread.
//
// Thread-safety:
//   start() / stop()         — call from any thread; internally serialised.
//   setProject()             — safe to call from any thread while running.
//   All other members        — internal; do not call from outside.
class LightEngine {
public:
    // clockSource, dispatcher: not owned; caller must keep them alive for
    // LightEngine's lifetime. Pass nullptr for either meter callback to
    // disable Meter-effect cues sourced from that pool (audio level reads
    // as silence instead).
    LightEngine() = default;
    ~LightEngine() { stop(); }

    LightEngine(const LightEngine&) = delete;
    LightEngine& operator=(const LightEngine&) = delete;

    // Bind dependencies and start the output thread. Callbacks are captured
    // by the thread; they must remain valid until stop() returns.
    using BusMeterFn = std::function<SourceLevels(const std::string& busId)>;
    using TrackMeterFn = std::function<SourceLevels(const std::string& trackId)>;
    void start(MasterClock& clock,
               EventDispatcher& dispatcher,
               BusMeterFn busPeakDb,
               TrackMeterFn trackPeakDb,
               double targetBpm = 120.0);
    void stop();

    bool isRunning() const { return running_.load(std::memory_order_acquire); }

    // Atomically replace the project snapshot. Safe to call from any thread.
    void setProject(std::shared_ptr<const Project> proj);

    // Update current BPM (for tempo-synced effects). Called from transport.
    void setBpm(double bpm) { bpm_.store(bpm, std::memory_order_relaxed); }

private:
    void threadLoop();

    std::thread thread_;
    std::atomic<bool> running_{false};

    // Project snapshot: written from the message thread (setProject),
    // read from the LightEngine thread (threadLoop). Protected by a mutex
    // held only for the pointer swap — never during the DMX output loop.
    // macOS libc++ does not implement std::atomic<shared_ptr<T>> (C++20
    // partial specialisation), so we use an explicit mutex instead.
    mutable std::mutex snapshotMutex_;
    std::shared_ptr<const Project> snapshot_;

    MasterClock*  clock_      = nullptr;
    EventDispatcher* dispatch_ = nullptr;
    BusMeterFn busPeakDb_;
    TrackMeterFn trackPeakDb_;

    std::atomic<double> bpm_{120.0};

    // Internal compute/tick rate -- an upper bound, not necessarily what any
    // given universe actually sends at. Real per-universe send cadence is
    // throttled separately (see threadLoop) by LightingConfig::
    // defaultRefreshRateHz / LightFixture::refreshRateHz, which default to
    // 44 Hz (comfortably above the Art-Net spec minimum of 40 Hz) but can be
    // configured up to this tick rate. Ticking faster than the default send
    // rate just means resolves happen more often than they're sent -- cheap,
    // and gives per-fixture rates headroom above the default without ever
    // silently capping a configured rate at a slower tick.
    static constexpr int kFrameRateHz = 60;
};

} // namespace resostage
