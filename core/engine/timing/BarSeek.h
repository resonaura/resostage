#pragma once

#include <cmath>

namespace resostage {

// Length of one bar in seconds, given tempo and time-signature numerator.
// The denominator doesn't affect wall-clock bar length here: bpm is defined
// as quarter-notes-per-minute regardless of the notated denominator, matching
// how the rest of the engine treats SongDef::bpm.
inline double barLengthSeconds(double bpm, int timeSignatureNumerator) {
    if (bpm <= 0.0)
        bpm = 120.0;
    if (timeSignatureNumerator <= 0)
        timeSignatureNumerator = 4;
    return (60.0 / bpm) * static_cast<double>(timeSignatureNumerator);
}

// Computes the seek target (seconds from song start) for one bar-seek step.
// `direction` must be -1 (previous bar) or +1 (next bar).
//
// Always lands exactly on a bar boundary, even when `currentSeconds` is
// mid-bar -- standard DAW transport behavior: stepping backward first snaps
// to the start of the *current* bar (e.g. a few beats into bar 5 -> start of
// bar 5); a second consecutive press from exactly a bar boundary then steps
// to the previous one. Stepping forward always advances to the start of the
// next bar boundary ahead of the current position.
inline double barSeekTargetSeconds(double currentSeconds, double bpm,
                                    int timeSignatureNumerator, int direction) {
    const double barSec = barLengthSeconds(bpm, timeSignatureNumerator);
    if (barSec <= 0.0 || currentSeconds < 0.0)
        return currentSeconds < 0.0 ? 0.0 : currentSeconds;

    // Guards against floating point landing just past a boundary (e.g.
    // 4.0000000002s) being misread as "just into the next bar".
    constexpr double kEps = 1e-6;
    const long long currentBar =
        static_cast<long long>(std::floor(currentSeconds / barSec + kEps));

    long long targetBar = currentBar;
    if (direction < 0) {
        const double distanceIntoBar = currentSeconds - static_cast<double>(currentBar) * barSec;
        targetBar = (distanceIntoBar > kEps) ? currentBar : currentBar - 1;
    } else if (direction > 0) {
        targetBar = currentBar + 1;
    }
    if (targetBar < 0)
        targetBar = 0;
    return static_cast<double>(targetBar) * barSec;
}

} // namespace resostage
