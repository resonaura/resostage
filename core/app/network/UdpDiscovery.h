#pragma once

#include <juce_core/juce_core.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <atomic>
#include <mutex>
#include <string>
#include <vector>

namespace resostage {

struct DiscoveredDevice {
    std::string name;
    std::string platform; // "darwin" | "win32" | "linux"
    std::string ip;
    uint16_t port = 2899;
    std::string protocolVersion = "1.0.0";
    bool discoveryEnabled = true;
    double lastSeenSeconds = 0.0;
};

class UdpDiscovery final : private juce::Thread {
public:
    static constexpr uint16_t kDiscoveryPort = 28991;
    static constexpr const char* kProtocolVersion = "1.0.0";

    UdpDiscovery();
    ~UdpDiscovery() override;

    void start(uint16_t webPort, bool enableDiscovery, const std::string& bindAddress = "0.0.0.0");
    void stop();
    void setDiscoveryEnabled(bool enabled, const std::string& bindAddress = "0.0.0.0");

    bool isDiscoveryEnabled() const { return discoveryEnabled.load(); }
    std::vector<DiscoveredDevice> getDiscoveredDevices();

private:
    void run() override;
    void sendAnnounce();
    void parseIncomingDatagram(const char* data, int size, const juce::String& senderIp);

    std::atomic<bool> discoveryEnabled{true};
    std::atomic<bool> isRunning{false};
    uint16_t webPort = 2899;
    std::string bindAddress = "0.0.0.0";

    std::mutex devicesMutex;
    std::vector<DiscoveredDevice> devices;

    std::unique_ptr<juce::DatagramSocket> socket;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(UdpDiscovery)
};

} // namespace resostage
