#include "doctest.h"

#include "audio/StreamingEngine.h"
#include "miniz.h"
#include "project/ProjectLoader.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>

using namespace resoset;

namespace {

void appendU32(std::vector<uint8_t>& b, uint32_t v) {
    b.push_back(static_cast<uint8_t>(v & 0xFF));
    b.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
    b.push_back(static_cast<uint8_t>((v >> 16) & 0xFF));
    b.push_back(static_cast<uint8_t>((v >> 24) & 0xFF));
}
void appendU16(std::vector<uint8_t>& b, uint16_t v) {
    b.push_back(static_cast<uint8_t>(v & 0xFF));
    b.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
}
void appendTag(std::vector<uint8_t>& b, const char* tag) {
    b.insert(b.end(), tag, tag + 4);
}

std::vector<uint8_t> makeSilentMonoWav16(int frames) {
    const uint32_t dataSize = static_cast<uint32_t>(frames) * 2;
    std::vector<uint8_t> out;
    appendTag(out, "RIFF");
    appendU32(out, 36 + dataSize);
    appendTag(out, "WAVE");
    appendTag(out, "fmt ");
    appendU32(out, 16);
    appendU16(out, 1);
    appendU16(out, 1);
    appendU32(out, 48000);
    appendU32(out, 48000 * 2);
    appendU16(out, 2);
    appendU16(out, 16);
    appendTag(out, "data");
    appendU32(out, dataSize);
    out.resize(out.size() + dataSize, 0);
    return out;
}

// Two songs, one mono track each, in one archive.
std::string makeTwoSongArchive() {
    const std::string path = std::string(std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp") +
                              "/resoset_streaming_engine_test.rsnraset";

    mz_zip_archive zip;
    std::memset(&zip, 0, sizeof(zip));
    mz_zip_writer_init_file(&zip, path.c_str(), 0);

    const std::string projectJson = R"({"formatVersion":1,"name":"t","sampleRate":48000,"busses":[],"songs":[]})";
    mz_zip_writer_add_mem(&zip, "project.json", projectJson.data(), projectJson.size(), MZ_BEST_SPEED);

    auto wavA = makeSilentMonoWav16(48000); // 1s
    auto wavB = makeSilentMonoWav16(48000);
    mz_zip_writer_add_mem(&zip, "Audio/a.wav", wavA.data(), wavA.size(), MZ_BEST_SPEED);
    mz_zip_writer_add_mem(&zip, "Audio/b.wav", wavB.data(), wavB.size(), MZ_BEST_SPEED);

    mz_zip_writer_finalize_archive(&zip);
    mz_zip_writer_end(&zip);
    return path;
}

} // namespace

TEST_CASE("StreamingEngine survives concurrent stageSong() and acquireActiveSong()/read() without crashing") {
    // Regression coverage for the exact bug class caught in RoutingEngine:
    // a raw-pointer-swap-plus-manual-delete design that "should" be safe
    // because the caller stops playback first. Here we deliberately do NOT
    // respect that discipline -- stageSong() is hammered concurrently with
    // audio-thread-style reads -- to prove the shared_ptr-based handle holds
    // up even without it.
    const std::string path = makeTwoSongArchive();

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    SongDef songA;
    songA.id = "song_a";
    TrackDef trackA;
    trackA.id = "track_a";
    trackA.file = "Audio/a.wav";
    songA.tracks.push_back(trackA);

    SongDef songB;
    songB.id = "song_b";
    TrackDef trackB;
    trackB.id = "track_b";
    trackB.file = "Audio/b.wav";
    songB.tracks.push_back(trackB);

    StreamingEngine engine;
    engine.start(&loader);

    std::atomic<bool> stop{false};
    std::atomic<int> stagesDone{0};
    std::atomic<int> readsDone{0};

    std::thread writer([&] {
        for (int i = 0; i < 500 && !stop.load(); ++i) {
            std::string err;
            const bool ok = (i % 2 == 0) ? engine.stageSong(0, songA, 4096, 48000.0, err)
                                          : engine.stageSong(1, songB, 4096, 48000.0, err);
            if (ok)
                stagesDone.fetch_add(1, std::memory_order_relaxed);
        }
        stop.store(true, std::memory_order_release);
    });

    std::thread reader([&] {
        std::vector<float> buf(256);
        float* channels[1] = {buf.data()};
        while (!stop.load(std::memory_order_acquire)) {
            StreamingEngine::ActiveSongHandle handle = engine.acquireActiveSong();
            if (handle) {
                StreamingTrackBuffer* track = handle.track("track_a");
                if (track == nullptr)
                    track = handle.track("track_b");
                if (track != nullptr) {
                    track->read(channels, 256, 0);
                    readsDone.fetch_add(1, std::memory_order_relaxed);
                }
            }
        }
    });

    writer.join();
    reader.join();
    engine.stop();

    CHECK(stagesDone.load() > 0);
    CHECK(readsDone.load() > 0);
}
