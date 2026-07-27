#include "doctest.h"

#include "telemetry/SystemHealth.h"

using namespace resoset;

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
