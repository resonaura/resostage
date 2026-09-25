#include "doctest.h"
#include "resolink/ResoLinkProtocol.h"
#include "resolink/SessionClock.h"
#include "project/ProjectJson.h"
#include "project/ProjectSchema.h"

#include <atomic>
#include <chrono>
#include <thread>
#include <vector>

using namespace resostage;
using namespace resostage::resolink;

TEST_SUITE("ResoLinkProtocol") {

    TEST_CASE("ResoLinkBeacon encode and decode round-trip") {
        ResoLinkBeacon src;
        src.sequence = 42;
        src.flags = BeaconFlag::IsLeader | BeaconFlag::TransportRunning | BeaconFlag::TempoMapValid;
        src.timeSignatureNumerator = 7;
        src.timeSignatureDenominator = 8;
        src.tempoMapVersion = 3;
        src.leaderPeerId = 0xDEADBEEFCAFE0001ull;
        src.leaderMonotonicNs = 1234567890123ull;
        src.samplePosition = 96000;
        src.sampleRate = 96000.0;
        src.playheadBeats = 16.5;
        src.bpm = 138.0;

        uint8_t buffer[128];
        const size_t encodedBytes = encodeBeacon(src, buffer, sizeof(buffer));
        CHECK(encodedBytes == kResoLinkBeaconSize);

        CHECK(peekMessageType(buffer, encodedBytes) == MessageType::Beacon);

        ResoLinkBeacon dst;
        const bool ok = decodeBeacon(buffer, encodedBytes, dst);
        CHECK(ok);

        CHECK(dst.magic == kResoLinkMagic);
        CHECK(dst.version == kResoLinkVersion);
        CHECK(dst.sequence == 42);
        CHECK((dst.flags & BeaconFlag::IsLeader) != 0);
        CHECK((dst.flags & BeaconFlag::TransportRunning) != 0);
        CHECK((dst.flags & BeaconFlag::TempoMapValid) != 0);
        CHECK(dst.timeSignatureNumerator == 7);
        CHECK(dst.timeSignatureDenominator == 8);
        CHECK(dst.tempoMapVersion == 3);
        CHECK(dst.leaderPeerId == 0xDEADBEEFCAFE0001ull);
        CHECK(dst.leaderMonotonicNs == 1234567890123ull);
        CHECK(dst.samplePosition == 96000);
        CHECK(dst.sampleRate == doctest::Approx(96000.0));
        CHECK(dst.playheadBeats == doctest::Approx(16.5));
        CHECK(dst.bpm == doctest::Approx(138.0));
    }

    TEST_CASE("ResoLinkBeacon rejects corrupted packets and sanitizes non-finites") {
        uint8_t buffer[kResoLinkBeaconSize];
        ResoLinkBeacon src;
        src.sampleRate = std::numeric_limits<double>::quiet_NaN();
        src.bpm = -50.0; // invalid negative bpm
        src.playheadBeats = std::numeric_limits<double>::infinity();

        encodeBeacon(src, buffer, sizeof(buffer));

        ResoLinkBeacon dst;
        CHECK(decodeBeacon(buffer, sizeof(buffer), dst));
        CHECK(dst.sampleRate == 48000.0); // sanitized fallback
        CHECK(dst.bpm == 120.0);          // sanitized fallback
        CHECK(dst.playheadBeats == 0.0);   // sanitized fallback

        // Truncated buffer
        CHECK_FALSE(decodeBeacon(buffer, kResoLinkBeaconSize - 1, dst));

        // Bad magic
        buffer[0] = 0x00;
        CHECK_FALSE(decodeBeacon(buffer, sizeof(buffer), dst));
        CHECK(peekMessageType(buffer, sizeof(buffer)) == MessageType::Unknown);
    }

    TEST_CASE("ResoLinkPingPong encode and decode round-trip") {
        ResoLinkPingPong src;
        src.messageType = static_cast<uint16_t>(MessageType::Ping);
        src.senderPeerId = 0x1122334455667788ull;
        src.targetPeerId = 0x8877665544332211ull;
        src.pingSequence = 101;
        src.t1_sendNs = 1'000'000'000ull;
        src.t2_recvNs = 1'000'500'000ull;
        src.t3_replyNs = 1'000'550'000ull;

        uint8_t buffer[64];
        const size_t encoded = encodePingPong(src, buffer, sizeof(buffer));
        CHECK(encoded == kResoLinkPingPongSize);

        CHECK(peekMessageType(buffer, encoded) == MessageType::Ping);

        ResoLinkPingPong dst;
        CHECK(decodePingPong(buffer, encoded, dst));
        CHECK(dst.magic == kResoLinkMagic);
        CHECK(dst.version == kResoLinkVersion);
        CHECK(dst.messageType == static_cast<uint16_t>(MessageType::Ping));
        CHECK(dst.senderPeerId == 0x1122334455667788ull);
        CHECK(dst.targetPeerId == 0x8877665544332211ull);
        CHECK(dst.pingSequence == 101);
        CHECK(dst.t1_sendNs == 1'000'000'000ull);
        CHECK(dst.t2_recvNs == 1'000'500'000ull);
        CHECK(dst.t3_replyNs == 1'000'550'000ull);

        // Truncated ping pong
        CHECK_FALSE(decodePingPong(buffer, kResoLinkPingPongSize - 1, dst));
    }
}

TEST_SUITE("SessionClock") {

    TEST_CASE("SessionClock roles & initial state") {
        SessionClock clock;
        CHECK(clock.role() == SessionRole::Standalone);
        CHECK(clock.lockState() == SessionLockState::Unlocked);
        CHECK(clock.rateMultiplier() == doctest::Approx(1.0));
        CHECK_FALSE(clock.isLocked());

        clock.setRole(SessionRole::Leader);
        CHECK(clock.role() == SessionRole::Leader);
        CHECK(clock.lockState() == SessionLockState::Locked);
        CHECK(clock.rateMultiplier() == doctest::Approx(1.0));
        CHECK(clock.isLocked());

        clock.setRole(SessionRole::Follower);
        CHECK(clock.role() == SessionRole::Follower);
        CHECK(clock.lockState() == SessionLockState::Unlocked);
        CHECK_FALSE(clock.isLocked());
    }

    TEST_CASE("SessionClock follower PLL synchronization and rate slewing") {
        SessionClock clock;
        clock.setRole(SessionRole::Follower);

        uint64_t localTimeNs = 1'000'000'000ull; // 1.0s
        int64_t localSamplePos = 48000;
        const double sampleRate = 48000.0;

        ResoLinkBeacon beacon;
        beacon.leaderPeerId = 1;
        beacon.sampleRate = sampleRate;
        beacon.leaderMonotonicNs = localTimeNs; // in-sync clock
        beacon.samplePosition = 48000;

        int64_t snapPos = 0;

        // First beacon received
        bool snap = clock.onBeaconReceived(beacon, localTimeNs, localSamplePos, sampleRate, snapPos);
        CHECK_FALSE(snap);
        CHECK(clock.lockState() == SessionLockState::Acquiring);

        // Simulate 3 consecutive beacons arriving with negligible phase error (20 ms interval = 50 Hz)
        const uint64_t intervalNs = 20'000'000ull; // 20 ms
        const int64_t sampleInc = static_cast<int64_t>(0.020 * sampleRate); // 960 samples

        for (int i = 0; i < 4; ++i) {
            localTimeNs += intervalNs;
            localSamplePos += sampleInc;
            beacon.leaderMonotonicNs = localTimeNs;
            beacon.samplePosition = localSamplePos;

            snap = clock.onBeaconReceived(beacon, localTimeNs, localSamplePos, sampleRate, snapPos);
            CHECK_FALSE(snap);
        }

        CHECK(clock.lockState() == SessionLockState::Locked);
        CHECK(clock.isLocked());
        CHECK(std::abs(clock.snapshot().driftPpm) < 1.0);
        CHECK(clock.rateMultiplier() == doctest::Approx(1.0));

        // Now introduce a minor clock drift (follower is slightly behind by 0.5 ms)
        localSamplePos -= 24; // 24 samples @ 48kHz = 0.5 ms behind
        snap = clock.onBeaconReceived(beacon, localTimeNs, localSamplePos, sampleRate, snapPos);
        CHECK_FALSE(snap);
        // Rate multiplier should slew forward slightly to catch up
        CHECK(clock.rateMultiplier() > 1.0);
        CHECK(clock.snapshot().driftPpm > 0.0);
        CHECK(clock.snapshot().driftPpm <= 100.0); // bounded by maxDriftPpm
    }

    TEST_CASE("SessionClock snap on large transport seek") {
        SessionClock clock;
        clock.setRole(SessionRole::Follower);

        uint64_t localTimeNs = 1'000'000'000ull;
        int64_t localSamplePos = 48000;
        const double sampleRate = 48000.0;

        ResoLinkBeacon beacon;
        beacon.leaderPeerId = 1;
        beacon.sampleRate = sampleRate;
        beacon.leaderMonotonicNs = localTimeNs;
        beacon.samplePosition = 48000;

        int64_t snapPos = 0;
        clock.onBeaconReceived(beacon, localTimeNs, localSamplePos, sampleRate, snapPos);

        // Leader suddenly jumps to sample 960,000 (20 seconds seek!)
        beacon.samplePosition = 960000;
        const bool snapped = clock.onBeaconReceived(beacon, localTimeNs, localSamplePos, sampleRate, snapPos);
        CHECK(snapped);
        CHECK(snapPos == 960000);
        CHECK(clock.lockState() == SessionLockState::Acquiring);
    }

    TEST_CASE("SessionClock holdover and timeout expiration") {
        SessionClock clock;
        clock.setRole(SessionRole::Follower);

        uint64_t localTimeNs = 1'000'000'000ull;
        int64_t localSamplePos = 48000;
        const double sampleRate = 48000.0;

        ResoLinkBeacon beacon;
        beacon.leaderPeerId = 1;
        beacon.sampleRate = sampleRate;
        beacon.leaderMonotonicNs = localTimeNs;
        beacon.samplePosition = 48000;

        int64_t snapPos = 0;
        for (int i = 0; i < 4; ++i) {
            clock.onBeaconReceived(beacon, localTimeNs, localSamplePos, sampleRate, snapPos);
        }
        CHECK(clock.isLocked());

        // 600 ms elapses without beacon -> enters Holdover
        localTimeNs += 600'000'000ull;
        clock.update(localTimeNs);
        CHECK(clock.lockState() == SessionLockState::Holdover);
        CHECK_FALSE(clock.isLocked());

        // 2.5 seconds elapses without beacon -> enters Unlocked
        localTimeNs += 2'000'000'000ull;
        clock.update(localTimeNs);
        CHECK(clock.lockState() == SessionLockState::Unlocked);
        CHECK(clock.rateMultiplier() == doctest::Approx(1.0));
    }

    TEST_CASE("SessionClock Ping/Pong RTT calculation") {
        SessionClock clock;
        clock.setRole(SessionRole::Follower);

        ResoLinkPingPong pong;
        pong.messageType = static_cast<uint16_t>(MessageType::Pong);
        pong.t1_sendNs = 1'000'000'000ull;
        pong.t2_recvNs = 1'001'000'000ull; // 1 ms network transit
        pong.t3_replyNs = 1'001'100'000ull; // 100 µs turnaround
        const uint64_t localRecvNs = 1'002'100'000ull; // 1 ms return transit (2.0 ms RTT total)

        clock.onPongReceived(pong, localRecvNs);
        CHECK(clock.snapshot().estimatedRttMs > 0.0);
        CHECK(clock.snapshot().estimatedRttMs < 5.0);
    }

    TEST_CASE("SessionClock concurrent read/write stress") {
        SessionClock clock;
        clock.setRole(SessionRole::Follower);

        std::atomic<bool> running{true};
        std::atomic<uint64_t> readCount{0};

        // Worker thread simulating incoming beacons
        std::thread worker([&]() {
            uint64_t tNs = 1'000'000'000ull;
            int64_t sPos = 48000;
            ResoLinkBeacon b;
            b.sampleRate = 48000.0;
            int64_t snap = 0;

            for (int i = 0; i < 500 && running.load(std::memory_order_relaxed); ++i) {
                tNs += 1'000'000ull; // 1 ms
                sPos += 48;
                b.leaderMonotonicNs = tNs;
                b.samplePosition = sPos;
                clock.onBeaconReceived(b, tNs, sPos, 48000.0, snap);
                std::this_thread::yield();
            }
        });

        // Reader thread simulating real-time audio thread
        std::thread reader([&]() {
            while (running.load(std::memory_order_relaxed)) {
                const auto snap = clock.snapshot();
                CHECK(snap.rateMultiplier > 0.9);
                CHECK(snap.rateMultiplier < 1.1);
                readCount.fetch_add(1, std::memory_order_relaxed);
                if (readCount.load(std::memory_order_relaxed) > 10000) {
                    break;
                }
            }
        });

        reader.join();
        running.store(false, std::memory_order_relaxed);
        worker.join();

        CHECK(readCount.load() >= 10000);
    }
}

TEST_SUITE("ExecutionTargetProjectSchema") {

    TEST_CASE("TrackDef execution target serialization via Glaze") {
        Project proj;
        proj.name = "ResoLink Rig Demo";

        TrackDef localTrack;
        localTrack.id = "audio::track:1";
        localTrack.name = "Local Stems";
        localTrack.target = ExecutionTarget::Local;

        TrackDef remoteTrack;
        remoteTrack.id = "audio::track:2";
        remoteTrack.name = "Remote Guitar FX Peer";
        remoteTrack.target = ExecutionTarget::RemotePeer;
        remoteTrack.peerNodeId = "resolink_peer_box_b";

        proj.tracks.push_back(localTrack);
        proj.tracks.push_back(remoteTrack);

        const std::string jsonStr = serializeProjectJson(proj);
        CHECK_FALSE(jsonStr.empty());
        CHECK(jsonStr.find("remotePeer") != std::string::npos);
        CHECK(jsonStr.find("resolink_peer_box_b") != std::string::npos);

        Project parsed;
        std::string err;
        const bool ok = parseProjectJson(jsonStr, parsed, err);
        CHECK(ok);
        CHECK(err.empty());
        REQUIRE(parsed.tracks.size() == 2);
        CHECK(parsed.tracks[0].target == ExecutionTarget::Local);
        CHECK_FALSE(parsed.tracks[0].peerNodeId.has_value());

        CHECK(parsed.tracks[1].target == ExecutionTarget::RemotePeer);
        REQUIRE(parsed.tracks[1].peerNodeId.has_value());
        CHECK(*parsed.tracks[1].peerNodeId == "resolink_peer_box_b");
    }
}
