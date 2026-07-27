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

    PeakLevel level0;
    level0.samplesPerBin = 16;
    level0.bins = {{-0.1f, 0.1f, 0.05f}, {-0.5f, 0.5f, 0.3f}, {-0.9f, 0.9f, 0.6f}, {-0.2f, 0.2f, 0.1f}};
    ov.levels.push_back(level0);

    PeakLevel level1;
    level1.samplesPerBin = 256;
    level1.bins = {{-0.9f, 0.9f, 0.4f}};
    ov.levels.push_back(level1);

    const auto bytes = PeakCache::serialize(ov);
    REQUIRE(bytes.size() >= 4);
    CHECK(std::memcmp(bytes.data(), "RPK3", 4) == 0);

    PeakOverview back;
    std::string error;
    REQUIRE(PeakCache::deserialize(bytes.data(), bytes.size(), back, error));
    CHECK(back.durationSeconds == doctest::Approx(12.5));
    CHECK(back.numChannels == 2);
    REQUIRE(back.levels.size() == 2);
    CHECK(back.levels[0].samplesPerBin == 16);
    REQUIRE(back.levels[0].bins.size() == 4);
    CHECK(back.levels[0].bins[0].minVal == doctest::Approx(-0.1f));
    CHECK(back.levels[0].bins[2].maxVal == doctest::Approx(0.9f));
    CHECK(back.levels[0].bins[2].rms == doctest::Approx(0.6f));
    CHECK(back.levels[1].samplesPerBin == 256);
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
