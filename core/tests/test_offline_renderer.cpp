/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

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
std::filesystem::path temporaryWAVPath() {
    return std::filesystem::temp_directory_path()
        / ("resostage-offline-render-" + std::to_string(
              std::chrono::steady_clock::now().time_since_epoch().count()) + ".wav");
}

std::filesystem::path temporaryWAVPath(const char* suffix) {
    auto path = temporaryWAVPath();
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

int64_t firstNonZeroPcm16Frame(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    input.seekg(44);
    int64_t frame = 0;
    std::array<int16_t, 2> samples{};
    while (input.read(reinterpret_cast<char*>(samples.data()),
                      static_cast<std::streamsize>(sizeof(samples)))) {
        if (samples[0] != 0 || samples[1] != 0)
            return frame;
        ++frame;
    }
    return -1;
}

class ClearingProcessorSession final : public OfflineProcessorSession {
public:
    ClearingProcessorSession(const MixGraph& graph, int* processedBlocks,
                             int* transportUpdates)
        : entries(graph.strips.size()), blocks(processedBlocks),
          updates(transportUpdates) {
        const uint32_t click = graph.find("audio::click");
        if (click != MixGraph::kNoStrip)
            entries[click] = {this, process};
    }

    MixProcessorView processorView() const noexcept override {
        return {entries.data(), entries.size()};
    }

    void publishTransport(const OfflineProcessorTransport&) noexcept override {
        ++*updates;
    }

private:
    static void process(void* context, float* left, float* right,
                        int count) noexcept {
        auto& self = *static_cast<ClearingProcessorSession*>(context);
        ++*self.blocks;
        std::fill_n(left, count, 0.0f);
        std::fill_n(right, count, 0.0f);
    }

    std::vector<MixStripProcessor> entries;
    int* blocks;
    int* updates;
};

class MidiCaptureSession final : public OfflineProcessorSession {
public:
    struct Event { int64_t sample; uint8_t pitch; uint8_t velocity;
                   uint8_t releaseVelocity; bool noteOn; };
    struct RawEvent { int64_t sample; uint8_t status; uint8_t data1;
                      uint8_t data2; uint8_t dataLength; };
    MidiCaptureSession(uint32_t instrumentStrip, std::vector<Event>* captured,
                       std::vector<RawEvent>* capturedRaw, double* bpm)
        : strip(instrumentStrip), observedBpm(bpm), events(captured), rawEvents(capturedRaw) {}
    MixProcessorView processorView() const noexcept override { return {}; }
    void publishTransport(const OfflineProcessorTransport& value) noexcept override {
        transportSample = value.sample;
        *observedBpm = value.bpm;
    }
    bool stripHasInstrument(uint32_t value) const noexcept override { return value == strip; }
    void queueMidiNote(uint32_t value, uint8_t /*channel*/, uint8_t pitch, uint8_t velocity,
                       uint8_t releaseVelocity, bool noteOn,
                       int samplePosition) noexcept override {
        if (value == strip)
            events->push_back({transportSample + samplePosition, pitch, velocity,
                               releaseVelocity, noteOn});
    }
    void queueMidiMessage(uint32_t value, uint8_t status, uint8_t data1,
                          uint8_t data2, uint8_t dataLength,
                          int samplePosition) noexcept override {
        if (value == strip)
            rawEvents->push_back({transportSample + samplePosition, status, data1, data2, dataLength});
    }
    uint32_t strip;
    int64_t transportSample = 0;
    double* observedBpm;
    std::vector<Event>* events;
    std::vector<RawEvent>* rawEvents;
};

class LatencyProcessorSession final : public OfflineProcessorSession {
public:
    explicit LatencyProcessorSession(const MixGraph& graph)
        : entries(graph.strips.size()), latencies(graph.strips.size(), 0) {
        const uint32_t main = graph.find("audio::main");
        if (main != MixGraph::kNoStrip) {
            entries[main] = {this, process};
            latencies[main] = kLatency;
        }
    }

    MixProcessorView processorView() const noexcept override {
        return {entries.data(), entries.size(), nullptr, 0,
                latencies.data(), latencies.size()};
    }

    void publishTransport(const OfflineProcessorTransport&) noexcept override {}
    std::vector<std::string> warnings() const override {
        return {"Synthetic processor warning"};
    }

private:
    static constexpr size_t kLatency = 4;

    static void process(void* context, float* left, float* right,
                        int count) noexcept {
        auto& self = *static_cast<LatencyProcessorSession*>(context);
        for (int i = 0; i < count; ++i) {
            const float inputLeft = left[i];
            const float inputRight = right[i];
            left[i] = self.delayLeft[self.cursor];
            right[i] = self.delayRight[self.cursor];
            self.delayLeft[self.cursor] = inputLeft;
            self.delayRight[self.cursor] = inputRight;
            self.cursor = (self.cursor + 1) % kLatency;
        }
    }

    std::vector<MixStripProcessor> entries;
    std::vector<uint32_t> latencies;
    std::array<float, kLatency> delayLeft{};
    std::array<float, kLatency> delayRight{};
    size_t cursor = 0;
};

class SparseTailProcessorSession final : public OfflineProcessorSession {
public:
    explicit SparseTailProcessorSession(const MixGraph& graph)
        : entries(graph.strips.size()) {
        const uint32_t click = graph.find("audio::click");
        if (click != MixGraph::kNoStrip)
            entries[click] = {this, process};
    }

    MixProcessorView processorView() const noexcept override {
        return {entries.data(), entries.size()};
    }

    void publishTransport(const OfflineProcessorTransport&) noexcept override {}
    double declaredTailSeconds() const noexcept override { return 0.1; }

private:
    static void process(void* context, float* left, float* right,
                        int count) noexcept {
        auto& self = *static_cast<SparseTailProcessorSession*>(context);
        std::fill_n(left, count, 0.0f);
        std::fill_n(right, count, 0.0f);
        constexpr int64_t echoFrame = 3600;
        if (self.processedFrames <= echoFrame
            && echoFrame < self.processedFrames + count) {
            const size_t offset = static_cast<size_t>(
                echoFrame - self.processedFrames);
            left[offset] = 0.5f;
            right[offset] = 0.5f;
        }
        self.processedFrames += count;
    }

    std::vector<MixStripProcessor> entries;
    int64_t processedFrames = 0;
};
} // namespace

TEST_CASE("OfflineRenderer respects disabled click generation without changing routing") {
    Project project;
    project.sampleRate = 48000.0;
    project.click.enabled = false;
    project.click.mute = false;
    project.click.output.type = OutputType::Main;
    SongDef song;
    song.name = "Silent metronome";
    song.endSeconds = 0.05;
    project.songs.push_back(song);
    const auto mainPath = temporaryWAVPath("-disabled-main");
    const auto clickPath = temporaryWAVPath("-disabled-click");
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.sampleRate = 48000;
    request.bitDepth = 24;
    request.targets = {
        {RenderTargetKind::Master, {}, mainPath.string()},
        {RenderTargetKind::Click, {}, clickPath.string()},
    };
    OfflineRenderer renderer;
    const auto result = renderer.render(project, "", request);
    REQUIRE(result.ok);
    CHECK(maxPcm24Amplitude(mainPath) == doctest::Approx(0.0));
    CHECK(maxPcm24Amplitude(clickPath) == doctest::Approx(0.0));
    CHECK_FALSE(project.click.mute);
    std::error_code ignored;
    std::filesystem::remove(mainPath, ignored);
    std::filesystem::remove(clickPath, ignored);
}

TEST_CASE("OfflineRenderer writes a bounded click stem with a valid WAV header") {
    Project project;
    project.name = "Render test";
    project.click.enabled = true;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.1});

    const auto path = temporaryWAVPath();
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

    const auto path = temporaryWAVPath();
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

    const auto mainPath = temporaryWAVPath("-main");
    const auto clickPath = temporaryWAVPath("-click");
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

TEST_CASE("OfflineRenderer aligns selected stems to one compensated origin") {
    Project project;
    project.name = "Aligned taps";
    project.click.enabled = true;
    project.click.output.type = OutputType::Main;
    project.songs.push_back(
        SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.05});

    const auto mainPath = temporaryWAVPath("-aligned-main");
    const auto clickPath = temporaryWAVPath("-aligned-click");
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.sampleRate = 48000;
    request.bitDepth = 16;
    request.targets = {
        {RenderTargetKind::Master, {}, mainPath.string()},
        {RenderTargetKind::Click, {}, clickPath.string()},
    };
    const OfflineRenderer::ProcessorFactory factory =
        [](const Project&, const MixGraph& graph, double, int,
           std::string&) -> std::unique_ptr<OfflineProcessorSession> {
            return std::make_unique<LatencyProcessorSession>(graph);
        };

    const auto result = OfflineRenderer{}.render(
        project, {}, request, {}, nullptr, factory);
    CHECK(result.ok);
    CHECK(result.warnings == std::vector<std::string>{"Synthetic processor warning"});
    const int64_t mainStart = firstNonZeroPcm16Frame(mainPath);
    const int64_t clickStart = firstNonZeroPcm16Frame(clickPath);
    CHECK(mainStart >= 0);
    CHECK(clickStart == mainStart);
    CHECK(mainStart < 4); // common four-sample PDC startup was trimmed
    CHECK(result.framesWritten == 2400);

    std::error_code ignored;
    std::filesystem::remove(mainPath, ignored);
    std::filesystem::remove(clickPath, ignored);
}

TEST_CASE("OfflineRenderer Leave tail is quiet-detected and hard bounded") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.01});

    const auto path = temporaryWAVPath("-tail");
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

TEST_CASE("OfflineRenderer Leave honors declared sparse processor tails") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(
        SongDef{.id = "meta::song:1", .name = "Sparse tail", .endSeconds = 0.01});

    const auto path = temporaryWAVPath("-sparse-tail");
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.targetKind = RenderTargetKind::Click;
    request.outputPath = path.string();
    request.sampleRate = 48000;
    request.tailPolicy = RenderTailPolicy::Leave;
    request.tailQuietSeconds = 0.05;
    request.maxTailSeconds = 1.0;
    request.tailThresholdDb = -24.0;
    const OfflineRenderer::ProcessorFactory factory =
        [](const Project&, const MixGraph& graph, double, int,
           std::string&) -> std::unique_ptr<OfflineProcessorSession> {
            return std::make_unique<SparseTailProcessorSession>(graph);
        };

    const auto result = OfflineRenderer{}.render(
        project, {}, request, {}, nullptr, factory);
    CHECK(result.ok);
    CHECK(result.framesWritten > 3600);
    CHECK(result.framesWritten <= 480 + 48000);

    std::error_code ignored;
    std::filesystem::remove(path, ignored);
}

TEST_CASE("OfflineRenderer Wrap primes once and writes one exact range") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Loop", .endSeconds = 0.025});

    const auto path = temporaryWAVPath("-wrap");
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

TEST_CASE("OfflineRenderer creates private processor sessions and runs their strip taps") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(
        SongDef{.id = "meta::song:1", .name = "One", .endSeconds = 0.01});
    project.songs.push_back(
        SongDef{.id = "meta::song:2", .name = "Two", .endSeconds = 0.01});

    const auto path = temporaryWAVPath("-processors");
    OfflineRenderRequest request;
    request.songIndex = -1;
    request.targetKind = RenderTargetKind::Click;
    request.outputPath = path.string();
    request.sampleRate = 48000;

    int sessions = 0;
    int blocks = 0;
    int transportUpdates = 0;
    const OfflineRenderer::ProcessorFactory factory =
        [&](const Project&, const MixGraph& graph, double, int,
            std::string&) -> std::unique_ptr<OfflineProcessorSession> {
            ++sessions;
            return std::make_unique<ClearingProcessorSession>(
                graph, &blocks, &transportUpdates);
        };
    const auto result = OfflineRenderer{}.render(
        project, {}, request, {}, nullptr, factory);

    CHECK(result.ok);
    CHECK(sessions == 2);
    CHECK(blocks > 0);
    CHECK(transportUpdates == blocks);
    CHECK(maxPcm24Amplitude(path) == doctest::Approx(0.0));

    std::error_code ignored;
    std::filesystem::remove(path, ignored);
}

TEST_CASE("OfflineRenderer sends song-tempo MIDI to the private instrument processor") {
    Project project;
    TrackDef instrument;
    instrument.id = "audio::track:instrument";
    instrument.name = "Synth";
    instrument.kind = TrackKind::Instrument;
    project.tracks.push_back(instrument);

    SongDef song;
    song.id = "meta::song:1";
    song.name = "MIDI";
    song.bpm = 120.0;
    song.endSeconds = 1.5;
    song.tempoPoints = {
        TempoPoint{.beat = 0.0, .bpm = 120.0, .curve = 0.0},
        TempoPoint{.beat = 1.0, .bpm = 60.0, .curve = 0.0},
    };
    MidiRegion region;
    region.id = "midi-region";
    region.trackId = instrument.id;
    region.startBeats = 0.0;
    region.durationBeats = 4.0;
    MidiNote note;
    note.id = 1;
    note.pitch = 64;
    note.startBeats = 0.5;
    note.durationBeats = 1.0;
    note.velocity = 0.75f;
    note.releaseVelocity = 0.25f;
    note.midi2 = MidiNote::Midi2Data{0, 0x9234, 0x4567, 0, 0};
    region.notes.push_back(note);
    region.umpEvents.push_back(MidiUmpEvent{
        .beat = 0.75, .words = {0x40b20700u, 0x80000000u, 0, 0}, .wordCount = 2});
    song.midiRegions.push_back(region);
    project.songs.push_back(song);

    const auto path = temporaryWAVPath("-midi-instrument");
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.targetKind = RenderTargetKind::Track;
    request.targetId = instrument.id;
    request.outputPath = path.string();
    request.sampleRate = 48000;

    std::vector<MidiCaptureSession::Event> capturedEvents;
    std::vector<MidiCaptureSession::RawEvent> capturedRawEvents;
    double observedBpm = 0.0;
    const OfflineRenderer::ProcessorFactory factory =
        [&capturedEvents, &capturedRawEvents, &observedBpm](const Project&, const MixGraph& graph, double, int,
                   std::string&) -> std::unique_ptr<OfflineProcessorSession> {
            return std::make_unique<MidiCaptureSession>(
                graph.find("audio::track:instrument"), &capturedEvents, &capturedRawEvents, &observedBpm);
        };
    const auto result = OfflineRenderer{}.render(project, {}, request, {}, nullptr, factory);
    REQUIRE(result.ok);
    REQUIRE(capturedEvents.size() == 2);
    CHECK(capturedEvents[0].noteOn);
    CHECK(capturedEvents[0].sample == 12000);
    CHECK(capturedEvents[0].pitch == 64);
    CHECK(capturedEvents[0].velocity == 0x9234 >> 9);
    CHECK_FALSE(capturedEvents[1].noteOn);
    CHECK(capturedEvents[1].sample == 48000);
    CHECK(capturedEvents[1].releaseVelocity == 0x4567 >> 9);
    REQUIRE(capturedRawEvents.size() == 1);
    CHECK(capturedRawEvents[0].sample == 18000);
    CHECK(capturedRawEvents[0].status == 0xb2);
    CHECK(capturedRawEvents[0].data1 == 7);
    CHECK(capturedRawEvents[0].data2 == 64);
    CHECK(capturedRawEvents[0].dataLength == 2);
    CHECK(observedBpm == doctest::Approx(60.0));

    std::error_code ignored;
    std::filesystem::remove(path, ignored);
}

TEST_CASE("OfflineRenderer never overwrites an existing destination") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.01});

    const auto path = temporaryWAVPath("-existing");
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

TEST_CASE("OfflineRenderer rolls back published stems when a destination appears during rendering") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.01});
    const auto firstPath = temporaryWAVPath("-race-first");
    const auto secondPath = temporaryWAVPath("-race-second");
    OfflineRenderRequest request;
    request.songIndex = 0;
    request.targets = {
        {RenderTargetKind::Click, {}, firstPath.string()},
        {RenderTargetKind::Master, {}, secondPath.string()},
    };
    bool introducedDestination = false;
    const auto result = OfflineRenderer{}.render(project, {}, request,
        [&](const OfflineRenderProgress& progress) {
            if (progress.phase == "finalizing" && !introducedDestination) {
                std::ofstream otherExport(secondPath, std::ios::binary);
                otherExport << "keep-concurrent-export";
                introducedDestination = true;
            }
        });
    CHECK(introducedDestination);
    CHECK_FALSE(result.ok);
    CHECK_FALSE(std::filesystem::exists(firstPath));
    std::ifstream otherExport(secondPath, std::ios::binary);
    const std::string contents((std::istreambuf_iterator<char>(otherExport)), {});
    CHECK(contents == "keep-concurrent-export");
    std::error_code ignored;
    std::filesystem::remove(firstPath, ignored);
    std::filesystem::remove(secondPath, ignored);
}

TEST_CASE("OfflineRenderer writes and cancels custom Unicode destinations without leaving temporary files") {
    const auto directory = temporaryWAVPath("-custom-directory").parent_path()
        / (temporaryWAVPath().stem().string() + "-exports")
        / std::filesystem::path(u8"Київ 音楽 exports");
    REQUIRE(std::filesystem::create_directories(directory));
    Project project;
    project.click.enabled = true;
    project.songs.push_back(SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.05});
    for (const auto normalization : {RenderNormalization::Off, RenderNormalization::Peak}) {
        const auto output = directory / (normalization == RenderNormalization::Off ? "plain.wav" : "normalized.wav");
        const auto utf8Path = output.u8string();
        OfflineRenderRequest request;
        request.songIndex = 0;
        request.targetKind = RenderTargetKind::Click;
        request.normalization = normalization;
        request.outputPath.assign(utf8Path.begin(), utf8Path.end());
        const auto result = OfflineRenderer{}.render(project, {}, request);
        CHECK(result.ok);
        CHECK(std::filesystem::exists(output));
        std::error_code ignored;
        std::filesystem::remove(output, ignored);
    }
    const auto cancelledOutput = directory / "cancelled.wav";
    const auto utf8Path = cancelledOutput.u8string();
    OfflineRenderRequest cancelledRequest;
    cancelledRequest.songIndex = 0;
    cancelledRequest.targetKind = RenderTargetKind::Click;
    cancelledRequest.outputPath.assign(utf8Path.begin(), utf8Path.end());
    std::atomic<bool> cancelled{false};
    const auto cancelledResult = OfflineRenderer{}.render(project, {}, cancelledRequest,
        [&](const OfflineRenderProgress&) { cancelled.store(true); }, &cancelled);
    CHECK_FALSE(cancelledResult.ok);
    CHECK(std::filesystem::is_empty(directory));
    std::error_code ignored;
    std::filesystem::remove_all(directory.parent_path(), ignored);
}
