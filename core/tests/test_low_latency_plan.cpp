#include "doctest.h"
#include "audio/LowLatencyPlan.h"

using namespace resostage;

TEST_SUITE("LowLatencyPlan") {
    TEST_CASE("Plugin threshold bypass and send overrides") {
        std::unordered_set<uint32_t> monitoredStrips = {0}; // Track 0 is monitored

        std::vector<PluginSlotLatencyInfo> slots = {
            {0, 0, "eq", 96},         // 2 ms @ 48kHz (below 5 ms limit)
            {0, 1, "limiter", 480},    // 10 ms @ 48kHz (exceeds 5 ms limit)
            {1, 0, "reverb", 1200}     // 25 ms on unmonitored Track 1
        };

        std::vector<StripSendInfo> sends = {
            {0, 0, false}, // Track 0 ordinary send -> should be muted
            {0, 1, true},  // Track 0 lowLatencySafe send -> should be kept
            {1, 0, false}  // Track 1 send -> untouched
        };

        // When LLM is enabled with 5ms limit
        auto plan = buildLowLatencyPlan(true, 5.0, 48000.0, monitoredStrips, slots, sends);

        CHECK(plan.enabled);
        CHECK(plan.limitSamples == 240);

        // Slot 0 (EQ) is not bypassed
        CHECK_FALSE(plan.isSlotBypassed(0, 0));
        // Slot 1 (Limiter) is bypassed
        CHECK(plan.isSlotBypassed(0, 1));
        // Slot on unmonitored strip is never bypassed
        CHECK_FALSE(plan.isSlotBypassed(1, 0));

        // Send 0 on Track 0 is muted
        CHECK(plan.isSendMuted(0, 0));
        // Send 1 (safe) on Track 0 is NOT muted
        CHECK_FALSE(plan.isSendMuted(0, 1));
        // Send on Track 1 is untouched
        CHECK_FALSE(plan.isSendMuted(1, 0));

        // When LLM is disabled
        auto disabledPlan = buildLowLatencyPlan(false, 5.0, 48000.0, monitoredStrips, slots, sends);
        CHECK_FALSE(disabledPlan.isSlotBypassed(0, 1));
        CHECK_FALSE(disabledPlan.isSendMuted(0, 0));
    }
}
