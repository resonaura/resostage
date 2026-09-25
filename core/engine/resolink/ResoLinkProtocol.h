#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace resostage {

/**
 * ResoLink: Ultra-low latency, Core-to-Core multi-machine session protocol.
 *
 * Designed for synchronized playback, redundant failover, and distributed
 * audio/lighting rigs across multiple ResoStage instances.
 */
namespace resolink {

inline constexpr uint32_t kResoLinkMagic = 0x52534C4Bu; // 'RSLK' in ASCII
inline constexpr uint16_t kResoLinkVersion = 1;
inline constexpr uint16_t kDefaultResoLinkPort = 28992;

enum class MessageType : uint16_t {
    Unknown = 0,
    Beacon = 1,
    Ping = 2,
    Pong = 3,
};

namespace BeaconFlag {
    inline constexpr uint16_t IsLeader = 1u << 0;
    inline constexpr uint16_t TransportRunning = 1u << 1;
    inline constexpr uint16_t TempoMapValid = 1u << 2;
    inline constexpr uint16_t Seeking = 1u << 3;
} // namespace BeaconFlag

#pragma pack(push, 1)

struct ResoLinkBeacon {
    uint32_t magic = kResoLinkMagic;
    uint16_t version = kResoLinkVersion;
    uint16_t messageType = static_cast<uint16_t>(MessageType::Beacon);
    uint32_t sequence = 0;
    uint16_t flags = 0;
    uint16_t timeSignatureNumerator = 4;
    uint16_t timeSignatureDenominator = 4;
    uint16_t reserved = 0;
    uint32_t tempoMapVersion = 0;
    uint64_t leaderPeerId = 0;
    uint64_t leaderMonotonicNs = 0;
    int64_t samplePosition = 0;
    double sampleRate = 48000.0;
    double playheadBeats = 0.0;
    double bpm = 120.0;
};

inline constexpr size_t kResoLinkBeaconSize = 72;
static_assert(sizeof(ResoLinkBeacon) == kResoLinkBeaconSize, "ResoLinkBeacon size mismatch");

struct ResoLinkPingPong {
    uint32_t magic = kResoLinkMagic;
    uint16_t version = kResoLinkVersion;
    uint16_t messageType = static_cast<uint16_t>(MessageType::Ping);
    uint64_t senderPeerId = 0;
    uint64_t targetPeerId = 0;
    uint32_t pingSequence = 0;
    uint32_t reserved = 0;
    uint64_t t1_sendNs = 0;
    uint64_t t2_recvNs = 0;
    uint64_t t3_replyNs = 0;
};

inline constexpr size_t kResoLinkPingPongSize = 56;
static_assert(sizeof(ResoLinkPingPong) == kResoLinkPingPongSize, "ResoLinkPingPong size mismatch");

#pragma pack(pop)

// Endian-safe serialization helpers (Little-Endian)
inline void writeU16LE(uint8_t* dest, uint16_t v) noexcept {
    dest[0] = static_cast<uint8_t>(v & 0xFFu);
    dest[1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
}

inline void writeU32LE(uint8_t* dest, uint32_t v) noexcept {
    dest[0] = static_cast<uint8_t>(v & 0xFFu);
    dest[1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
    dest[2] = static_cast<uint8_t>((v >> 16) & 0xFFu);
    dest[3] = static_cast<uint8_t>((v >> 24) & 0xFFu);
}

inline void writeU64LE(uint8_t* dest, uint64_t v) noexcept {
    for (size_t i = 0; i < 8; ++i) {
        dest[i] = static_cast<uint8_t>((v >> (i * 8)) & 0xFFu);
    }
}

inline void writeDoubleLE(uint8_t* dest, double v) noexcept {
    uint64_t u;
    std::memcpy(&u, &v, sizeof(double));
    writeU64LE(dest, u);
}

inline uint16_t readU16LE(const uint8_t* src) noexcept {
    return static_cast<uint16_t>(src[0]) |
           (static_cast<uint16_t>(src[1]) << 8);
}

inline uint32_t readU32LE(const uint8_t* src) noexcept {
    return static_cast<uint32_t>(src[0]) |
           (static_cast<uint32_t>(src[1]) << 8) |
           (static_cast<uint32_t>(src[2]) << 16) |
           (static_cast<uint32_t>(src[3]) << 24);
}

inline uint64_t readU64LE(const uint8_t* src) noexcept {
    uint64_t v = 0;
    for (size_t i = 0; i < 8; ++i) {
        v |= (static_cast<uint64_t>(src[i]) << (i * 8));
    }
    return v;
}

inline double readDoubleLE(const uint8_t* src) noexcept {
    uint64_t u = readU64LE(src);
    double v;
    std::memcpy(&v, &u, sizeof(double));
    return v;
}

inline MessageType peekMessageType(const uint8_t* data, size_t length) noexcept {
    if (length < 8) return MessageType::Unknown;
    if (readU32LE(data) != kResoLinkMagic) return MessageType::Unknown;
    if (readU16LE(data + 4) != kResoLinkVersion) return MessageType::Unknown;
    return static_cast<MessageType>(readU16LE(data + 6));
}

inline size_t encodeBeacon(const ResoLinkBeacon& b, uint8_t* out, size_t capacity) noexcept {
    if (capacity < kResoLinkBeaconSize) return 0;
    writeU32LE(out + 0, b.magic);
    writeU16LE(out + 4, b.version);
    writeU16LE(out + 6, b.messageType);
    writeU32LE(out + 8, b.sequence);
    writeU16LE(out + 12, b.flags);
    writeU16LE(out + 14, b.timeSignatureNumerator);
    writeU16LE(out + 16, b.timeSignatureDenominator);
    writeU16LE(out + 18, b.reserved);
    writeU32LE(out + 20, b.tempoMapVersion);
    writeU64LE(out + 24, b.leaderPeerId);
    writeU64LE(out + 32, b.leaderMonotonicNs);
    writeU64LE(out + 40, static_cast<uint64_t>(b.samplePosition));
    writeDoubleLE(out + 48, std::isfinite(b.sampleRate) && b.sampleRate > 0.0 ? b.sampleRate : 48000.0);
    writeDoubleLE(out + 56, std::isfinite(b.playheadBeats) ? b.playheadBeats : 0.0);
    writeDoubleLE(out + 64, std::isfinite(b.bpm) && b.bpm > 0.0 ? b.bpm : 120.0);
    return kResoLinkBeaconSize;
}

inline bool decodeBeacon(const uint8_t* data, size_t length, ResoLinkBeacon& out) noexcept {
    if (length < kResoLinkBeaconSize) return false;
    out.magic = readU32LE(data + 0);
    if (out.magic != kResoLinkMagic) return false;
    out.version = readU16LE(data + 4);
    if (out.version != kResoLinkVersion) return false;
    out.messageType = readU16LE(data + 6);
    if (out.messageType != static_cast<uint16_t>(MessageType::Beacon)) return false;
    out.sequence = readU32LE(data + 8);
    out.flags = readU16LE(data + 12);
    out.timeSignatureNumerator = readU16LE(data + 14);
    out.timeSignatureDenominator = readU16LE(data + 16);
    out.reserved = readU16LE(data + 18);
    out.tempoMapVersion = readU32LE(data + 20);
    out.leaderPeerId = readU64LE(data + 24);
    out.leaderMonotonicNs = readU64LE(data + 32);
    out.samplePosition = static_cast<int64_t>(readU64LE(data + 40));
    out.sampleRate = readDoubleLE(data + 48);
    out.playheadBeats = readDoubleLE(data + 56);
    out.bpm = readDoubleLE(data + 64);

    if (!std::isfinite(out.sampleRate) || out.sampleRate <= 0.0) out.sampleRate = 48000.0;
    if (!std::isfinite(out.playheadBeats)) out.playheadBeats = 0.0;
    if (!std::isfinite(out.bpm) || out.bpm <= 0.0) out.bpm = 120.0;
    if (out.timeSignatureNumerator == 0) out.timeSignatureNumerator = 4;
    if (out.timeSignatureDenominator == 0) out.timeSignatureDenominator = 4;
    return true;
}

inline size_t encodePingPong(const ResoLinkPingPong& p, uint8_t* out, size_t capacity) noexcept {
    if (capacity < kResoLinkPingPongSize) return 0;
    writeU32LE(out + 0, p.magic);
    writeU16LE(out + 4, p.version);
    writeU16LE(out + 6, p.messageType);
    writeU64LE(out + 8, p.senderPeerId);
    writeU64LE(out + 16, p.targetPeerId);
    writeU32LE(out + 24, p.pingSequence);
    writeU32LE(out + 28, p.reserved);
    writeU64LE(out + 32, p.t1_sendNs);
    writeU64LE(out + 40, p.t2_recvNs);
    writeU64LE(out + 48, p.t3_replyNs);
    return kResoLinkPingPongSize;
}

inline bool decodePingPong(const uint8_t* data, size_t length, ResoLinkPingPong& out) noexcept {
    if (length < kResoLinkPingPongSize) return false;
    out.magic = readU32LE(data + 0);
    if (out.magic != kResoLinkMagic) return false;
    out.version = readU16LE(data + 4);
    if (out.version != kResoLinkVersion) return false;
    out.messageType = readU16LE(data + 6);
    if (out.messageType != static_cast<uint16_t>(MessageType::Ping) &&
        out.messageType != static_cast<uint16_t>(MessageType::Pong)) {
        return false;
    }
    out.senderPeerId = readU64LE(data + 8);
    out.targetPeerId = readU64LE(data + 16);
    out.pingSequence = readU32LE(data + 24);
    out.reserved = readU32LE(data + 28);
    out.t1_sendNs = readU64LE(data + 32);
    out.t2_recvNs = readU64LE(data + 40);
    out.t3_replyNs = readU64LE(data + 48);
    return true;
}

} // namespace resolink
} // namespace resostage
