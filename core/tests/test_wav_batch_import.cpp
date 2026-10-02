/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "media/WAVBatchImport.h"
#include "project/Uuid.h"

#include <array>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>

using namespace resostage;

namespace {

std::string pathToUTF8(const std::filesystem::path& path) {
    const auto value = path.u8string();
    return std::string(value.begin(), value.end());
}

std::string readFile(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

void writeWAV(const std::filesystem::path& path, int16_t sample) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream output(path, std::ios::binary);
    const auto u16 = [&output](uint16_t value) {
        const std::array<char, 2> bytes{static_cast<char>(value), static_cast<char>(value >> 8)};
        output.write(bytes.data(), bytes.size());
    };
    const auto u32 = [&output](uint32_t value) {
        const std::array<char, 4> bytes{static_cast<char>(value), static_cast<char>(value >> 8),
                                      static_cast<char>(value >> 16), static_cast<char>(value >> 24)};
        output.write(bytes.data(), bytes.size());
    };
    output.write("RIFF", 4); u32(36 + 128);
    output.write("WAVEfmt ", 8); u32(16);
    u16(1); u16(1); u32(64); u32(128); u16(2); u16(16);
    output.write("data", 4); u32(128);
    for (int frame = 0; frame < 64; ++frame)
        u16(static_cast<uint16_t>(sample));
    output.close();
    REQUIRE(output.good());
}

struct BatchFixture {
    std::filesystem::path directory = std::filesystem::temp_directory_path()
        / ("resostage-wav-batch-" + generateUUIDv7());
    std::filesystem::path package = directory / "Test.rsnraset";
    ProjectLoader loader;

    BatchFixture() {
        std::filesystem::create_directories(directory);
        loader.newProject("WAV Batch Test");
        loader.project().tracks.resize(2);
        loader.project().tracks[0].id = "audio::track:1";
        loader.project().tracks[1].id = "audio::track:2";
        loader.project().songs[0].regions.clear();
        loader.project().songs[0].endSeconds = 0.5;
        std::string error;
        REQUIRE(loader.saveAs(pathToUTF8(package), error));
        REQUIRE(loader.open(pathToUTF8(package), error));
    }

    ~BatchFixture() {
        loader.close();
        std::error_code ignored;
        std::filesystem::remove_all(directory, ignored);
    }

    size_t assetCount(const char* name) const {
        size_t count = 0;
        for (const auto& entry : std::filesystem::directory_iterator(package / name))
            count += entry.is_regular_file() ? 1 : 0;
        return count;
    }
};

} // namespace

TEST_CASE("WAV stem batch streams colliding names and commits a private snapshot") {
    BatchFixture fixture;
    const auto first = fixture.directory / "one" / "same.wav";
    const auto second = fixture.directory / "two" / "same.wav";
    writeWAV(first, 1200);
    writeWAV(second, -2400);
    const auto old = fixture.package / "Audio" / "same.wav";
    writeWAV(old, 600);
    const auto oldBytes = readFile(old);

    Region trimmed;
    trimmed.id = generateUUIDv7();
    trimmed.trackId = fixture.loader.project().tracks[0].id;
    trimmed.startSeconds = 0.25;
    trimmed.durationSeconds = 0.5;
    trimmed.source.file = "Audio/same.wav";
    trimmed.source.offsetSeconds = 0.125;
    trimmed.fade.inSeconds = 0.05;
    trimmed.loop.enabled = true;
    trimmed.loop.lengthSeconds = 0.25;
    fixture.loader.project().songs[0].regions.push_back(trimmed);
    const Project before = fixture.loader.project();
    const std::array<media::WAVStemImportItem, 2> items{{
        {0, pathToUTF8(first)}, {1, pathToUTF8(second)}
    }};
    std::vector<std::pair<std::string, PeakOverview>> peaks;
    std::string error;
    REQUIRE_MESSAGE(media::writeWAVStemBatch(fixture.loader, before, 0, items,
                                            pathToUTF8(fixture.package), nullptr, peaks, error), error);
    REQUIRE(peaks.size() == 2);
    CHECK(peaks[0].first != peaks[1].first);
    CHECK(readFile(fixture.package / peaks[0].first) == readFile(first));
    CHECK(readFile(fixture.package / peaks[1].first) == readFile(second));
    CHECK(readFile(old) == oldBytes);
    CHECK(fixture.loader.project().songs[0].regions.size() == 1);
    CHECK(fixture.loader.project().songs[0].regions[0].source.file == "Audio/same.wav");

    ProjectLoader reopened;
    REQUIRE(reopened.open(pathToUTF8(fixture.package), error));
    REQUIRE(reopened.project().songs[0].regions.size() == 2);
    const auto& replaced = reopened.project().songs[0].regions[0];
    CHECK(replaced.source.file == peaks[0].first);
    CHECK(replaced.id == trimmed.id);
    CHECK(replaced.startSeconds == trimmed.startSeconds);
    CHECK(replaced.durationSeconds == trimmed.durationSeconds);
    CHECK(replaced.source.offsetSeconds == trimmed.source.offsetSeconds);
    CHECK(replaced.fade.inSeconds == trimmed.fade.inSeconds);
    CHECK(replaced.loop.enabled);
    CHECK(replaced.loop.lengthSeconds == trimmed.loop.lengthSeconds);
    CHECK(reopened.project().songs[0].regions[1].durationSeconds == doctest::Approx(1.0));
    CHECK(reopened.project().songs[0].endSeconds == doctest::Approx(1.0));
}

TEST_CASE("WAV stem batch rejects a later invalid file without publishing any part") {
    BatchFixture fixture;
    const auto first = fixture.directory / "valid.wav";
    const auto second = fixture.directory / "invalid.wav";
    writeWAV(first, 1200);
    std::ofstream(second, std::ios::binary) << "This is not PCM";
    const auto metadataBefore = readFile(fixture.package / kProjectDataFileName);
    const Project before = fixture.loader.project();
    const std::array<media::WAVStemImportItem, 2> items{{
        {0, pathToUTF8(first)}, {1, pathToUTF8(second)}
    }};
    std::vector<std::pair<std::string, PeakOverview>> peaks;
    std::string error;
    CHECK_FALSE(media::writeWAVStemBatch(fixture.loader, before, 0, items,
                                        pathToUTF8(fixture.package), nullptr, peaks, error));
    CHECK_FALSE(error.empty());
    CHECK(peaks.empty());
    CHECK(fixture.assetCount("Audio") == 0);
    CHECK(fixture.assetCount("Peaks") == 0);
    CHECK(readFile(fixture.package / kProjectDataFileName) == metadataBefore);
    CHECK(fixture.loader.project().songs[0].regions.empty());
}

TEST_CASE("WAV stem batch bounds requests and honors cancellation before publication") {
    BatchFixture fixture;
    const auto first = fixture.directory / "valid.wav";
    writeWAV(first, 1200);
    const Project before = fixture.loader.project();
    const auto metadataBefore = readFile(fixture.package / kProjectDataFileName);
    std::vector<std::pair<std::string, PeakOverview>> peaks;
    std::string error;
    std::vector<media::WAVStemImportItem> items(1, {0, pathToUTF8(first)});
    const std::atomic<bool> cancelled{true};
    CHECK_FALSE(media::writeWAVStemBatch(fixture.loader, before, 0, items,
                                        pathToUTF8(fixture.package), &cancelled, peaks, error));
    CHECK(error.find("cancelled") != std::string::npos);
    items.push_back(items[0]);
    CHECK_FALSE(media::writeWAVStemBatch(fixture.loader, before, 0, items,
                                        pathToUTF8(fixture.package), nullptr, peaks, error));
    CHECK(error.find("distinct") != std::string::npos);
    items.resize(media::kMaximumWAVBatchFiles + 1);
    CHECK_FALSE(media::writeWAVStemBatch(fixture.loader, before, 0, items,
                                        pathToUTF8(fixture.package), nullptr, peaks, error));
    CHECK(error.find("256") != std::string::npos);
    items.resize(1);
    CHECK_FALSE(media::writeWAVStemBatch(fixture.loader, before, 1, items,
                                        pathToUTF8(fixture.package), nullptr, peaks, error));
    CHECK(peaks.empty());
    CHECK(fixture.assetCount("Audio") == 0);
    CHECK(readFile(fixture.package / kProjectDataFileName) == metadataBefore);
}

TEST_CASE("WAV stem batch removes fresh assets when metadata commit fails") {
    BatchFixture fixture;
    const auto source = fixture.directory / "valid.wav";
    writeWAV(source, 1200);
    const Project before = fixture.loader.project();
    const auto metadataPath = fixture.package / kProjectDataFileName;
    const auto oldMetadata = readFile(metadataPath);
    // An unreplaceable nonempty directory forces the final rename to fail
    // after audio/cache assets have successfully been copied and published.
    std::filesystem::remove(metadataPath);
    std::filesystem::create_directory(metadataPath);
    std::ofstream(metadataPath / "original", std::ios::binary) << oldMetadata;
    const std::array<media::WAVStemImportItem, 1> items{{{0, pathToUTF8(source)}}};
    std::vector<std::pair<std::string, PeakOverview>> peaks;
    std::string error;
    CHECK_FALSE(media::writeWAVStemBatch(fixture.loader, before, 0, items,
                                        pathToUTF8(fixture.package), nullptr, peaks, error));
    CHECK_FALSE(error.empty());
    CHECK(peaks.empty());
    CHECK(fixture.assetCount("Audio") == 0);
    CHECK(fixture.assetCount("Peaks") == 0);
    CHECK(readFile(metadataPath / "original") == oldMetadata);
    CHECK(fixture.loader.project().songs[0].regions.empty());
}
