#pragma once

#include <cstdint>
#include <vector>

namespace resostage {

// Builds a standard ArtDMX UDP payload (Art-Net 4 style OpCode 0x5000).
// Universe is the 15-bit Port-Address (SubUni in low 8, Net in next 7).
// Data is truncated/padded policy: length = min(data.size(), 512); odd lengths
// are left as-is (Art-Net allows any even length 2..512; we accept 0..512).
//
// Packet layout (bytes):
//   0-7   "Art-Net\0"
//   8-9   OpCode 0x5000 little-endian
//   10-11 ProtVer 14 big-endian
//   12    Sequence (0 = disabled)
//   13    Physical
//   14    SubUni
//   15    Net
//   16-17 Length big-endian
//   18..  DMX data
// Builds an ArtDMX packet (OpCode 0x5000, ProtVer 14). `sequence` is written
// verbatim into the Art-Net Sequence byte: nodes ignore out-of-order/duplicate
// UDP frames only when this is non-zero and increments per-universe, so callers
// should pass a counter cycling 0x01..0xFF (per universe). 0 disables ordering
// checks on the receiver.
std::vector<uint8_t> buildArtDmxPacket(int universe, const std::vector<uint8_t>& data, uint8_t sequence);
std::vector<uint8_t> buildArtDmxPacket(int universe, const std::vector<uint8_t>& data);

// True if packet has a valid Art-Net ID, ArtDMX opcode, and length field that
// matches the payload size (within 0..512). Used by unit / loopback tests.
bool parseArtDmxPacket(const uint8_t* packet, size_t size,
                       int& outUniverse, std::vector<uint8_t>& outData);

static constexpr uint16_t kArtNetUdpPort = 6454;

} // namespace resostage
