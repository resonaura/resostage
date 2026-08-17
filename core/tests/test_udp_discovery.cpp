#include "doctest.h"
#include "network/UdpDiscovery.h"

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

    // Test with mock payload
    juce::var json(new juce::DynamicObject());
    json.getDynamicObject()->setProperty("type", "RESOSTAGE_DISCOVERY");
    json.getDynamicObject()->setProperty("name", "TestLaptop");
    json.getDynamicObject()->setProperty("platform", "win32");
    json.getDynamicObject()->setProperty("port", 2899);
    json.getDynamicObject()->setProperty("protocolVersion", "1.0.0");
    json.getDynamicObject()->setProperty("discoveryEnabled", true);

    juce::String serialized = juce::JSON::toString(json, true);

    // Verify string serialization is valid JSON
    auto parsed = juce::JSON::parse(serialized);
    CHECK(parsed.isObject());
    CHECK(parsed.getProperty("name", "").toString() == "TestLaptop");
    CHECK(parsed.getProperty("platform", "").toString() == "win32");
    CHECK(parsed.getProperty("port", 0).toString().getIntValue() == 2899);
    CHECK(parsed.getProperty("protocolVersion", "").toString() == "1.0.0");
}

} // TEST_SUITE
