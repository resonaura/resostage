#include "doctest.h"
#include "network/UdpDiscovery.h"
#include "server/WireTypes.h"
#include "glaze/glaze.hpp"

#include <juce_core/juce_core.h>

using namespace resostage;

TEST_SUITE("UdpDiscovery") {

TEST_CASE("UdpDiscovery Constants and Instantiation") {
    CHECK(UdpDiscovery::kDiscoveryPort == 28991);
    CHECK(std::string(UdpDiscovery::kProtocolVersion) == "1.0.0");

    UdpDiscovery discovery;
    CHECK(discovery.isDiscoveryEnabled());

    discovery.setDiscoveryEnabled(false);
    CHECK_FALSE(discovery.isDiscoveryEnabled());

    discovery.setDiscoveryEnabled(true);
    CHECK(discovery.isDiscoveryEnabled());
}

TEST_CASE("UdpDiscovery Start and Stop Lifecycle") {
    UdpDiscovery discovery;
    
    // Start discovery listening
    discovery.start(2899, true, "0.0.0.0");
    CHECK(discovery.isDiscoveryEnabled());

    auto initialDevices = discovery.getDiscoveredDevices();
    // Initial devices list is clean
    CHECK(initialDevices.empty());

    discovery.stop();
}

TEST_CASE("UdpDiscovery JSON Payload Parsing and Deduplication") {
    UdpDiscovery discovery;

    wire::WDiscoveryAnnouncement announcement;
    announcement.type = "RESOSTAGE_DISCOVERY";
    announcement.name = "TestLaptop";
    announcement.platform = "win32";
    announcement.port = 2899;
    announcement.protocolVersion = "1.0.0";
    announcement.discoveryEnabled = true;

    std::string serialized;
    const auto ec = glz::write_json(announcement, serialized);
    CHECK_FALSE(ec);

    // Verify string deserialization with Glaze
    wire::WDiscoveryAnnouncement parsed;
    const auto readEc = glz::read_json(parsed, serialized);
    CHECK_FALSE(readEc);
    CHECK(parsed.name == "TestLaptop");
    CHECK(parsed.platform == "win32");
    CHECK(parsed.port == 2899);
    CHECK(parsed.protocolVersion == "1.0.0");
    CHECK(parsed.discoveryEnabled == true);

    // Ingest via parseIncomingDatagram
    discovery.parseIncomingDatagram(serialized.data(), static_cast<int>(serialized.size()), "192.168.1.105");
    auto devices = discovery.getDiscoveredDevices();
    REQUIRE(devices.size() == 1);
    CHECK(devices[0].name == "TestLaptop");
    CHECK(devices[0].platform == "win32");
    CHECK(devices[0].ip == "192.168.1.105");
    CHECK(devices[0].port == 2899);

    // Ingest malformed payload: should be safely ignored
    const std::string badJson = "{invalid-json-payload";
    discovery.parseIncomingDatagram(badJson.data(), static_cast<int>(badJson.size()), "192.168.1.106");
    CHECK(discovery.getDiscoveredDevices().size() == 1);

    // Ingest non-discovery payload: should be safely ignored
    const std::string wrongType = R"({"type":"SOME_OTHER_PACKET","name":"Ignored"})";
    discovery.parseIncomingDatagram(wrongType.data(), static_cast<int>(wrongType.size()), "192.168.1.107");
    CHECK(discovery.getDiscoveredDevices().size() == 1);
}

} // TEST_SUITE
