#include "doctest.h"

#include "audio/PeakOverview.h"
#include "project/ProjectLoader.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

using namespace resostage;

namespace {

void appendU32(std::vector<uint8_t>& b, uint32_t v) {
    b.push_back(uint8_t(v)); b.push_back(uint8_t(v >> 8));
    b.push_back(uint8_t(v >> 16)); b.push_back(uint8_t(v >> 24));
}
void appendU16(std::vector<uint8_t>& b, uint16_t v) {
    b.push_back(uint8_t(v)); b.push_back(uint8_t(v >> 8));
}

std::vector<uint8_t> makeSineWav(double freq, double sr, double dur) {
    const int n = int(dur * sr);
    std::vector<uint8_t> out;
    const uint32_t dataSize = uint32_t(n * 2);
    out.insert(out.end(), {'R','I','F','F'});
    appendU32(out, 36 + dataSize);
    out.insert(out.end(), {'W','A','V','E','f','m','t',' '});
    appendU32(out, 16);
    appendU16(out, 1); appendU16(out, 1);
    appendU32(out, uint32_t(sr));
    appendU32(out, uint32_t(sr) * 2);
    appendU16(out, 2); appendU16(out, 16);
    out.insert(out.end(), {'d','a','t','a'});
    appendU32(out, dataSize);
    for (int i = 0; i < n; ++i) {
        const float s = 0.5f * float(std::sin(2.0 * 3.141592653589793 * freq * i / sr));
        const int16_t sample = int16_t(std::lround(s * 32767.0f));
        out.push_back(uint8_t(sample & 0xFF));
        out.push_back(uint8_t((sample >> 8) & 0xFF));
    }
    return out;
}

std::string makeArchiveWithWav() {
    namespace fs = std::filesystem;
    const std::string path =
        std::string(std::getenv("TMPDIR") ? std::getenv("TMPDIR") : "/tmp")
        + "/resoset_peak_overview_test.rsnraset";

    std::error_code ec;
    fs::remove_all(path, ec);
    fs::create_directories(fs::path(path) / "Audio", ec);

    const auto wav = makeSineWav(440.0, 48000.0, 0.25);
    const char* json = R"JSON({"format":{"version":3},"name":"P","sampleRate":48000,"click":{"enabled":false,"name":"Click","channels":2,"gainDb":0,"pan":0,"mute":false,"solo":false,"output":{"type":"sends-only","target":null,"sends":[]}},"main":{"enabled":true,"name":"Main","channels":2,"gainDb":0,"pan":0,"mute":false,"solo":false,"output":{"type":"ext-out","target":"audio::out:1,audio::out:2"}},"sends":[],"tracks":[],"songs":[]})JSON";
    std::ofstream jsonOfs(fs::path(path) / resostage::kProjectDataFileName, std::ios::binary);
    jsonOfs.write(json, std::strlen(json));
    jsonOfs.close();

    std::ofstream wavOfs(fs::path(path) / "Audio" / "tone.wav", std::ios::binary);
    wavOfs.write(reinterpret_cast<const char*>(wav.data()), wav.size());
    wavOfs.close();

    return path;
}

} // namespace

TEST_CASE("PeakOverview builds a multi-level pyramid from a sine WAV in .rsnraset") {
    const std::string path = makeArchiveWithWav();
    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    PeakOverview ov;
    REQUIRE(ov.build(loader, "Audio/tone.wav", error));
    REQUIRE(!ov.levels.empty());
    CHECK(ov.durationSeconds == doctest::Approx(0.25).epsilon(0.01));
    CHECK(ov.numChannels == 1);

    // Finest level should be the most bins, each subsequent level strictly coarser.
    for (size_t i = 1; i < ov.levels.size(); ++i)
        CHECK(ov.levels[i].bins.size() < ov.levels[i - 1].bins.size());

    float maxPeak = 0.0f;
    for (const auto& bin : ov.levels.front().bins)
        maxPeak = std::max(maxPeak, std::max(std::abs(bin.minVal), std::abs(bin.maxVal)));
    CHECK(maxPeak > 0.2f);
    CHECK(maxPeak <= 1.0f);

    const PeakLevel* best = ov.bestLevelForZoom(1.0);
    REQUIRE(best != nullptr);
    CHECK(best->samplesPerBin >= 1);

    std::remove(path.c_str());
}
