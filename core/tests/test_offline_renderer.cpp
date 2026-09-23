#include "doctest.h"

#include "engine/OfflineRenderer.h"

#include <array>
#include <chrono>
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

uint32_t littleEndianU32(const std::array<uint8_t, 44>& bytes, size_t offset) {
    return static_cast<uint32_t>(bytes[offset])
        | (static_cast<uint32_t>(bytes[offset + 1]) << 8u)
        | (static_cast<uint32_t>(bytes[offset + 2]) << 16u)
        | (static_cast<uint32_t>(bytes[offset + 3]) << 24u);
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
        project, {}, request, [&](double value) { progress = value; });

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
}
