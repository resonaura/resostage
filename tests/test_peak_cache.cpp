#include "doctest.h"

#include "audio/PeakCache.h"
#include "audio/PeakOverview.h"

#include <cstring>
#include <string>
#include <vector>

using namespace resoset;

TEST_CASE("PeakCache serialize/deserialize round-trip") {
    PeakOverview ov;
    ov.durationSeconds = 12.5;
    ov.numChannels = 2;
    ov.peaks = {0.1f, 0.5f, 0.9f, 0.2f};

    const auto bytes = PeakCache::serialize(ov);
    REQUIRE(bytes.size() >= 4);
    CHECK(std::memcmp(bytes.data(), "RPK1", 4) == 0);

    PeakOverview back;
    std::string error;
    REQUIRE(PeakCache::deserialize(bytes.data(), bytes.size(), back, error));
    CHECK(back.durationSeconds == doctest::Approx(12.5));
    CHECK(back.numChannels == 2);
    REQUIRE(back.peaks.size() == 4);
    CHECK(back.peaks[0] == doctest::Approx(0.1f));
    CHECK(back.peaks[2] == doctest::Approx(0.9f));
}

TEST_CASE("PeakCache entry path sanitizes slashes") {
    CHECK(PeakCache::cacheEntryPath("Audio/song1/kick.wav")
          == "Peaks/Audio_song1_kick.wav.rpk");
}

TEST_CASE("PeakCache rejects bad magic") {
    PeakOverview ov;
    std::string error;
    const uint8_t bad[] = {'X', 'X', 'X', 'X', 0, 0, 0, 0};
    CHECK_FALSE(PeakCache::deserialize(bad, sizeof(bad), ov, error));
    CHECK_FALSE(error.empty());
}
