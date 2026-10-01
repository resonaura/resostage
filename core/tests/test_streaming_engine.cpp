/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "audio/streaming/StreamingEngine.h"
#include "project/ProjectLoader.h"

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <thread>
#include <vector>

using namespace resostage;

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

std::vector<uint8_t> makeSilentMonoWav16(int frames, uint32_t sampleRate = 48000) {
    const uint32_t dataSize = static_cast<uint32_t>(frames) * 2;
    std::vector<uint8_t> out;
    appendTag(out, "RIFF");
    appendU32(out, 36 + dataSize);
    appendTag(out, "WAVE");
    appendTag(out, "fmt ");
    appendU32(out, 16);
    appendU16(out, 1);
    appendU16(out, 1);
    appendU32(out, sampleRate);
    appendU32(out, sampleRate * 2);
    appendU16(out, 2);
    appendU16(out, 16);
    appendTag(out, "data");
    appendU32(out, dataSize);
    out.resize(out.size() + dataSize, 0);
    return out;
}

// One song, two tracks with DIFFERENT native sample rates (44.1kHz and
// 48kHz), one second each -- for the rate-change restage test below.
std::string makeMixedRateArchive() {
    namespace fs = std::filesystem;
    const std::string path = std::string(std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp") +
                              "/resoset_streaming_engine_mixed_rate_test.rsnraset";

    std::error_code ec;
    fs::remove_all(path, ec);
    fs::create_directories(fs::path(path) / "Audio", ec);

    const std::string projectJson = R"({"format":{"version":4},"name":"t","sampleRate":48000,"click":{"enabled":false,"name":"Click","channels":2,"gainDb":0,"pan":0,"mute":false,"solo":false,"output":{"type":"sends-only","target":null,"sends":[]}},"main":{"enabled":true,"name":"Main","channels":2,"gainDb":0,"pan":0,"mute":false,"solo":false,"output":{"type":"ext-out","target":"audio::out:1,audio::out:2"}},"sends":[],"tracks":[],"songs":[]})";
    std::ofstream jsonOfs(fs::path(path) / resostage::kProjectDataFileName, std::ios::binary);
    jsonOfs.write(projectJson.data(), projectJson.size());
    jsonOfs.close();

    auto wav44100 = makeSilentMonoWav16(44100, 44100);
    auto wav48000 = makeSilentMonoWav16(48000, 48000);
    std::ofstream wav1Ofs(fs::path(path) / "Audio" / "a44100.wav", std::ios::binary);
    wav1Ofs.write(reinterpret_cast<const char*>(wav44100.data()), wav44100.size());
    wav1Ofs.close();

    std::ofstream wav2Ofs(fs::path(path) / "Audio" / "b48000.wav", std::ios::binary);
    wav2Ofs.write(reinterpret_cast<const char*>(wav48000.data()), wav48000.size());
    wav2Ofs.close();

    return path;
}

std::string makeTwoSongArchive() {
    namespace fs = std::filesystem;
    const std::string path = std::string(std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp") +
                              "/resoset_streaming_engine_test.rsnraset";

    std::error_code ec;
    fs::remove_all(path, ec);
    fs::create_directories(fs::path(path) / "Audio", ec);

    const std::string projectJson = R"({"format":{"version":4},"name":"t","sampleRate":48000,"click":{"enabled":false,"name":"Click","channels":2,"gainDb":0,"pan":0,"mute":false,"solo":false,"output":{"type":"sends-only","target":null,"sends":[]}},"main":{"enabled":true,"name":"Main","channels":2,"gainDb":0,"pan":0,"mute":false,"solo":false,"output":{"type":"ext-out","target":"audio::out:1,audio::out:2"}},"sends":[],"tracks":[],"songs":[]})";
    std::ofstream jsonOfs(fs::path(path) / resostage::kProjectDataFileName, std::ios::binary);
    jsonOfs.write(projectJson.data(), projectJson.size());
    jsonOfs.close();

    auto wavA = makeSilentMonoWav16(48000);
    auto wavB = makeSilentMonoWav16(48000);
    std::ofstream wavAOfs(fs::path(path) / "Audio" / "a.wav", std::ios::binary);
    wavAOfs.write(reinterpret_cast<const char*>(wavA.data()), wavA.size());
    wavAOfs.close();

    std::ofstream wavBOfs(fs::path(path) / "Audio" / "b.wav", std::ios::binary);
    wavBOfs.write(reinterpret_cast<const char*>(wavB.data()), wavB.size());
    wavBOfs.close();

    return path;
}

} // namespace

TEST_CASE("Streaming history reuses geometry-only buffers and rebinds source IDs without stale fallback") {
    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(makeTwoSongArchive(), error));
    SongDef song; song.id = "song";
    Region a; a.id = "a"; a.trackId = "track"; a.source.file = "Audio/a.wav";
    song.regions = {a};
    StreamingEngine engine;
    engine.start(&loader);
    REQUIRE(engine.stageSong(0, song, 4096, 48000, error));
    auto original = engine.acquireActiveSong();
    auto* originalBuffer = original.region("a");
    REQUIRE(originalBuffer != nullptr);
    song.regions[0].durationSeconds = 0.25;
    song.regions[0].source.offsetSeconds = 0.1;
    CHECK(engine.activeSongMatches(0, song, 4096, 48000));
    CHECK_FALSE(engine.activeSongMatches(1, song, 4096, 48000));
    CHECK_FALSE(engine.activeSongMatches(0, song, 4096, 44100));
    song.regions[0].id = "restored";
    CHECK_FALSE(engine.activeSongMatches(0, song, 4096, 48000));
    REQUIRE(engine.rebindActiveSongAt(0, song, 4096, 48000, 8000, error));
    auto rebound = engine.acquireActiveSong();
    CHECK(rebound.region("a") == nullptr);
    CHECK(rebound.region("restored") == originalBuffer); // pooled unchanged file
    CHECK(original.region("a") == originalBuffer); // old acquired snapshot stays alive
    song.regions[0].source.file = "Audio/b.wav";
    CHECK_FALSE(engine.activeSongMatches(0, song, 4096, 48000));
    REQUIRE(engine.rebindActiveSongAt(0, song, 4096, 48000, 8000, error));
    CHECK(engine.acquireActiveSong().region("restored") != originalBuffer);
    engine.clearActiveSong();
    CHECK_FALSE(static_cast<bool>(engine.acquireActiveSong()));
    engine.stop();
}

TEST_CASE("Streaming history invalidates only incompatible warm maps including prepared windows") {
    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(makeTwoSongArchive(), error));
    SongDef a; a.id = "a";
    Region ra; ra.id = "ra"; ra.trackId = "ta"; ra.source.file = "Audio/a.wav";
    a.regions = {ra};
    SongDef b; b.id = "b";
    Region rb; rb.id = "rb"; rb.trackId = "tb"; rb.source.file = "Audio/b.wav";
    b.regions = {rb};
    StreamingEngine engine;
    engine.start(&loader);
    engine.precacheSong(0, a, 4096, 48000, engine.stageEpoch());
    engine.precacheSong(1, b, 4096, 48000, engine.stageEpoch());
    REQUIRE(engine.hasPrecacheFor(0));
    REQUIRE(engine.hasPrecacheFor(1));
    a.regions[0].source.offsetSeconds = 0.25;
    engine.invalidateIncompatibleWarmSongs({a, b}, 4096, 48000);
    CHECK_FALSE(engine.hasPrecacheFor(0));
    CHECK(engine.hasPrecacheFor(1));
    // Index-only staging also rejects stale warm sources even when the caller
    // forgot to invalidate: ordinary song selection shares this safety check.
    b.regions[0].id = "new-b";
    REQUIRE(engine.stageSong(1, b, 4096, 48000, error));
    CHECK(engine.acquireActiveSong().region("rb") == nullptr);
    CHECK(engine.acquireActiveSong().region("new-b") != nullptr);
    engine.stop();
}

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

    TrackDef trackA; trackA.id = "track_a";
    TrackDef trackB; trackB.id = "track_b";
    loader.project().tracks = { trackA, trackB };

    SongDef songA;
    songA.id = "song_a";
    Region regA;
    regA.id = "reg_a";
    regA.trackId = "track_a";
    regA.source.file = "Audio/a.wav";
    songA.regions.push_back(regA);

    SongDef songB;
    songB.id = "song_b";
    Region regB;
    regB.id = "reg_b";
    regB.trackId = "track_b";
    regB.source.file = "Audio/b.wav";
    songB.regions.push_back(regB);

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
        while (!stop.load(std::memory_order_acquire) || readsDone.load() == 0) {
            StreamingEngine::ActiveSongHandle handle = engine.acquireActiveSong();
            if (handle) {
                StreamingTrackBuffer* track = handle.region("reg_a");
                if (track == nullptr)
                    track = handle.region("reg_b");
                if (track != nullptr) {
                    track->read(channels, 256, 0);
                    readsDone.fetch_add(1, std::memory_order_relaxed);
                }
            }
            if (stop.load(std::memory_order_acquire) && stagesDone.load() > 0 && readsDone.load() > 0)
                break;
            std::this_thread::yield();
        }
    });

    writer.join();
    reader.join();
    engine.stop();

    CHECK(stagesDone.load() > 0);
    CHECK(readsDone.load() > 0);
}

// Regression coverage for AudioEngine::handleSampleRateChanged: a live device
// sample-rate change re-stages the currently active song at the new rate.
// StreamingEngine::getOrOpenFile already drops and reopens its whole file
// pool whenever the requested device rate differs from what it has cached --
// this proves that restage recomputes EVERY track's resample ratio, not just
// one, by using two tracks with different native rates (44.1kHz and 48kHz)
// and re-staging the same song at a different device rate.
TEST_CASE("StreamingEngine re-stages a song at a new device sample rate and every track recomputes its ratio") {
    const std::string path = makeMixedRateArchive();

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    TrackDef trackA;
    trackA.id = "track_a";
    TrackDef trackB;
    trackB.id = "track_b";
    loader.project().tracks = {trackA, trackB};

    SongDef song;
    song.id = "song";
    Region regA;
    regA.id = "reg_a";
    regA.trackId = "track_a";
    regA.source.file = "Audio/a44100.wav";
    Region regB;
    regB.id = "reg_b";
    regB.trackId = "track_b";
    regB.source.file = "Audio/b48000.wav";
    song.regions = {regA, regB};

    StreamingEngine engine;
    engine.start(&loader);

    std::string stageError;
    REQUIRE(engine.stageSong(0, song, 8192, 44100.0, stageError));
    {
        StreamingEngine::ActiveSongHandle handle = engine.acquireActiveSong();
        REQUIRE(handle);
        StreamingTrackBuffer* bufA = handle.track("track_a");
        StreamingTrackBuffer* bufB = handle.track("track_b");
        REQUIRE(bufA != nullptr);
        REQUIRE(bufB != nullptr);
        CHECK(std::abs(bufA->totalFrames() - 44100) <= 1); // native == device rate, 1:1
        CHECK(std::abs(bufB->totalFrames() - 44100) <= 1); // 48kHz source resampled DOWN to 44100 device frames
    }

    // Simulate a live device rate change to 48kHz: re-stage the SAME song at
    // the new rate, exactly like handleSampleRateChanged does.
    REQUIRE(engine.stageSong(0, song, 8192, 48000.0, stageError));
    {
        StreamingEngine::ActiveSongHandle handle = engine.acquireActiveSong();
        REQUIRE(handle);
        StreamingTrackBuffer* bufA = handle.track("track_a");
        StreamingTrackBuffer* bufB = handle.track("track_b");
        REQUIRE(bufA != nullptr);
        REQUIRE(bufB != nullptr);
        // Both buffers must have reopened and recomputed their ratio against
        // the NEW device rate -- not still carrying the stale 44100 ratio.
        CHECK(std::abs(bufA->totalFrames() - 48000) <= 1); // 44.1kHz source resampled UP to 48000 device frames
        CHECK(std::abs(bufB->totalFrames() - 48000) <= 1); // native == device rate again, 1:1
    }

    engine.stop();
}

// Regression coverage for the song-hop latency fix: stageSong(asyncFill=true)
// on a song whose stems were never opened before (a "hard hop") must return
// without doing the head-decode inline, and must report deferredMuteClear so
// the caller knows a background thread now owns clearing muteBeforeSwap.
TEST_CASE("StreamingEngine::stageSong(asyncFill=true) defers head-fill off the caller and eventually clears mute") {
    const std::string path = makeTwoSongArchive();

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    TrackDef trackA;
    trackA.id = "track_a";
    loader.project().tracks = {trackA};

    SongDef songA;
    songA.id = "song_a";
    Region regA;
    regA.id = "reg_a";
    regA.trackId = "track_a";
    regA.source.file = "Audio/a.wav";
    songA.regions = {regA};

    StreamingEngine engine;
    engine.start(&loader);

    std::atomic<bool> mute{false};
    bool deferredMuteClear = false;
    std::string stageError;
    REQUIRE(engine.stageSong(0, songA, 8192, 48000.0, stageError, 0.0, 0.0, &mute,
                             /*asyncFill=*/true, &deferredMuteClear));

    // This song was never opened before, so needFill was true -- the fill
    // must have been handed off, not done inline.
    CHECK(deferredMuteClear);

    // The atomic flip is still synchronous/immediate even for a hard hop.
    {
        StreamingEngine::ActiveSongHandle handle = engine.acquireActiveSong();
        REQUIRE(handle);
        CHECK(handle.track("track_a") != nullptr);
    }

    // Bounded poll instead of a fixed sleep -- the background thread should
    // clear the mute flag well within this window once it finishes decoding
    // the (tiny, test-fixture) head chunk.
    bool unmuted = false;
    for (int i = 0; i < 500 && !unmuted; ++i) {
        if (!mute.load(std::memory_order_acquire))
            unmuted = true;
        else
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    CHECK(unmuted);

    engine.stop();
}

TEST_CASE("StreamingEngine owned head-fill mailbox discards superseded cold hops") {
    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(makeTwoSongArchive(), error));
    SongDef first;
    first.id = "first";
    Region region;
    region.id = "region";
    region.trackId = "track_a";
    region.source.file = "Audio/a.wav";
    first.regions = {region};
    SongDef latest = first;
    latest.id = "latest";
    latest.regions[0].source.file = "Audio/b.wav";

    // Hold both owned refill workers until two requests have been published.
    // The RAII release also prevents failed assertions from blocking teardown.
    std::atomic<bool> allowWork{false};
    std::atomic<bool> staleMute{false};
    std::atomic<bool> latestMute{false};
    StreamingEngine engine;
    engine.start(&loader, [&] {
        while (!allowWork.load(std::memory_order_acquire))
            std::this_thread::yield();
    });
    struct ReleaseWorkers {
        std::atomic<bool>& flag;
        ~ReleaseWorkers() { flag.store(true, std::memory_order_release); }
    } release{allowWork};

    REQUIRE(engine.stageSong(0, first, 8192, 48000, error, 0, 0, &staleMute, true));
    REQUIRE(engine.stageSong(1, latest, 8192, 48000, error, 0, 0, &latestMute, true));
    CHECK(staleMute.load());
    CHECK(latestMute.load());
    allowWork.store(true, std::memory_order_release);
    for (int i = 0; i < 500 && latestMute.load(std::memory_order_acquire); ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    CHECK_FALSE(latestMute.load());
    CHECK(staleMute.load()); // The replaced request never clears somebody else's handoff.
    engine.stop();
}

TEST_CASE("StreamingEngine stop invalidates and joins queued head fills before a restart") {
    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(makeTwoSongArchive(), error));
    SongDef song;
    song.id = "song";
    Region region;
    region.id = "region";
    region.trackId = "track_a";
    region.source.file = "Audio/a.wav";
    song.regions = {region};
    std::atomic<bool> allowWork{false};
    std::atomic<bool> mute{false};
    StreamingEngine engine;
    engine.start(&loader, [&] {
        while (!allowWork.load(std::memory_order_acquire))
            std::this_thread::yield();
    });
    struct ReleaseWorkers {
        std::atomic<bool>& flag;
        ~ReleaseWorkers() { flag.store(true, std::memory_order_release); }
    } release{allowWork};
    REQUIRE(engine.stageSong(0, song, 8192, 48000, error, 0, 0, &mute, true));
    const auto epoch = engine.stageEpoch();
    std::thread shutdown([&] { engine.stop(); });
    for (int i = 0; i < 500 && engine.stageEpoch() == epoch; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    const bool invalidatedBeforeRelease = engine.stageEpoch() != epoch;
    allowWork.store(true, std::memory_order_release);
    shutdown.join();
    CHECK(invalidatedBeforeRelease);
    CHECK(mute.load()); // No abandoned fill can touch this flag after stop.
    CHECK_FALSE(engine.acquireActiveSong());

    engine.start(&loader);
    REQUIRE(engine.stageSong(0, song, 8192, 48000, error, 0, 0, &mute, true));
    for (int i = 0; i < 500 && mute.load(std::memory_order_acquire); ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    CHECK_FALSE(mute.load());
    engine.stop();
}

// The synchronous (asyncFill=false, the default) path must keep behaving
// exactly as before: fillHeadOnce runs inline, so mute is already cleared-
// by-the-caller-convention (i.e. never auto-cleared by stageSong itself) and
// deferredMuteClear is left false, matching every pre-existing call site that
// doesn't pass asyncFill.
TEST_CASE("StreamingEngine::stageSong defaults to synchronous fill and never defers mute-clear") {
    const std::string path = makeTwoSongArchive();

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    TrackDef trackA;
    trackA.id = "track_a";
    loader.project().tracks = {trackA};

    SongDef songA;
    songA.id = "song_a";
    Region regA;
    regA.id = "reg_a";
    regA.trackId = "track_a";
    regA.source.file = "Audio/a.wav";
    songA.regions = {regA};

    StreamingEngine engine;
    engine.start(&loader);

    std::atomic<bool> mute{false};
    bool deferredMuteClear = true; // must be flipped back to false
    std::string stageError;
    REQUIRE(engine.stageSong(0, songA, 8192, 48000.0, stageError, 0.0, 0.0, &mute,
                             /*asyncFill=*/false, &deferredMuteClear));

    CHECK_FALSE(deferredMuteClear);
    // stageSong sets mute true before the flip and -- in the synchronous
    // path -- never clears it itself; that stays the CALLER's job (see every
    // pre-existing call site's own streamHandoff.store(false, ...) after a
    // successful stageSong()). A regression here would mean the new
    // asyncFill plumbing leaked into the default path.
    CHECK(mute.load());

    engine.stop();
}

// The resident promoter now yields the disk when the playing song's rings run
// down (see audio/IoPressurePolicy.h). The policy itself is pinned in
// test_io_pressure_policy.cpp; what matters HERE is the failure mode that
// would be silent: a false alarm. If the pressure signal reads low on a
// perfectly healthy song, the promoter stops loading regions into RAM -- and
// residency is what speed and reverse are served from, so they would quietly
// stop working on long regions with nothing at all in the log to say why.
TEST_CASE("StreamingEngine: a well-fed song reports no disk pressure") {
    const std::string path = makeTwoSongArchive();

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    TrackDef track;
    track.id = "track_a";
    loader.project().tracks = {track};

    SongDef song;
    song.id = "song";
    Region reg;
    reg.id = "reg_a";
    reg.trackId = "track_a";
    reg.source.file = "Audio/a.wav";
    song.regions = {reg};

    StreamingEngine engine;
    // No residency, so the buffers stay on the streaming path and the workers
    // have a real ring to measure rather than skipping straight past it.
    engine.setResidentBudgetBytes(0);

    std::atomic<int> yieldCalls{0};
    engine.start(&loader, nullptr, nullptr, nullptr,
                 [&yieldCalls](bool) { yieldCalls.fetch_add(1, std::memory_order_relaxed); });

    std::string stageError;
    REQUIRE(engine.stageSong(0, song, 8192, 48000.0, stageError));

    // Let the refill workers make several passes.
    std::this_thread::sleep_for(std::chrono::milliseconds(200));

    const auto health = engine.activeBufferHealth(48000.0);
    CHECK(health.minRingFraction > kIoTightFraction);
    CHECK(engine.ioPressure() == IoPressureLevel::Healthy);
    // Nothing is starving, so the promoter was never asked to stand aside.
    CHECK(yieldCalls.load() == 0);

    engine.stop();
}

TEST_CASE("StreamingEngine: a song with nothing staged is not treated as starving") {
    // The default has to be Healthy, not Critical. An engine with no active
    // song has no ring to run down, and reading that as an emergency would
    // freeze residency for the whole time a project sits loaded but stopped --
    // which is exactly when it should be filling RAM.
    StreamingEngine engine;
    CHECK(engine.ioPressure() == IoPressureLevel::Healthy);
    CHECK(engine.activeBufferHealth(48000.0).minRingFraction == doctest::Approx(1.0));
}

TEST_CASE("StreamingEngine: seekActiveSongTo requires staged song and succeeds for empty song") {
    ProjectLoader loader;
    StreamingEngine engine;
    std::string err;

    // Unstarted / unstaged engine: seek must fail with explicit error
    CHECK_FALSE(engine.seekActiveSongTo(48000, err));
    CHECK(err == "No active song to seek");

    // Start engine with loader (must clear active)
    engine.start(&loader);
    CHECK_FALSE(engine.acquireActiveSong());
    CHECK_FALSE(engine.seekActiveSongTo(48000, err));
    CHECK(err == "No active song to seek");

    // Stage empty song (e.g. newly created default project before audio stems are added)
    SongDef song;
    song.id = "meta::song:1";
    song.bpm = 120.0;
    song.endSeconds = 128.0;
    REQUIRE(engine.stageSong(0, song, 8192, 48000.0, err));
    CHECK(static_cast<bool>(engine.acquireActiveSong()));

    // Now seekActiveSongTo must succeed with 0 errors
    err.clear();
    CHECK(engine.seekActiveSongTo(48000, err));
    CHECK(err.empty());

    engine.stop();
}
