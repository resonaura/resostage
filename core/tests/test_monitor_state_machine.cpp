#include "doctest.h"
#include "audio/MonitorSourceMux.h"

using namespace resostage;

TEST_SUITE("MonitorSourceMux") {
    TEST_CASE("Auto Input Monitoring normative truth table") {
        // R=off, I=off
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::Stopped, false, false, true) == MonitorSource::Silence);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PrePunch, false, false, true) == MonitorSource::Timeline);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PunchRecording, false, false, true) == MonitorSource::Timeline);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PostPunch, false, false, true) == MonitorSource::Timeline);

        // R=off, I=on (Manual input monitoring forces live input)
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::Stopped, false, true, true) == MonitorSource::Input);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PrePunch, false, true, true) == MonitorSource::Input);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PunchRecording, false, true, true) == MonitorSource::Input);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PostPunch, false, true, true) == MonitorSource::Input);

        // R=on, I=off, AutoInput=true (Classic punch workflow)
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::Stopped, true, false, true) == MonitorSource::Input);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PrePunch, true, false, true) == MonitorSource::Timeline);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PunchRecording, true, false, true) == MonitorSource::Input);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PostPunch, true, false, true) == MonitorSource::Timeline);

        // R=on, I=off, AutoInput=false (Rehearsal mode: hear both)
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::Stopped, true, false, false) == MonitorSource::Input);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PrePunch, true, false, false) == MonitorSource::TimelinePlusInput);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PunchRecording, true, false, false) == MonitorSource::Input);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PostPunch, true, false, false) == MonitorSource::TimelinePlusInput);

        // R=on, I=on (Both active: input monitoring overrides)
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::Stopped, true, true, true) == MonitorSource::Input);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PrePunch, true, true, true) == MonitorSource::Input);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PunchRecording, true, true, true) == MonitorSource::Input);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PostPunch, true, true, true) == MonitorSource::Input);

        // Hardware direct monitoring disables software monitor feed to prevent comb-filtering
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::Stopped, true, true, true, MonitorBackend::HardwareDirect) == MonitorSource::Silence);
        CHECK(computeEffectiveMonitorSource(TransportMonitorPhase::PunchRecording, true, true, true, MonitorBackend::HardwareDirect) == MonitorSource::Timeline);
    }

    TEST_CASE("Sub-block punch partitioning") {
        PunchSubBlock subBlocks[2];
        int count = 0;

        // Block wholly before punch (punch at 1000..2000, block 0..512)
        partitionPunchBlock(0, 512, true, true, true, 1000, 2000, subBlocks, count);
        REQUIRE(count == 1);
        CHECK(subBlocks[0].offset == 0);
        CHECK(subBlocks[0].length == 512);
        CHECK(subBlocks[0].phase == TransportMonitorPhase::PrePunch);

        // Block straddles punch-in (punch at 1000..2000, block 800..1312)
        partitionPunchBlock(800, 512, true, true, true, 1000, 2000, subBlocks, count);
        REQUIRE(count == 2);
        CHECK(subBlocks[0].offset == 0);
        CHECK(subBlocks[0].length == 200); // 1000 - 800
        CHECK(subBlocks[0].phase == TransportMonitorPhase::PrePunch);
        CHECK(subBlocks[1].offset == 200);
        CHECK(subBlocks[1].length == 312); // 512 - 200
        CHECK(subBlocks[1].phase == TransportMonitorPhase::PunchRecording);

        // Block wholly inside punch (punch at 1000..2000, block 1200..1712)
        partitionPunchBlock(1200, 512, true, true, true, 1000, 2000, subBlocks, count);
        REQUIRE(count == 1);
        CHECK(subBlocks[0].offset == 0);
        CHECK(subBlocks[0].length == 512);
        CHECK(subBlocks[0].phase == TransportMonitorPhase::PunchRecording);

        // Block straddles punch-out (punch at 1000..2000, block 1800..2312)
        partitionPunchBlock(1800, 512, true, true, true, 1000, 2000, subBlocks, count);
        REQUIRE(count == 2);
        CHECK(subBlocks[0].offset == 0);
        CHECK(subBlocks[0].length == 200); // 2000 - 1800
        CHECK(subBlocks[0].phase == TransportMonitorPhase::PunchRecording);
        CHECK(subBlocks[1].offset == 200);
        CHECK(subBlocks[1].length == 312);
        CHECK(subBlocks[1].phase == TransportMonitorPhase::PostPunch);

        // Block wholly after punch (punch at 1000..2000, block 2500..3012)
        partitionPunchBlock(2500, 512, true, true, true, 1000, 2000, subBlocks, count);
        REQUIRE(count == 1);
        CHECK(subBlocks[0].offset == 0);
        CHECK(subBlocks[0].length == 512);
        CHECK(subBlocks[0].phase == TransportMonitorPhase::PostPunch);
    }
}
