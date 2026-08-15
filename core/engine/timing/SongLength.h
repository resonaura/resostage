#pragma once

#include <cmath>
#include <cstdint>

namespace resostage {

/**
 * How long a song is, in frames -- the number the transport arms its end-of-
 * song action against.
 *
 * Three sources, in order:
 *  1. an authored end marker, which is the operator's decision and wins even
 *     when it cuts a tail short or leaves silence after the last region;
 *  2. the content, when there is no marker;
 *  3. a one-second floor, when there is neither.
 *
 * That floor is not cosmetic. Zero used to mean "no length", and the render
 * callback's arming check (`currentSongLengthFrames > 0`) read it as "never
 * ends" -- so an empty song never armed its song-end action at all. The
 * transport rolled past it forever: no advance to the next song, no stop at
 * the end of the set, whatever the song's onEnded said. One second is also
 * exactly what the timeline draws an empty song at (MIN_SONG_SECONDS), so this
 * is the transport agreeing with what the operator is looking at rather than
 * inventing a duration.
 */
inline int64_t songLengthFramesFor(double endSeconds, int64_t contentFrames, double sampleRate) {
    if (endSeconds > 0.0 && std::isfinite(endSeconds) && sampleRate > 0.0)
        return static_cast<int64_t>(std::llround(endSeconds * sampleRate));
    if (contentFrames > 0)
        return contentFrames;

    constexpr double kEmptySongSeconds = 60.0;
    return sampleRate > 0.0
               ? static_cast<int64_t>(std::llround(kEmptySongSeconds * sampleRate))
               : 0;
}

} // namespace resostage
