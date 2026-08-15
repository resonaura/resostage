// What arms the end of a song.
//
// The bug this pins was found by playing an empty song and watching the
// transport roll straight past the end of the set with "Wait for trigger" on
// screen. That is a slow thing to reproduce by hand and an easy thing to
// regress, because the failure is a ZERO flowing into a `> 0` check several
// files away.

#include "doctest.h"

#include "timing/SongLength.h"

using namespace resostage;

constexpr double kSr = 48000.0;

TEST_CASE("song length: an authored end marker wins over the content") {
    // The marker is the operator's decision. It may cut a tail short...
    CHECK(songLengthFramesFor(30.0, static_cast<int64_t>(120.0 * kSr), kSr)
          == static_cast<int64_t>(30.0 * kSr));
    // ...or leave silence after the last region, which is how you hold a song
    // open for a cue.
    CHECK(songLengthFramesFor(300.0, static_cast<int64_t>(120.0 * kSr), kSr)
          == static_cast<int64_t>(300.0 * kSr));
}

TEST_CASE("song length: with no marker, the content decides") {
    const int64_t content = static_cast<int64_t>(212.5 * kSr);
    CHECK(songLengthFramesFor(0.0, content, kSr) == content);
}

TEST_CASE("song length: an empty song still ends") {
    const int64_t frames = songLengthFramesFor(0.0, 0, kSr);
    CHECK(frames > 0);
    CHECK(frames == static_cast<int64_t>(3600.0 * kSr));
}

TEST_CASE("song length: a nonsense marker falls through instead of poisoning the transport") {
    const int64_t content = static_cast<int64_t>(60.0 * kSr);
    // Negative and non-finite ends are not lengths; the content still is.
    CHECK(songLengthFramesFor(-5.0, content, kSr) == content);
    CHECK(songLengthFramesFor(std::nan(""), content, kSr) == content);
    CHECK(songLengthFramesFor(std::numeric_limits<double>::infinity(), content, kSr) == content);
    // And with no content either, the floor still applies rather than zero.
    CHECK(songLengthFramesFor(-5.0, 0, kSr) == static_cast<int64_t>(3600.0 * kSr));
}

TEST_CASE("song length: the floor scales with the sample rate") {
    CHECK(songLengthFramesFor(0.0, 0, 44100.0) == static_cast<int64_t>(3600.0 * 44100.0));
    CHECK(songLengthFramesFor(0.0, 0, 96000.0) == static_cast<int64_t>(3600.0 * 96000.0));
    // No device yet: there is no frame count to give, and guessing one would
    // arm the end of a song against a rate that is about to change.
    CHECK(songLengthFramesFor(0.0, 0, 0.0) == 0);
}
