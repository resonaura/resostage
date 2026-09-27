#pragma once

#include <cstdint>

namespace resostage {

/**
 * Canonical half-open [left, right) sample position for a project cycle.
 *
 * This is absolute arithmetic, not an incremented floating phase: the same
 * input always maps to the same sample and therefore cannot accumulate drift
 * across repeated wraps.
 */
inline int64_t wrapCycleSample(int64_t position,
                               int64_t left,
                               int64_t right) noexcept {
    const int64_t length = right - left;
    if (length <= 0 || position < right)
        return position;
    const int64_t relative = position - left;
    return left + ((relative % length) + length) % length;
}

} // namespace resostage
