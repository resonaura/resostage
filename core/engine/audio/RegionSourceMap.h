#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace resostage {

/**
 * Where in a source file a given moment of a region comes from.
 *
 * This is the whole of what speed, reverse and looping mean at playback time:
 * a mapping from "how far into the region are we" to "which source frame".
 * The audio thread calls it once per sample on the shaped path, so it is
 * header-only, branch-light and free of any allocation.
 *
 * It lives apart from the render callback because it is the part that can be
 * WRONG in ways you cannot hear as a click -- a reversed loop at 1.5x that
 * drifts by one frame per cycle, or a speed change that quietly shortens the
 * source span the region draws from. Those are propositions about arithmetic,
 * and they belong in a test rather than in a listening session.
 */
struct RegionSourceWindow {
    /** First source frame this region uses (its trim-in point). */
    int64_t sourceOffset = 0;
    /** Frames available from sourceOffset to the end of the file. */
    int64_t sourceAvail = 0;
    /** The region's length on the song timeline, in frames. */
    int64_t regionLength = 0;
    /**
     * Loop period in source frames. Already clamped by the caller to the
     * available source, so a loop can never ask for frames the file lacks.
     */
    int64_t loopCycle = 0;
    /** 1.0 = as recorded; 2.0 = twice as fast, so half the timeline per frame. */
    double speed = 1.0;
    bool reverse = false;
    bool loop = false;
};

/**
 * How many source frames the region draws from.
 *
 * A looping region draws exactly one loop period, forever. A one-shot draws
 * `regionLength * speed` -- which is the point of a speed change: the region
 * keeps its length on the timeline and consumes MORE (or less) of the file.
 * Capped at what the file actually has.
 */
inline int64_t regionSourceSpan(const RegionSourceWindow& w) {
    if (w.loop)
        return w.loopCycle;
    const int64_t wanted =
        std::max<int64_t>(1, static_cast<int64_t>(std::llround(
                                 static_cast<double>(w.regionLength) * w.speed)));
    return std::min(w.sourceAvail, wanted);
}

/**
 * Source frame for `intoRegion`, as a real number for the interpolator.
 *
 * Returns -1 for "nothing to play here": before the region, or past the end of
 * a one-shot. A looping region never runs out.
 *
 * Reverse mirrors inside the SPAN, not inside the file, so reversing a trimmed
 * region plays that region backwards rather than jumping somewhere else in the
 * stem. Combining it with speed therefore composes cleanly: speed decides how
 * much of the file the region covers, reverse decides which end it starts at.
 */
inline double shapedSourceFrame(const RegionSourceWindow& w, int64_t intoRegion) {
    const int64_t span = regionSourceSpan(w);
    if (intoRegion < 0 || span <= 0)
        return -1.0;

    double p = static_cast<double>(intoRegion) * w.speed;
    if (w.loop) {
        p = std::fmod(p, static_cast<double>(span));
        if (p < 0.0)
            p += static_cast<double>(span);
    } else if (p >= static_cast<double>(span)) {
        return -1.0;
    }
    if (w.reverse)
        p = static_cast<double>(span) - 1.0 - p;
    return static_cast<double>(w.sourceOffset) + p;
}

/**
 * The same mapping for a region playing at its recorded speed, forwards.
 *
 * Kept separate rather than folded into the one above because this is the
 * common case and it must stay integral: no interpolation, no rounding, so a
 * plain region is a bit-exact read of its file. Returns -1 for "nothing here".
 */
inline int64_t straightSourceFrame(const RegionSourceWindow& w, int64_t intoRegion) {
    if (intoRegion < 0 || w.sourceAvail <= 0)
        return -1;
    if (w.loop) {
        if (w.loopCycle <= 0)
            return -1;
        int64_t m = intoRegion % w.loopCycle;
        if (m < 0)
            m += w.loopCycle;
        return w.sourceOffset + m;
    }
    if (intoRegion >= w.sourceAvail)
        return -1;
    return w.sourceOffset + intoRegion;
}

} // namespace resostage
