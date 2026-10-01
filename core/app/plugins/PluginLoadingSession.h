/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <algorithm>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace resostage {

struct PluginLoadingSnapshot {
    uint64_t epoch = 0;
    uint64_t generation = 0;
    std::string phase = "idle";
    bool blocksPlayback = false;
    bool showDialog = false;
    bool playRequested = false;
    uint32_t total = 0;
    uint32_t completed = 0;
    uint32_t failed = 0;
    std::string currentName;
    std::string error;
};

/**
 * Worker/message-thread loading handoff, never read by the audio callback.
 * One latest-wins session has bounded scalar/string storage. Partial vendor
 * progress does not publish DSP or authorize transport. Only final bank
 * publication releases a fresh document; degradation requires user consent.
 */
class PluginLoadingSession final {
public:
    void replaceProject(uint64_t epoch) {
        std::lock_guard lock(mutex);
        state = {};
        state.epoch = epoch;
        state.phase = "loading";
        state.blocksPlayback = state.showDialog = true;
    }

    void begin(uint64_t epoch, uint64_t generation, uint32_t total) {
        std::lock_guard lock(mutex);
        if (state.epoch != epoch || generation < state.generation) return;
        state.generation = generation;
        state.phase = total == 0 ? "ready" : "loading";
        state.total = total;
        state.completed = state.failed = 0;
        state.currentName.clear();
        state.error.clear();
        if (total == 0) state.blocksPlayback = state.showDialog = false;
    }

    void progress(uint64_t epoch, uint64_t generation, uint32_t completed,
                  const std::string& currentName) {
        std::lock_guard lock(mutex);
        if (!matches(epoch, generation) || state.phase != "loading") return;
        state.completed = std::min(state.total, completed);
        state.currentName = currentName.substr(0, 256);
    }

    void finish(uint64_t epoch, uint64_t generation, uint32_t failed,
                const std::string& error = {}) {
        std::lock_guard lock(mutex);
        if (!matches(epoch, generation)) return;
        state.completed = state.total;
        state.failed = failed;
        state.error = error.substr(0, 2048);
        state.currentName.clear();
        state.phase = !error.empty() ? "failed" : failed > 0 ? "degraded" : "ready";
        if (state.phase == "ready") state.blocksPlayback = state.showDialog = false;
    }

    bool requestTransport(bool queuePlay) {
        std::lock_guard lock(mutex);
        if (!state.blocksPlayback) return true;
        state.showDialog = true;
        state.playRequested = queuePlay;
        return false;
    }

    void stop() {
        std::lock_guard lock(mutex);
        state.playRequested = false;
    }

    // The decision carries the displayed generation, so an old dialog cannot
    // unlock or dismiss a different project/load request.
    bool decide(uint64_t epoch, uint64_t generation, bool continueAvailable) {
        std::lock_guard lock(mutex);
        if (!matches(epoch, generation)) return false;
        if (continueAvailable) {
            if (state.phase == "loading") return false;
            state.blocksPlayback = false;
        } else {
            state.playRequested = false;
        }
        state.showDialog = false;
        return true;
    }

    bool takePlayIntent() {
        std::lock_guard lock(mutex);
        if (state.blocksPlayback || !state.playRequested) return false;
        state.playRequested = false;
        return true;
    }

    PluginLoadingSnapshot snapshot() const {
        std::lock_guard lock(mutex);
        return state;
    }

private:
    bool matches(uint64_t epoch, uint64_t generation) const noexcept {
        return state.epoch == epoch && state.generation == generation;
    }
    mutable std::mutex mutex;
    PluginLoadingSnapshot state;
};

} // namespace resostage
