#include "UdpDiscovery.h"

#if JUCE_WINDOWS
  #include <winsock2.h>
  #include <ws2tcpip.h>
#else
  #include <sys/types.h>
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <unistd.h>
#endif

namespace resostage {

namespace {

std::string getPlatformName() {
#if JUCE_MAC
    return "darwin";
#elif JUCE_WINDOWS
    return "win32";
#else
    return "linux";
#endif
}

std::string getHostDeviceName() {
    return juce::SystemStats::getComputerName().toStdString();
}

} // namespace

UdpDiscovery::UdpDiscovery() : juce::Thread("ResoStageUdpDiscovery") {}

UdpDiscovery::~UdpDiscovery() {
    stop();
}

void UdpDiscovery::start(uint16_t port, bool enableDiscovery, const std::string& bindAddr) {
    webPort = port;
    bindAddress = bindAddr;
    discoveryEnabled.store(enableDiscovery);

    stop();

    socket = std::make_unique<juce::DatagramSocket>(true); // enablePortReuse = true
    socket->bindToPort(kDiscoveryPort);

    int sockHandle = socket->getRawSocketHandle();
    if (sockHandle >= 0) {
        int optval = 1;
#if JUCE_WINDOWS
        setsockopt(static_cast<SOCKET>(sockHandle), SOL_SOCKET, SO_BROADCAST, reinterpret_cast<const char*>(&optval), sizeof(optval));
#else
        setsockopt(sockHandle, SOL_SOCKET, SO_BROADCAST, &optval, sizeof(optval));
#endif
    }

    isRunning.store(true);
    startThread(juce::Thread::Priority::normal);
}

void UdpDiscovery::stop() {
    isRunning.store(false);
    if (isThreadRunning()) {
        stopThread(1000);
    }
    socket = nullptr;
}

void UdpDiscovery::setDiscoveryEnabled(bool enabled, const std::string& bindAddr) {
    discoveryEnabled.store(enabled);
    bindAddress = bindAddr;
}

std::vector<DiscoveredDevice> UdpDiscovery::getDiscoveredDevices() {
    std::lock_guard<std::mutex> lock(devicesMutex);
    double now = juce::Time::getMillisecondCounterHiRes() / 1000.0;

    // Prune devices not seen in the last 15 seconds
    std::vector<DiscoveredDevice> active;
    for (const auto& dev : devices) {
        if (now - dev.lastSeenSeconds < 15.0) {
            active.push_back(dev);
        }
    }
    devices = active;
    return devices;
}

void UdpDiscovery::sendAnnounce() {
    if (!socket || !discoveryEnabled.load()) return;

    int sockHandle = socket->getRawSocketHandle();
    if (sockHandle < 0) return;

    juce::var json(new juce::DynamicObject());
    json.getDynamicObject()->setProperty("type", "RESOSTAGE_DISCOVERY");
    json.getDynamicObject()->setProperty("name", juce::String(getHostDeviceName()));
    json.getDynamicObject()->setProperty("platform", juce::String(getPlatformName()));
    json.getDynamicObject()->setProperty("port", static_cast<int>(webPort));
    json.getDynamicObject()->setProperty("protocolVersion", juce::String(kProtocolVersion));
    json.getDynamicObject()->setProperty("discoveryEnabled", discoveryEnabled.load());

    juce::String payload = juce::JSON::toString(json, true);
    auto raw = payload.toRawUTF8();
    int len = static_cast<int>(std::strlen(raw));

    auto sendToAddr = [&](const char* ipStr) {
        struct sockaddr_in targetAddress;
        std::memset(&targetAddress, 0, sizeof(targetAddress));
        targetAddress.sin_family = AF_INET;
        targetAddress.sin_port = htons(kDiscoveryPort);
#if JUCE_WINDOWS
        targetAddress.sin_addr.s_addr = inet_addr(ipStr);
        ::sendto(static_cast<SOCKET>(sockHandle), raw, len, 0, reinterpret_cast<const struct sockaddr*>(&targetAddress), sizeof(targetAddress));
#else
        inet_pton(AF_INET, ipStr, &targetAddress.sin_addr);
        ::sendto(sockHandle, raw, len, 0, reinterpret_cast<const struct sockaddr*>(&targetAddress), sizeof(targetAddress));
#endif
    };

    // Global broadcast
    sendToAddr("255.255.255.255");

    // Subnet directed broadcasts for every local interface
    const auto addrs = juce::IPAddress::getAllAddresses(false);
    for (const auto& addr : addrs) {
        const juce::String s = addr.toString();
        if (s.startsWith("127.") || s.startsWith("169.254.") || s.contains(":")) continue;
        auto parts = juce::StringArray::fromTokens(s, ".", "");
        if (parts.size() == 4) {
            juce::String bcast = parts[0] + "." + parts[1] + "." + parts[2] + ".255";
            sendToAddr(bcast.toRawUTF8());
        }
    }
}

void UdpDiscovery::parseIncomingDatagram(const char* data, int size, const juce::String& senderIp) {
    if (size <= 0 || data == nullptr) return;

    juce::String str(juce::CharPointer_UTF8(data), static_cast<size_t>(size));
    auto parsed = juce::JSON::parse(str);
    if (!parsed.isObject()) return;

    auto* obj = parsed.getDynamicObject();
    if (obj == nullptr) return;

    if (obj->getProperty("type").toString() != "RESOSTAGE_DISCOVERY") return;

    DiscoveredDevice dev;
    dev.name = obj->getProperty("name").toString().toStdString();
    dev.platform = obj->getProperty("platform").toString().toStdString();
    dev.ip = senderIp.toStdString();
    dev.port = static_cast<uint16_t>(obj->getProperty("port").toString().getIntValue());
    dev.protocolVersion = obj->getProperty("protocolVersion").toString().toStdString();
    dev.discoveryEnabled = static_cast<bool>(obj->getProperty("discoveryEnabled"));
    dev.lastSeenSeconds = juce::Time::getMillisecondCounterHiRes() / 1000.0;

    // Filter out our own self-announcements using IP matching
    bool isSelf = (senderIp == "127.0.0.1");
    if (!isSelf) {
        const auto localAddrs = juce::IPAddress::getAllAddresses(false);
        for (const auto& addr : localAddrs) {
            if (addr.toString() == senderIp) {
                isSelf = true;
                break;
            }
        }
    }
    if (isSelf && dev.port == webPort) {
        return;
    }

    std::lock_guard<std::mutex> lock(devicesMutex);
    bool found = false;
    for (auto& existing : devices) {
        if (existing.ip == dev.ip && existing.port == dev.port) {
            existing = dev;
            found = true;
            break;
        }
    }
    if (!found) {
        devices.push_back(dev);
    }
}

void UdpDiscovery::run() {
    char buffer[2048];

    // Send immediate initial announcement on thread start
    sendAnnounce();
    uint32_t lastAnnounceMs = juce::Time::getMillisecondCounter();

    while (isRunning.load() && !threadShouldExit()) {
        uint32_t nowMs = juce::Time::getMillisecondCounter();
        if (nowMs - lastAnnounceMs >= 2000) { // Announce every 2 seconds
            sendAnnounce();
            lastAnnounceMs = nowMs;
        }

        if (!socket) {
            juce::Thread::sleep(50);
            continue;
        }

        int sockHandle = socket->getRawSocketHandle();
        if (sockHandle < 0) {
            juce::Thread::sleep(50);
            continue;
        }

        // Wait up to 100ms for incoming packets
        if (socket->waitUntilReady(true, 100) > 0) {
            // Drain all available datagrams in buffer
            while (socket && !threadShouldExit()) {
                struct sockaddr_in from;
                socklen_t fromLen = sizeof(from);
                std::memset(&from, 0, sizeof(from));
#if JUCE_WINDOWS
                int read = ::recvfrom(static_cast<SOCKET>(sockHandle), buffer, static_cast<int>(sizeof(buffer) - 1), 0, reinterpret_cast<struct sockaddr*>(&from), &fromLen);
#else
                int read = static_cast<int>(::recvfrom(sockHandle, buffer, sizeof(buffer) - 1, 0, reinterpret_cast<struct sockaddr*>(&from), &fromLen));
#endif
                if (read > 0) {
                    buffer[read] = '\0';
                    char senderIpStr[INET_ADDRSTRLEN] = {0};
                    inet_ntop(AF_INET, &from.sin_addr, senderIpStr, sizeof(senderIpStr));
                    parseIncomingDatagram(buffer, read, senderIpStr);
                } else {
                    break;
                }
                if (socket->waitUntilReady(true, 0) <= 0) {
                    break;
                }
            }
        }
    }
}

} // namespace resostage
