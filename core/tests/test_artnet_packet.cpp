#include "doctest.h"

#include "audio/ArtNetPacket.h"

#include <arpa/inet.h>
#include <chrono>
#include <cstring>
#include <netinet/in.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <vector>

using namespace resostage;

TEST_CASE("buildArtDmxPacket layout and round-trip parse") {
    std::vector<uint8_t> data = {1, 2, 3, 4, 255, 0, 128};
    const auto packet = buildArtDmxPacket(0x0102, data);
    REQUIRE(packet.size() == 18 + data.size());
    CHECK(std::memcmp(packet.data(), "Art-Net", 7) == 0);
    CHECK(packet[7] == 0);
    CHECK(packet[8] == 0x00);
    CHECK(packet[9] == 0x50);
    CHECK(packet[10] == 0);
    CHECK(packet[11] == 14);
    CHECK(packet[14] == 0x02); // SubUni low
    CHECK(packet[15] == 0x01); // Net

    int universe = -1;
    std::vector<uint8_t> out;
    REQUIRE(parseArtDmxPacket(packet.data(), packet.size(), universe, out));
    CHECK(universe == 0x0102);
    CHECK(out == data);
}

TEST_CASE("buildArtDmxPacket truncates to 512 channels") {
    std::vector<uint8_t> big(600, 7);
    const auto packet = buildArtDmxPacket(0, big);
    CHECK(packet.size() == 18 + 512);
    int universe = 0;
    std::vector<uint8_t> out;
    REQUIRE(parseArtDmxPacket(packet.data(), packet.size(), universe, out));
    CHECK(out.size() == 512);
}

TEST_CASE("Art-Net UDP loopback delivers a valid ArtDMX frame") {
    // Bind receiver on ephemeral port, send ArtDMX to 127.0.0.1:port, parse.
    const int rx = socket(AF_INET, SOCK_DGRAM, 0);
    REQUIRE(rx >= 0);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    REQUIRE(bind(rx, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
    socklen_t alen = sizeof(addr);
    REQUIRE(getsockname(rx, reinterpret_cast<sockaddr*>(&addr), &alen) == 0);
    const uint16_t port = ntohs(addr.sin_port);

    std::vector<uint8_t> data = {10, 20, 30, 40};
    const auto packet = buildArtDmxPacket(3, data);

    const int tx = socket(AF_INET, SOCK_DGRAM, 0);
    REQUIRE(tx >= 0);
    sockaddr_in dest = addr;
    dest.sin_port = htons(port);
    REQUIRE(sendto(tx, packet.data(), packet.size(), 0,
                   reinterpret_cast<sockaddr*>(&dest), sizeof(dest))
            == static_cast<ssize_t>(packet.size()));
    close(tx);

    // Short receive timeout
    timeval tv{1, 0};
    setsockopt(rx, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    uint8_t buf[1024];
    const ssize_t n = recv(rx, buf, sizeof(buf), 0);
    close(rx);
    REQUIRE(n > 0);

    int universe = -1;
    std::vector<uint8_t> out;
    REQUIRE(parseArtDmxPacket(buf, static_cast<size_t>(n), universe, out));
    CHECK(universe == 3);
    CHECK(out == data);
}
