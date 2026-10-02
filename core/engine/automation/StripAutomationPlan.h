/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "project/ProjectSchema.h"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace resostage {

struct MixGraph;
class MixRenderer;

/**
 * Immutable, pre-bound track-scope envelopes for a mix publication.
 *
 * Preparation copies project points and resolves strip and edge IDs off audio.
 * The MixGraph owns this plan and retires it through the graph's existing
 * lifetime mechanism; a callback never becomes the last owner of these point
 * vectors. Evaluation takes the actual segment beat, not an accumulated phase,
 * so seeks, tempo changes and exact cycle splits all select the same envelope.
 * Empty/muted/disabled lanes do not override manual mixer coefficients.
 * Region scopes and plug-in vendor parameters remain outside this contract.
 */
class StripAutomationPlan {
public:
    static constexpr size_t kMaximumSongs = 4096;
    static constexpr size_t kMaximumLanes = 65536;
    static constexpr size_t kMaximumPoints = 1048576;

    // Message/offline worker thread only. A malformed or over-budget plan
    // returns null with an explanation; allocation failure may propagate to
    // the caller's existing non-realtime preparation failure handling.
    [[nodiscard]] static std::shared_ptr<const StripAutomationPlan> prepare(
        const Project& project, const MixGraph& graph, std::string& error);

    // Audio/offline DSP owner only, after renderer.beginBlock(). Bounded by
    // the admitted plan, with no strings, allocation or mutable project access.
    void apply(size_t songIndex, double segmentBeat, MixRenderer& renderer) const noexcept;

    [[nodiscard]] size_t bindingCount(size_t songIndex) const noexcept;

private:
    enum class Parameter : uint8_t { GainDb, Pan, Mute, SendGain };
    struct Binding {
        uint32_t stripIndex = 0;
        uint32_t edgeIndex = 0;
        Parameter parameter = Parameter::GainDb;
        float minValue = 0.0f;
        float maxValue = 1.0f;
        std::vector<AutomationPoint> points;
    };
    struct SongBindings {
        std::vector<Binding> lanes;
    };
    std::vector<SongBindings> songs;
};

} // namespace resostage
