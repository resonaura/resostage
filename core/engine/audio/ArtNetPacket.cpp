#include "ArtNetPacket.h"

#include <algorithm>
#include <cstring>

namespace resostage {

std::vector<uint8_t> buildArtDmxPacket(int universe, const std::vector<uint8_t>& data) {
    std::vector<uint8_t> packet;
    packet.reserve(18 + 512);

    const char id[8] = {'A', 'r', 't', '-', 'N', 'e', 't', '\0'};
    packet.insert(packet.end(), id, id + 8);

    // OpCode ArtDMX = 0x5000, little-endian (low byte first) per Art-Net spec.
    packet.push_back(0x00);
    packet.push_back(0x50);

    // Protocol version 14, big-endian.
    packet.push_back(0);
    packet.push_back(14);

    packet.push_back(0); // Sequence disabled
    packet.push_back(0); // Physical

    const int uni = std::clamp(universe, 0, 0x7FFF);
    packet.push_back(static_cast<uint8_t>(uni & 0xFF));        // SubUni
    packet.push_back(static_cast<uint8_t>((uni >> 8) & 0x7F)); // Net

    const uint16_t length = static_cast<uint16_t>(std::min<size_t>(data.size(), 512));
    packet.push_back(static_cast<uint8_t>((length >> 8) & 0xFF)); // LengthHi (BE)
    packet.push_back(static_cast<uint8_t>(length & 0xFF));        // LengthLo

    if (length > 0)
        packet.insert(packet.end(), data.begin(), data.begin() + length);

    return packet;
}

bool parseArtDmxPacket(const uint8_t* packet, size_t size,
                       int& outUniverse, std::vector<uint8_t>& outData) {
    outUniverse = 0;
    outData.clear();
    if (packet == nullptr || size < 18)
        return false;

    static const char kId[8] = {'A', 'r', 't', '-', 'N', 'e', 't', '\0'};
    if (std::memcmp(packet, kId, 8) != 0)
        return false;

    const uint16_t opcode = static_cast<uint16_t>(packet[8] | (packet[9] << 8));
    if (opcode != 0x5000)
        return false;

    outUniverse = static_cast<int>(packet[14] | ((packet[15] & 0x7F) << 8));
    const uint16_t length = static_cast<uint16_t>((packet[16] << 8) | packet[17]);
    if (length > 512)
        return false;
    if (size < 18u + length)
        return false;

    outData.assign(packet + 18, packet + 18 + length);
    return true;
}

} // namespace resostage
