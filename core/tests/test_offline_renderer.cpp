#include "doctest.h"

#include "engine/OfflineRenderer.h"

#include <array>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>

using namespace resostage;

namespace {
std::filesystem::path temporaryWavPath() {
    return std::filesystem::temp_directory_path()
        / ("resostage-offline-render-" + std::to_string(
              std::chrono::steady_clock::now().time_since_epoch().count()) + ".wav");
}

std::filesystem::path temporaryWavPath(const char* suffix) {
    auto path = temporaryWavPath();
    return path.parent_path() / (path.stem().string() + suffix + ".wav");
}

uint32_t littleEndianU32(const std::array<uint8_t, 44>& bytes, size_t offset) {
    return static_cast<uint32_t>(bytes[offset])
        | (static_cast<uint32_t>(bytes[offset + 1]) << 8u)
        | (static_cast<uint32_t>(bytes[offset + 2]) << 16u)
        | (static_cast<uint32_t>(bytes[offset + 3]) << 24u);
}

double maxPcm24Amplitude(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    input.seekg(44);
    double peak = 0.0;
    std::array<uint8_t, 3> bytes{};
    while (input.read(reinterpret_cast<char*>(bytes.data()), 3)) {
        int32_t sample = static_cast<int32_t>(bytes[0])
            | (static_cast<int32_t>(bytes[1]) << 8)
            | (static_cast<int32_t>(bytes[2]) << 16);
        if ((sample & 0x00800000) != 0) sample |= static_cast<int32_t>(0xff000000);
        peak = std::max(peak, std::abs(static_cast<double>(sample) / 8388607.0));
    }
    return peak;
}
} // namespace

TEST_CASE("OfflineRenderer writes a bounded click stem with a valid WAV header") {
    Project project;
    project.name = "Render test";
    project.click.enabled = true;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.1});

    const auto path = temporaryWavPath();
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.targetKind = RenderTargetKind::Click;
    request.outputPath = path.string();
    request.sampleRate = 48000;
    request.bitDepth = 16;

    double progress = 0.0;
    const auto result = OfflineRenderer{}.render(
        project, {}, request, [&](const OfflineRenderProgress& value) { progress = value.progress; });

    CHECK(result.ok);
    CHECK(result.error.empty());
    CHECK(result.framesWritten == 4800);
    CHECK(progress == doctest::Approx(1.0));
    REQUIRE(std::filesystem::exists(path));
    CHECK(std::filesystem::file_size(path) == 44 + 4800 * 2 * sizeof(int16_t));

    std::array<uint8_t, 44> header{};
    std::ifstream input(path, std::ios::binary);
    input.read(reinterpret_cast<char*>(header.data()), static_cast<std::streamsize>(header.size()));
    CHECK(std::string(reinterpret_cast<const char*>(header.data()), 4) == "RIFF");
    CHECK(std::string(reinterpret_cast<const char*>(header.data() + 8), 4) == "WAVE");
    CHECK(littleEndianU32(header, 24) == 48000);
    CHECK(littleEndianU32(header, 40) == 4800 * 2 * sizeof(int16_t));

    std::error_code ignored;
    std::filesystem::remove(path, ignored);
}

TEST_CASE("OfflineRenderer rejects an unknown track without leaving a partial file") {
    Project project;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.01});

    const auto path = temporaryWavPath();
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.targetKind = RenderTargetKind::Track;
    request.targetId = "audio::track:missing";
    request.outputPath = path.string();

    const auto result = OfflineRenderer{}.render(project, {}, request);
    CHECK_FALSE(result.ok);
    CHECK(result.error.find("does not exist") != std::string::npos);
    CHECK_FALSE(std::filesystem::exists(path));
    CHECK_FALSE(std::filesystem::exists(path.string() + ".resostage-part"));
    CHECK_FALSE(std::filesystem::exists(path.string() + ".resostage-float-part"));
}

TEST_CASE("OfflineRenderer captures several taps in one bounded render job") {
    Project project;
    project.name = "Multi tap";
    project.click.enabled = true;
    project.click.output.type = OutputType::Main;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.05});

    const auto mainPath = temporaryWavPath("-main");
    const auto clickPath = temporaryWavPath("-click");
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.sampleRate = 48000;
    request.bitDepth = 24;
    request.targets = {
        {RenderTargetKind::Master, {}, mainPath.string()},
        {RenderTargetKind::Click, {}, clickPath.string()},
    };

    const auto result = OfflineRenderer{}.render(project, {}, request);
    CHECK(result.ok);
    CHECK(result.outputPaths.size() == 2);
    CHECK(result.framesWritten == 2400);
    CHECK(std::filesystem::file_size(mainPath) == 44 + 2400 * 2 * 3);
    CHECK(std::filesystem::file_size(clickPath) == 44 + 2400 * 2 * 3);

    std::error_code ignored;
    std::filesystem::remove(mainPath, ignored);
    std::filesystem::remove(clickPath, ignored);
}

TEST_CASE("OfflineRenderer Leave tail is quiet-detected and hard bounded") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.01});

    const auto path = temporaryWavPath("-tail");
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.targetKind = RenderTargetKind::Click;
    request.outputPath = path.string();
    request.sampleRate = 48000;
    request.tailPolicy = RenderTailPolicy::Leave;
    request.tailQuietSeconds = 0.05;
    request.maxTailSeconds = 1.0;
    request.tailThresholdDb = -24.0;

    const auto result = OfflineRenderer{}.render(project, {}, request);
    CHECK(result.ok);
    CHECK(result.framesWritten > 480);
    CHECK(result.framesWritten < 480 + 48000);

    std::error_code ignored;
    std::filesystem::remove(path, ignored);
}

TEST_CASE("OfflineRenderer Wrap primes once and writes one exact range") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Loop", .endSeconds = 0.025});

    const auto path = temporaryWavPath("-wrap");
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.targetKind = RenderTargetKind::Click;
    request.outputPath = path.string();
    request.sampleRate = 48000;
    request.tailPolicy = RenderTailPolicy::Wrap;
    request.normalization = RenderNormalization::Peak;
    request.normalizationCeilingDb = -1.0;

    const auto result = OfflineRenderer{}.render(project, {}, request);
    CHECK(result.ok);
    CHECK(result.framesWritten == 1200);
    CHECK(std::filesystem::file_size(path) == 44 + 1200 * 2 * 3);
    CHECK(maxPcm24Amplitude(path) == doctest::Approx(std::pow(10.0, -1.0 / 20.0)).epsilon(0.002));
    CHECK_FALSE(std::filesystem::exists(path.string() + ".resostage-part"));
    CHECK_FALSE(std::filesystem::exists(path.string() + ".resostage-float-part"));

    std::error_code ignored;
    std::filesystem::remove(path, ignored);
}

TEST_CASE("OfflineRenderer never overwrites an existing destination") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.01});

    const auto path = temporaryWavPath("-existing");
    {
        std::ofstream existing(path, std::ios::binary);
        existing << "keep-me";
    }
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.targetKind = RenderTargetKind::Click;
    request.outputPath = path.string();

    const auto result = OfflineRenderer{}.render(project, {}, request);
    CHECK_FALSE(result.ok);
    std::ifstream existing(path, std::ios::binary);
    std::string contents((std::istreambuf_iterator<char>(existing)), {});
    CHECK(contents == "keep-me");

    std::error_code ignored;
    std::filesystem::remove(path, ignored);
}
