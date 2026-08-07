// Minimal UUIDv7 (RFC 9562) generator -- time-ordered so newly-created
// regions/lightCues sort naturally and stay stable across renumbering,
// unlike the old "reg_song_1_trk_4"-style hand-built ids. No external
// dependency (deliberately not juce::Uuid, which is v4/random and would
// pull JUCE into this headless schema header) -- just <random>/<chrono>.
#pragma once

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <random>
#include <string>

namespace resostage {

// Thread-safe (each thread gets its own engine), monotonic-enough for a
// project-editing UI: collisions would require the same thread generating
// two ids within the same millisecond AND rolling identical 74 random bits.
inline std::string generateUuidV7() {
    thread_local std::mt19937_64 rng{std::random_device{}()};

    const uint64_t unixTsMs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count());

    std::uniform_int_distribution<uint64_t> dist;
    const uint64_t randA = dist(rng) & 0xFFFull;        // 12 random bits
    const uint64_t randB = dist(rng) & 0x3FFFFFFFFFFFFFFFull; // 62 random bits

    // 128-bit layout: 48 bits ts_ms | 4 bits version(7) | 12 bits rand_a |
    // 2 bits variant(10) | 62 bits rand_b.
    const uint64_t hi = (unixTsMs << 16) | (0x7ull << 12) | randA;
    const uint64_t lo = (0x2ull << 62) | randB;

    char buf[37];
    std::snprintf(buf, sizeof(buf),
                  "%08x-%04x-%04x-%04x-%04x%08x",
                  static_cast<unsigned>((hi >> 32) & 0xFFFFFFFFull),
                  static_cast<unsigned>((hi >> 16) & 0xFFFFull),
                  static_cast<unsigned>(hi & 0xFFFFull),
                  static_cast<unsigned>((lo >> 48) & 0xFFFFull),
                  static_cast<unsigned>((lo >> 32) & 0xFFFFull),
                  static_cast<unsigned>(lo & 0xFFFFFFFFull));
    return std::string(buf);
}

} // namespace resostage
