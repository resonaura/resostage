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

TEST_CASE("OfflineRenderer aligns selected stems to one compensated origin") {
    Project project;
    project.name = "Aligned taps";
    project.click.enabled = true;
    project.click.output.type = OutputType::Main;
    project.songs.push_back(
        SongDef{.id = "meta::song:1", .name = "Short", .endSeconds = 0.05});

    const auto mainPath = temporaryWavPath("-aligned-main");
    const auto clickPath = temporaryWavPath("-aligned-click");
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

TEST_CASE("OfflineRenderer Leave honors declared sparse processor tails") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(
        SongDef{.id = "meta::song:1", .name = "Sparse tail", .endSeconds = 0.01});

    const auto path = temporaryWavPath("-sparse-tail");
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

TEST_CASE("OfflineRenderer creates private processor sessions and runs their strip taps") {
    Project project;
    project.click.enabled = true;
    project.songs.push_back(
        SongDef{.id = "meta::song:1", .name = "One", .endSeconds = 0.01});
    project.songs.push_back(
        SongDef{.id = "meta::song:2", .name = "Two", .endSeconds = 0.01});

    const auto path = temporaryWavPath("-processors");
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
