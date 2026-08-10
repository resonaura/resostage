#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace resostage {

/**
 * The gap between rendering a sample and hearing it.
 *
 * An audio interface does not play a block the instant the render callback
 * hands it over. The driver holds a safety margin, the device buffers, the
 * converters have their own pipeline, and USB adds packet time on top. The
 * total is tens of milliseconds at a small buffer and most of a tenth of a
 * second at 4096 frames.
 *
 * That gap does not matter for audio -- everything in the mix goes through it
 * together. It matters enormously for everything that is NOT audio. A MIDI
 * note or a DMX flash generated alongside sample N leaves the machine
 * immediately, while sample N is still queued. So the light hits before the
 * downbeat, and by an amount that CHANGES when the operator touches the buffer
 * size, which is the worst property a timing error can have: it looks like the
 * show drifting rather than like a setting.
 *
 * The fix is to schedule control events for the moment their audio will be
 * heard rather than the moment it was rendered. Not to delay the audio --
 * that would add latency to every Start, Stop and cue the operator triggers,
 * making the whole instrument feel slower to fix a problem in one corner of
 * it.
 *
 * Everything here is integer and floating-point arithmetic with no platform
 * headers: the device reports its own latency (JUCE 9's CoreAudio backend
 * already sums device latency, safety offset, stream latency and the buffer),
 * and this decides what to do with the number.
 */

/** Sane ceiling on a device's claimed output latency, in seconds.
 *
 * A driver reporting something absurd -- and some do, especially aggregates
 * mid-reconfiguration -- must not be able to push every trigger in the show
 * seconds into the future. Half a second is far beyond any real interface and
 * far below "the show has stopped responding".
 */
inline constexpr double kMaxPlausibleOutputLatencySeconds = 0.5;

/**
 * Device-reported output latency, clamped to something a show can survive.
 *
 * Negative and non-finite readings become zero: an unknown latency is better
 * treated as none at all than as a guess, because the failure mode of a wrong
 * guess is a visible timing offset nobody can account for.
 */
inline double outputLatencySeconds(int64_t latencySamples, double sampleRate) {
    if (latencySamples <= 0 || !(sampleRate > 0.0))
        return 0.0;
    const double seconds = static_cast<double>(latencySamples) / sampleRate;
    if (!std::isfinite(seconds) || seconds < 0.0)
        return 0.0;
    return std::min(seconds, kMaxPlausibleOutputLatencySeconds);
}

/**
 * When a sample rendered now will actually be heard.
 *
 * `blockHostNanos` is the host clock at the start of the block being rendered,
 * `offsetSeconds` is how far into that block the event sits, and the latency
 * is what the device reported.
 *
 * This is the value a scheduled MIDI packet or a deferred DMX frame should
 * carry, so it leaves the machine in step with the audio instead of ahead of
 * it.
 */
inline uint64_t heardHostNanos(uint64_t blockHostNanos, double offsetSeconds,
                               double outputLatencySec) {
    double ahead = offsetSeconds + outputLatencySec;
    if (!std::isfinite(ahead) || ahead < 0.0)
        ahead = 0.0;
    return blockHostNanos + static_cast<uint64_t>(ahead * 1.0e9);
}

/**
 * The sample the audience is hearing, given the one being rendered.
 *
 * Never below zero: at the very top of a song the render position is smaller
 * than the latency, and the honest answer there is "the first sample", not a
 * position before the song started.
 */
inline int64_t heardSample(int64_t renderSample, int64_t latencySamples) {
    if (latencySamples <= 0)
        return renderSample;
    return std::max<int64_t>(0, renderSample - latencySamples);
}

} // namespace resostage
