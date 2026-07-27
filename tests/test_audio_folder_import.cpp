#include "doctest.h"
#include "project/ProjectJson.h"
#include "project/ProjectLoader.h"
#include "audio/PeakOverview.h"
#include "audio/PeakCache.h"

#include <filesystem>
#include <string>
#include <vector>

using namespace resoset;

TEST_CASE("Audio folder import verification test") {
    namespace fs = std::filesystem;
    const std::string audioDir = "/Users/resonaura/resoset/tests/audio";
    if (!fs::is_directory(audioDir)) {
        return;
    }

    const std::string neverlandPath = audioDir + "/NEVERLAND_120BPM";
    const std::string runPath = audioDir + "/RUN_140BPM";

    REQUIRE(fs::is_directory(neverlandPath));
    REQUIRE(fs::is_directory(runPath));

    std::vector<std::string> neverlandWavs;
    for (const auto& entry : fs::directory_iterator(neverlandPath)) {
        if (entry.path().extension() == ".wav") {
            neverlandWavs.push_back(entry.path().filename().string());
        }
    }
    CHECK(neverlandWavs.size() == 7);

    std::vector<std::string> runWavs;
    for (const auto& entry : fs::directory_iterator(runPath)) {
        if (entry.path().extension() == ".wav") {
            runWavs.push_back(entry.path().filename().string());
        }
    }
    CHECK(runWavs.size() == 6);
}
