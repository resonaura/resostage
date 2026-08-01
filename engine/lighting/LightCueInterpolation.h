#pragma once

#include "project/ProjectSchema.h"

#include <algorithm>
#include <cstdint>
#include <vector>

namespace resostage {

struct LightCueValue {
    uint8_t r = 0;
    uint8_t g = 0;
    uint8_t b = 0;
    double intensity = 0.0; // 0..1
};

// Resolves the color+intensity a single Light track should show at
// `timeSeconds`, given every LightCue placed on it (need not be pre-sorted).
//
// Rules (Phase A -- see RESTORE_POINT.md's deferred Phase C for tracking
// lines / automation-envelope view / anything fancier):
//  - No cue covers `timeSeconds` -> black, intensity 0. There is no
//    "hold previous value forever" concept yet -- every cue owns its own
//    complete on/off envelope.
//  - Overlapping cues on the same track: the LATEST-STARTING cue that is
//    currently active (timeSeconds inside its own [start, start+duration))
//    wins outright for that instant, i.e. a later cue starting before an
//    earlier one ends overrides it completely, not a color blend.
//  - Within the winning cue: intensity ramps 0 -> cue.intensity over
//    [start, start+fadeIn), holds at cue.intensity over the middle, then
//    ramps cue.intensity -> 0 over [end-fadeOut, end). Color is constant
//    across the whole span (only intensity fades -- matches a dimmer fade
//    on a real console; color/position snapping instantly is a deliberate
//    Phase A simplification, not an oversight).
//  - fadeIn + fadeOut > duration is clamped so they never overlap: fadeIn
//    first (up to the full duration), fadeOut gets whatever's left.
inline LightCueValue resolveLightCueValue(const std::vector<LightCue>& cues,
                                           double timeSeconds) {
    const LightCue* active = nullptr;
    double activeStart = 0.0;

    // Single pass, no allocation: track the latest-starting active cue seen
    // so far rather than sorting a copy -- cheap enough to call every frame
    // per track from a live preview.
    for (const auto& c : cues) {
        const double end = c.startSeconds + c.durationSeconds;
        if (timeSeconds < c.startSeconds || timeSeconds >= end)
            continue;
        if (active == nullptr || c.startSeconds >= activeStart) {
            active = &c;
            activeStart = c.startSeconds;
        }
    }
    if (active == nullptr)
        return {};

    const double dur = std::max(0.0, active->durationSeconds);
    const double fadeIn = std::clamp(active->fadeInSeconds, 0.0, dur);
    const double fadeOut = std::clamp(active->fadeOutSeconds, 0.0, dur - fadeIn);
    const double t = timeSeconds - active->startSeconds; // 0..dur
    const double fadeOutStart = dur - fadeOut;

    double level = 1.0;
    if (fadeIn > 0.0 && t < fadeIn)
        level = t / fadeIn;
    else if (fadeOut > 0.0 && t >= fadeOutStart)
        level = std::max(0.0, (dur - t) / fadeOut);

    LightCueValue out;
    out.r = active->colorR;
    out.g = active->colorG;
    out.b = active->colorB;
    out.intensity = active->intensity * level;
    return out;
}

} // namespace resostage
