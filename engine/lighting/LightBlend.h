#pragma once

#include <algorithm>
#include <string>

namespace resostage {

// Compositing mode for a light cue that shares a fixture with another
// currently-active cue on a DIFFERENT LightTrack (two tracks both listing
// the same LightFixture in their fixtureIds, each driven by its own
// independent cue timeline -- the "base layer + accent layer" pattern from
// a concert lighting rig, e.g. a slow Perlin-flame base track plus a
// transient-triggered SonicBoom accent track over the same physical bar).
//
// Deliberately scoped to the RESOLVED color+intensity level, not a full
// per-LED dual-array merge: every spatial (per-LED) effect already derives
// its shape from a base RGB triplet (see addressableEffectLedColor's
// baseR/G/B params), so blending happens on that triplet BEFORE the winning
// layer's spatial shape (if any) is computed on top of it. This composes
// correctly for the documented use cases (a flame base recolored/brightened
// by an additive accent wave) without doubling the per-LED render cost or
// needing two independent per-LED arrays merged pixel-by-pixel.
enum class BlendMode { Normal, Additive, Multiply, Difference, Lighten, Subtractive };

inline BlendMode parseBlendMode(const std::string& s) {
    if (s == "additive") return BlendMode::Additive;
    if (s == "multiply") return BlendMode::Multiply;
    if (s == "difference") return BlendMode::Difference;
    if (s == "lighten") return BlendMode::Lighten;
    if (s == "subtractive") return BlendMode::Subtractive;
    return BlendMode::Normal;
}

inline const char* blendModeToString(BlendMode m) {
    switch (m) {
        case BlendMode::Normal:      return "normal";
        case BlendMode::Additive:    return "additive";
        case BlendMode::Multiply:    return "multiply";
        case BlendMode::Difference:  return "difference";
        case BlendMode::Lighten:     return "lighten";
        case BlendMode::Subtractive: return "subtractive";
    }
    return "normal";
}

// Combines one 0..1 "effective brightness" channel value (already
// premultiplied by whatever intensity/envelope produced it) from a layer
// sitting on top of `base`, the accumulated result of every layer under it
// so far. `top` is the new layer; `mode` is THAT layer's own blend mode
// (each layer decides how IT lands on what's already there, same mental
// model as a layer stack in a compositing app). Normal is a plain replace,
// not an alpha blend -- there is no separate opacity control here, a layer
// is either contributing its full resolved brightness or it isn't part of
// the stack at all this frame (see LightOutputResolver.h's caller, which
// only ever includes CURRENTLY ACTIVE cues as layers).
inline double blendChannel(BlendMode mode, double base, double top) {
    switch (mode) {
        case BlendMode::Normal:      return top;
        case BlendMode::Additive:    return std::min(1.0, base + top);
        case BlendMode::Multiply:    return base * top;
        case BlendMode::Difference:  return std::abs(base - top);
        case BlendMode::Lighten:     return std::max(base, top);
        case BlendMode::Subtractive: return std::max(0.0, base - top);
    }
    return top;
}

} // namespace resostage
