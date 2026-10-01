// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#pragma once

#include <cmath>

namespace resostage {

/** Positive modulo used for MIDI region source phases. */
inline double midiRegionPositiveModulo(double value, double length) noexcept {
    if (!(length > 1.0e-9) || !std::isfinite(value) || !std::isfinite(length))
        return 0.0;
    double result = std::fmod(value, length);
    if (result < 0.0) result += length;
    return result;
}

/**
 * Source phase at a MIDI region's timeline start, relative to its loop window.
 * clipOffsetBeats remains the phase token used by split regions; loopStartBeats
 * independently records the source boundary created by a non-destructive trim.
 */
inline double midiRegionLoopPhase(double clipOffsetBeats,
                                  double loopStartBeats,
                                  double loopLengthBeats) noexcept {
    return midiRegionPositiveModulo(clipOffsetBeats - loopStartBeats,
                                    loopLengthBeats);
}

/** Map region-relative timeline beats to source beats for playback/preview. */
inline double midiRegionSourceBeat(double elapsedBeats,
                                   double clipOffsetBeats,
                                   double loopStartBeats,
                                   double loopLengthBeats,
                                   bool loop) noexcept {
    if (!loop || !(loopLengthBeats > 1.0e-9))
        return elapsedBeats + clipOffsetBeats;
    return loopStartBeats + midiRegionPositiveModulo(
        midiRegionLoopPhase(clipOffsetBeats, loopStartBeats, loopLengthBeats)
            + elapsedBeats,
        loopLengthBeats);
}

/** First nonnegative region-relative occurrence of a source beat in a loop. */
inline double midiRegionLoopOccurrence(double sourceBeat,
                                       double clipOffsetBeats,
                                       double loopStartBeats,
                                       double loopLengthBeats) noexcept {
    const double phase = midiRegionLoopPhase(clipOffsetBeats, loopStartBeats,
                                             loopLengthBeats);
    return midiRegionPositiveModulo(sourceBeat - loopStartBeats - phase,
                                    loopLengthBeats);
}

inline bool midiRegionContainsLoopSourceBeat(double sourceBeat,
                                             double loopStartBeats,
                                             double loopLengthBeats) noexcept {
    constexpr double epsilon = 1.0e-9;
    return loopLengthBeats > 1.0e-9
        && sourceBeat >= loopStartBeats - epsilon
        && sourceBeat < loopStartBeats + loopLengthBeats - epsilon;
}

} // namespace resostage
