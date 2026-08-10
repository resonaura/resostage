#include "doctest.h"

#include "telemetry/SystemHealth.h"

using namespace resostage;

TEST_CASE("SystemHealth samples process RSS and free RAM") {
    SystemHealth health;
    health.noteAudioCallback();
    health.noteAudioCallback();
    health.noteUnderrun();
    health.setWebClientCount(3);

    const SystemHealthSnapshot a = health.sample();
    CHECK(a.audioCallbackCount == 2);
    CHECK(a.underrunCount == 1);
    CHECK(a.webClientCount == 3);
    CHECK(a.totalRssBytes > 0);
    // On a real macOS host both of these should be non-zero; keep free soft
    // in case of unusual sandboxing.
    CHECK(a.systemTotalBytes > 0);
}

TEST_CASE("SystemHealth CPU percent is non-negative after two samples") {
    SystemHealth health;
    (void)health.sample();
    // Burn a little CPU so the delta is measurable.
    volatile double x = 0.0;
    for (int i = 0; i < 200000; ++i)
        x += static_cast<double>(i) * 0.000001;
    (void)x;
    const SystemHealthSnapshot b = health.sample();
    CHECK(b.totalCpuPercent >= 0.0);
}

TEST_CASE("SystemHealth: the counters a dropout report is read against") {
    // Every diagnosis in this codebase's dropout history was made with these
    // numbers, and one of them was very nearly read WRONG: an underrunCount of
    // zero was taken as "no dropouts" while the render callback was quietly
    // handing the driver silent blocks. They are separate counters, they mean
    // different things, and neither implies the other.
    SystemHealth health;

    auto counts = health.sample();
    const uint64_t baseUnderruns = counts.underrunCount;
    const uint64_t baseSilent = counts.silentBlockCount;

    // A run of perfectly serviced callbacks that nonetheless produced nothing:
    // the driver was on time, so this is invisible to underrunCount.
    for (int i = 0; i < 10; ++i) {
        health.noteAudioCallback();
        health.noteSilentBlock();
    }

    counts = health.sample();
    CHECK(counts.silentBlockCount == baseSilent + 10);
    CHECK(counts.underrunCount == baseUnderruns);

    // ...and a real driver stall, which is the other one.
    health.noteUnderrun();
    counts = health.sample();
    CHECK(counts.underrunCount == baseUnderruns + 1);
    CHECK(counts.silentBlockCount == baseSilent + 10);
}

TEST_CASE("SystemHealth: the rare-event counters are live, the per-callback one is not") {
    // sample() is throttled to 1 Hz, and audioCallbackCount is deliberately
    // left stale inside that window: it ticks 50-200 times a second, and a
    // live copy made every idle telemetry frame differ from the last one --
    // which is what kept an idle app pushing megabytes a second to each
    // client. The counters that only move when something went wrong stay live,
    // because whoever is staring at the panel trying to reproduce a glitch
    // needs to see them move.
    SystemHealth health;
    const auto first = health.sample();

    for (int i = 0; i < 200; ++i)
        health.noteAudioCallback();
    health.noteSilentBlock();
    health.noteUnderrun();

    const auto second = health.sample();
    CHECK(second.audioCallbackCount == first.audioCallbackCount);
    CHECK(second.silentBlockCount == first.silentBlockCount + 1);
    CHECK(second.underrunCount == first.underrunCount + 1);
}

TEST_CASE("SystemHealth: pitch blocks are how transpose is observed at all") {
    // Transposition preserves level, is not a dropout, and disappears into
    // process CPU -- so this counter is the only evidence that a region's
    // transposer ran. It was added after transpose was found to be doing
    // nothing whatsoever, which nothing else in the app could have shown.
    SystemHealth health;
    CHECK(health.sample().pitchBlockCount == 0);

    for (int i = 0; i < 1527; ++i)
        health.notePitchBlock();

    CHECK(health.sample().pitchBlockCount == 1527);
    // A silent block is not a pitch block, and neither is a plain callback.
    health.noteAudioCallback();
    health.noteSilentBlock();
    CHECK(health.sample().pitchBlockCount == 1527);
}
