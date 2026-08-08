#include "doctest.h"

#include "ResoLightProtocol.h"

#include <cstring>
#include <string>
#include <vector>

using namespace resolight;

TEST_CASE("light frame header round-trips") {
    uint8_t buf[kLightFrameHeaderSize];
    encodeLightFrameHeader(buf, /*pixelCount*/ 120, /*channelsPerPixel*/ 3,
                            /*flags*/ 0, /*sequence*/ 0);

    LightFrameHeader h{};
    REQUIRE(decodeLightFrameHeader(buf, sizeof(buf), h));
    CHECK(h.magic == kFrameMagic);
    CHECK(h.version == kProtocolVersion);
    CHECK(h.channelsPerPixel == 3);
    CHECK(h.flags == 0);
    CHECK(h.pixelCount == 120);
}

TEST_CASE("light frame header rejects short/garbage input") {
    LightFrameHeader h{};
    uint8_t short_buf[3] = {kFrameMagic, kProtocolVersion, 3};
    CHECK_FALSE(decodeLightFrameHeader(short_buf, sizeof(short_buf), h));
    CHECK_FALSE(decodeLightFrameHeader(nullptr, 0, h));

    uint8_t bad_magic[kLightFrameHeaderSize] = {0, kProtocolVersion, 3, 0, 0, 0};
    CHECK_FALSE(decodeLightFrameHeader(bad_magic, sizeof(bad_magic), h));

    uint8_t bad_version[kLightFrameHeaderSize] = {kFrameMagic, 99, 3, 0, 0, 0};
    CHECK_FALSE(decodeLightFrameHeader(bad_version, sizeof(bad_version), h));
}

TEST_CASE("light frame payload size matches header + pixel bytes") {
    CHECK(lightFramePayloadSize(120, 3) == kLightFrameHeaderSize + 360);
    CHECK(lightFramePayloadSize(0, 3) == kLightFrameHeaderSize);
    CHECK(lightFramePayloadSize(60, 4) == kLightFrameHeaderSize + 240);
}

TEST_CASE("light frame pixel count survives the 16-bit little-endian split") {
    uint8_t buf[kLightFrameHeaderSize];
    encodeLightFrameHeader(buf, 0xABCD, 1, kFlagBlackout, /*sequence*/ 7);
    CHECK(buf[4] == 0xCD);
    CHECK(buf[5] == 0xAB);

    LightFrameHeader h{};
    REQUIRE(decodeLightFrameHeader(buf, sizeof(buf), h));
    CHECK(h.pixelCount == 0xABCD);
    CHECK(h.flags == kFlagBlackout);
}

TEST_CASE("status frame round-trips, including negative RSSI") {
    uint8_t buf[kStatusFrameSize];
    encodeStatusFrame(buf, ChipType::Esp32, /*rssiDbm*/ -62,
                       /*uptimeSec*/ 123456u, /*freeHeapBytes*/ 87654321u,
                       /*lightUdpPort*/ kDefaultLightUdpPort);

    StatusFrame s{};
    REQUIRE(decodeStatusFrame(buf, sizeof(buf), s));
    CHECK(s.chipType == static_cast<uint8_t>(ChipType::Esp32));
    CHECK(s.rssiAbs == 62);
    CHECK(s.uptimeSec == 123456u);
    CHECK(s.freeHeapBytes == 87654321u);
}

TEST_CASE("status frame clamps an out-of-range RSSI magnitude") {
    uint8_t buf[kStatusFrameSize];
    encodeStatusFrame(buf, ChipType::Esp8266, -999, 0, 0, 0);
    StatusFrame s{};
    REQUIRE(decodeStatusFrame(buf, sizeof(buf), s));
    CHECK(s.rssiAbs == 255);
    CHECK(s.chipType == static_cast<uint8_t>(ChipType::Esp8266));
}

TEST_CASE("status frame rejects wrong magic/version") {
    uint8_t buf[kStatusFrameSize];
    encodeStatusFrame(buf, ChipType::Esp32, -50, 1, 1, 0);
    buf[0] = 0x00;
    StatusFrame s{};
    CHECK_FALSE(decodeStatusFrame(buf, sizeof(buf), s));
}

TEST_CASE("discovery beacon round-trips name and mac") {
    uint8_t buf[kDiscoveryBeaconSize];
    const uint8_t mac[6] = {0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01};
    encodeDiscoveryBeacon(buf, ChipType::Esp32, mac, "ResoLight-A1B2");

    DiscoveryBeacon b{};
    REQUIRE(decodeDiscoveryBeacon(buf, sizeof(buf), b));
    CHECK(b.chipType == static_cast<uint8_t>(ChipType::Esp32));
    CHECK(std::memcmp(b.mac, mac, 6) == 0);
    CHECK(std::string(b.name) == "ResoLight-A1B2");
}

TEST_CASE("discovery beacon truncates an overlong name and stays NUL-terminated") {
    uint8_t buf[kDiscoveryBeaconSize];
    const uint8_t mac[6] = {1, 2, 3, 4, 5, 6};
    // 40 chars, longer than kDiscoveryNameSize (24, including the NUL).
    encodeDiscoveryBeacon(buf, ChipType::Esp8266, mac,
                           "ThisNameIsDefinitelyWayTooLongForTheField");

    DiscoveryBeacon b{};
    REQUIRE(decodeDiscoveryBeacon(buf, sizeof(buf), b));
    CHECK(std::strlen(b.name) == kDiscoveryNameSize - 1);
    CHECK(b.name[kDiscoveryNameSize - 1] == '\0');
}

TEST_CASE("discovery beacon rejects short input") {
    DiscoveryBeacon b{};
    uint8_t short_buf[4] = {kDiscoveryMagic, kProtocolVersion, 0, 0};
    CHECK_FALSE(decodeDiscoveryBeacon(short_buf, sizeof(short_buf), b));
}

// ── v2: sequence numbers ────────────────────────────────────────────────────
// UDP may reorder and the desktop restarts its counter whenever it reopens a
// board, so "is this frame newer" is not a plain `>`.

TEST_CASE("light frame sequence survives the 32-bit little-endian split") {
    uint8_t buf[kLightFrameHeaderSize];
    encodeLightFrameHeader(buf, 120, 3, 0, 0xDEADBEEFu);
    CHECK(buf[6] == 0xEF);
    CHECK(buf[7] == 0xBE);
    CHECK(buf[8] == 0xAD);
    CHECK(buf[9] == 0xDE);

    LightFrameHeader h{};
    REQUIRE(decodeLightFrameHeader(buf, sizeof(buf), h));
    CHECK(h.sequence == 0xDEADBEEFu);
}

TEST_CASE("a newer sequence is accepted and an older one refused") {
    CHECK(lightFrameIsNewer(2, 1));
    CHECK_FALSE(lightFrameIsNewer(1, 2));
    // Same frame arriving twice must not be shown twice.
    CHECK_FALSE(lightFrameIsNewer(5, 5));
}

TEST_CASE("sequence comparison survives 32-bit wraparound") {
    // The counter rolling over must not look like a thirty-year jump backwards.
    CHECK(lightFrameIsNewer(0u, 0xFFFFFFFFu));
    CHECK(lightFrameIsNewer(3u, 0xFFFFFFFEu));
    CHECK_FALSE(lightFrameIsNewer(0xFFFFFFFEu, 3u));
}

TEST_CASE("a restarted sender is accepted rather than locking the board out") {
    // ResoStage restarts its per-board counter at 0 on every reconnect. A board
    // that has been running for a while would otherwise reject every frame
    // until the counter climbed back past where it left off -- minutes of dark.
    CHECK(lightFrameIsNewer(0u, 1'000'000u));
    CHECK(lightFrameIsNewer(3u, 500u));
    // Just behind is still just behind, though -- that is reordering, not a
    // restart, and must be dropped.
    CHECK_FALSE(lightFrameIsNewer(990u, 1000u));
}

TEST_CASE("status frame carries the board's UDP light port") {
    uint8_t buf[kStatusFrameSize];
    encodeStatusFrame(buf, ChipType::Esp32, -40, 10, 20, kDefaultLightUdpPort);
    StatusFrame s{};
    REQUIRE(decodeStatusFrame(buf, sizeof(buf), s));
    CHECK(s.lightUdpPort == kDefaultLightUdpPort);

    // 0 means "no UDP -- keep using the WebSocket", the fallback older
    // firmware relies on.
    encodeStatusFrame(buf, ChipType::Esp8266, -40, 10, 20, 0);
    REQUIRE(decodeStatusFrame(buf, sizeof(buf), s));
    CHECK(s.lightUdpPort == 0);
}
