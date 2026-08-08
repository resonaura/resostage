#pragma once
// Shared, hand-synchronized wire format between ResoStage's server-side
// hardware transport (core/app/light/LightHardwareServer.cpp) and the
// ResoLight ESP32/ESP8266 firmware (resolight/firmware/src/main.cpp). Plain C++17,
// header-only, no STL containers beyond fixed-size arrays and <cstdint> --
// this file is compiled unmodified by BOTH a desktop toolchain (as part of
// resostage_engine) and the Arduino/ESP-IDF toolchain (PlatformIO), so it
// must stay within the intersection of what both accept. Whenever this
// format changes, both sides rebuild from the same file -- there is no
// separate hand-ported copy to keep in sync, unlike the JS/C++ math
// duplication elsewhere in this project (see RESTORE_POINT.md): here both
// sides are already C++, so sharing the literal header is strictly better.
//
// Transport shape: ResoStage is the WebSocket CLIENT, dialing OUT to each
// configured fixture's IP -- the ESP board runs a tiny WS SERVER. This
// keeps ResoStage in control of connection lifecycle/backoff for a rig of
// many boards, needs no port-forwarding/NAT consideration (everything is
// one LAN), and matches how the operator actually configures a rig: type
// in each bar's IP once, ResoStage does the rest. All frames are WS
// *binary* -- never text/JSON -- to stay allocation-free on the ESP side
// and minimize both parse cost and on-wire size at up to ~60Hz.

#include <cstddef>
#include <cstdint>

namespace resolight {

// v2: light frames carry a sequence number and are normally delivered over
// UDP rather than the WebSocket. Both sides compile this header, so both
// rebuild together -- a board flashed with v1 firmware will reject v2 frames
// outright rather than misinterpret them.
inline constexpr uint8_t kProtocolVersion = 2;

// Default TCP port the board's WS server listens on for the light-frame
// connection (ResoStage dials this). Configurable per-fixture in ResoStage
// if a board is set up on a non-default port.
inline constexpr uint16_t kDefaultBoardPort = 7862;
inline constexpr const char* kLightWsPath = "/light";

// UDP port the board listens on for LIGHT FRAMES (see the transport note
// below). Separate from kDiscoveryPort, which is a LAN broadcast the board
// SENDS; this one it receives, unicast.
inline constexpr uint16_t kDefaultLightUdpPort = 7863;

// ---- Light frame: server -> board (lighting data) -------------------------
//
// Transport: UDP unicast, with the WebSocket kept as a fallback for boards
// that have not reported a UDP port yet.
//
// Why not TCP/WebSocket for the frames themselves: this is periodic
// full-state data at 60 Hz. Every frame supersedes the one before it, so a
// lost frame must simply be skipped -- but TCP cannot skip. It retransmits
// the stale frame and holds every later frame behind it (head-of-line
// blocking), and lwIP's retransmit timeout is in the hundreds of
// milliseconds, i.e. twenty-odd frames of frozen light for one dropped
// packet. UDP turns that same loss into one missed frame, 16 ms, usually
// invisible. It is also markedly cheaper on the ESP's network stack, and it
// lets the desktop send straight from the light engine's own thread instead
// of handing the frame to a service loop and waiting to be called back.
//
// Deliberately NOT compressed. At 120 pixels x 3 channels a frame is 370
// bytes -- one packet, well inside any Wi-Fi MTU. Compression cannot make
// that fewer than one packet, so it would buy no latency at all while
// costing the ESP a decompression pass. It only starts to be worth
// considering past ~490 pixels per board, where a frame stops fitting in a
// single datagram.

inline constexpr uint8_t kFrameMagic = 0x52; // 'R'

// Fixed 10-byte header, immediately followed by pixelCount * channelsPerPixel
// raw bytes (channel order is always R,G,B[,W] per pixel -- no per-pixel
// striding tricks).
struct LightFrameHeader {
    uint8_t magic;            // kFrameMagic
    uint8_t version;          // kProtocolVersion
    uint8_t channelsPerPixel; // 1 = dimmer, 3 = RGB, 4 = RGBW
    uint8_t flags;            // bit0 = kFlagBlackout (ignore pixel data, force off)
    uint16_t pixelCount;      // little-endian
    // Per-board frame counter, little-endian, wrapping. UDP may reorder, and
    // a reordered frame is a frame from the PAST -- showing it would be a
    // visible stutter. See lightFrameIsNewer().
    uint32_t sequence;
};
inline constexpr size_t kLightFrameHeaderSize = 10;
inline constexpr uint8_t kFlagBlackout = 0x01;

inline constexpr size_t lightFramePayloadSize(uint16_t pixelCount,
                                               uint8_t channelsPerPixel) {
    return kLightFrameHeaderSize +
           static_cast<size_t>(pixelCount) * static_cast<size_t>(channelsPerPixel);
}

// True when `sequence` should be accepted over `lastAccepted`.
//
// Signed wraparound arithmetic, so the counter rolling over 2^32 is a
// non-event. The backward-jump escape hatch exists because the desktop
// restarts its counter at 0 whenever it reopens a board: without it a board
// that had been running for a while would reject every frame from a freshly
// restarted ResoStage until the counter climbed back past where it left off.
inline constexpr int32_t kSequenceRestartGap = -256;

inline bool lightFrameIsNewer(uint32_t sequence, uint32_t lastAccepted) {
    const int32_t delta = static_cast<int32_t>(sequence - lastAccepted);
    return delta > 0 || delta < kSequenceRestartGap;
}

// Encodes a LightFrameHeader into the first kLightFrameHeaderSize bytes of
// `out` (caller-owned buffer, must be at least kLightFrameHeaderSize bytes;
// pixel bytes follow immediately after, written separately by the caller).
inline void encodeLightFrameHeader(uint8_t* out, uint16_t pixelCount,
                                    uint8_t channelsPerPixel, uint8_t flags,
                                    uint32_t sequence) {
    out[0] = kFrameMagic;
    out[1] = kProtocolVersion;
    out[2] = channelsPerPixel;
    out[3] = flags;
    out[4] = static_cast<uint8_t>(pixelCount & 0xFF);
    out[5] = static_cast<uint8_t>((pixelCount >> 8) & 0xFF);
    out[6] = static_cast<uint8_t>(sequence & 0xFF);
    out[7] = static_cast<uint8_t>((sequence >> 8) & 0xFF);
    out[8] = static_cast<uint8_t>((sequence >> 16) & 0xFF);
    out[9] = static_cast<uint8_t>((sequence >> 24) & 0xFF);
}

// Returns true and fills `outHeader` if `data` starts with a valid header;
// false (leaves outHeader untouched) on magic/version mismatch or short
// read. Does not validate that `size` also covers the pixel payload --
// callers compare against lightFramePayloadSize(outHeader.pixelCount, ...)
// themselves once they know channelsPerPixel.
inline bool decodeLightFrameHeader(const uint8_t* data, size_t size,
                                    LightFrameHeader& outHeader) {
    if (data == nullptr || size < kLightFrameHeaderSize) return false;
    if (data[0] != kFrameMagic || data[1] != kProtocolVersion) return false;
    outHeader.magic = data[0];
    outHeader.version = data[1];
    outHeader.channelsPerPixel = data[2];
    outHeader.flags = data[3];
    outHeader.pixelCount = static_cast<uint16_t>(
        static_cast<unsigned>(data[4]) | (static_cast<unsigned>(data[5]) << 8));
    outHeader.sequence =
        static_cast<uint32_t>(data[6]) | (static_cast<uint32_t>(data[7]) << 8) |
        (static_cast<uint32_t>(data[8]) << 16) | (static_cast<uint32_t>(data[9]) << 24);
    return true;
}

// ---- WS binary frame: board -> server (status heartbeat) ------------------
// Sent by the board on its own slow cadence (a few Hz at most -- purely
// informational for the ResoStage UI's "hardware attached" status, never on
// the lighting-frame critical path).

inline constexpr uint8_t kStatusMagic = 0x48; // 'H'

enum class ChipType : uint8_t { Esp32 = 0, Esp8266 = 1, Unknown = 255 };

struct StatusFrame {
    uint8_t magic;   // kStatusMagic
    uint8_t version; // kProtocolVersion
    uint8_t chipType; // ChipType
    uint8_t rssiAbs;  // abs(RSSI dBm) -- RSSI is never positive, so this fits a byte
    uint32_t uptimeSec;
    uint32_t freeHeapBytes;
    // Port this board is listening on for UDP light frames, or 0 for "I do
    // not accept them -- keep sending over the WebSocket". This is what makes
    // the UDP switch a per-board negotiation rather than a flag day: the
    // desktop only starts sending datagrams once a board has said where.
    uint16_t lightUdpPort;
};
inline constexpr size_t kStatusFrameSize = 14;

inline void encodeStatusFrame(uint8_t* out, ChipType chip, int rssiDbm,
                               uint32_t uptimeSec, uint32_t freeHeapBytes,
                               uint16_t lightUdpPort) {
    const int rssiAbs = rssiDbm < 0 ? -rssiDbm : rssiDbm;
    out[0] = kStatusMagic;
    out[1] = kProtocolVersion;
    out[2] = static_cast<uint8_t>(chip);
    out[3] = static_cast<uint8_t>(rssiAbs > 255 ? 255 : rssiAbs);
    out[4] = static_cast<uint8_t>(uptimeSec & 0xFF);
    out[5] = static_cast<uint8_t>((uptimeSec >> 8) & 0xFF);
    out[6] = static_cast<uint8_t>((uptimeSec >> 16) & 0xFF);
    out[7] = static_cast<uint8_t>((uptimeSec >> 24) & 0xFF);
    out[8] = static_cast<uint8_t>(freeHeapBytes & 0xFF);
    out[9] = static_cast<uint8_t>((freeHeapBytes >> 8) & 0xFF);
    out[10] = static_cast<uint8_t>((freeHeapBytes >> 16) & 0xFF);
    out[11] = static_cast<uint8_t>((freeHeapBytes >> 24) & 0xFF);
    out[12] = static_cast<uint8_t>(lightUdpPort & 0xFF);
    out[13] = static_cast<uint8_t>((lightUdpPort >> 8) & 0xFF);
}

inline bool decodeStatusFrame(const uint8_t* data, size_t size,
                               StatusFrame& outStatus) {
    if (data == nullptr || size < kStatusFrameSize) return false;
    if (data[0] != kStatusMagic || data[1] != kProtocolVersion) return false;
    outStatus.magic = data[0];
    outStatus.version = data[1];
    outStatus.chipType = data[2];
    outStatus.rssiAbs = data[3];
    outStatus.uptimeSec =
        static_cast<uint32_t>(data[4]) | (static_cast<uint32_t>(data[5]) << 8) |
        (static_cast<uint32_t>(data[6]) << 16) | (static_cast<uint32_t>(data[7]) << 24);
    outStatus.freeHeapBytes =
        static_cast<uint32_t>(data[8]) | (static_cast<uint32_t>(data[9]) << 8) |
        (static_cast<uint32_t>(data[10]) << 16) | (static_cast<uint32_t>(data[11]) << 24);
    outStatus.lightUdpPort = static_cast<uint16_t>(
        static_cast<unsigned>(data[12]) | (static_cast<unsigned>(data[13]) << 8));
    return true;
}

// ---- UDP discovery beacon: board -> LAN broadcast --------------------------
// Boards broadcast this every kDiscoveryIntervalMs to kDiscoveryPort so
// ResoStage can find not-yet-paired hardware without the operator having to
// know its IP in advance. ResoStage never has to send anything for this to
// work (a purely passive listener) -- simpler firewall/NAT story than a
// request/response discovery protocol, and entirely adequate for a handful
// of boards on one LAN re-announcing every couple of seconds.

inline constexpr uint16_t kDiscoveryPort = 42424;
inline constexpr uint32_t kDiscoveryIntervalMs = 2000;
inline constexpr uint8_t kDiscoveryMagic = 0x44; // 'D'
inline constexpr size_t kDiscoveryNameSize = 24; // includes NUL terminator

struct DiscoveryBeacon {
    uint8_t magic;   // kDiscoveryMagic
    uint8_t version; // kProtocolVersion
    uint8_t chipType; // ChipType
    uint8_t mac[6];
    char name[kDiscoveryNameSize]; // NUL-terminated, e.g. "ResoLight-A1B2"
};
inline constexpr size_t kDiscoveryBeaconSize = 3 + 6 + kDiscoveryNameSize;

inline void encodeDiscoveryBeacon(uint8_t* out, ChipType chip,
                                   const uint8_t mac[6], const char* name) {
    out[0] = kDiscoveryMagic;
    out[1] = kProtocolVersion;
    out[2] = static_cast<uint8_t>(chip);
    for (int i = 0; i < 6; ++i) out[3 + i] = mac[i];
    const size_t nameOff = 9;
    size_t i = 0;
    for (; i + 1 < kDiscoveryNameSize && name[i] != '\0'; ++i)
        out[nameOff + i] = static_cast<uint8_t>(name[i]);
    for (; i < kDiscoveryNameSize; ++i) out[nameOff + i] = 0;
}

inline bool decodeDiscoveryBeacon(const uint8_t* data, size_t size,
                                   DiscoveryBeacon& outBeacon) {
    if (data == nullptr || size < kDiscoveryBeaconSize) return false;
    if (data[0] != kDiscoveryMagic || data[1] != kProtocolVersion) return false;
    outBeacon.magic = data[0];
    outBeacon.version = data[1];
    outBeacon.chipType = data[2];
    for (int i = 0; i < 6; ++i) outBeacon.mac[i] = data[3 + i];
    for (size_t i = 0; i < kDiscoveryNameSize; ++i)
        outBeacon.name[i] = static_cast<char>(data[9 + i]);
    outBeacon.name[kDiscoveryNameSize - 1] = '\0'; // defensive, even if malformed
    return true;
}

} // namespace resolight
