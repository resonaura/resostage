#include "UdpDiscovery.h"

#if JUCE_WINDOWS
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <iphlpapi.h>
  #pragma comment(lib, "iphlpapi.lib")
#else
  #include <sys/types.h>
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <ifaddrs.h>
  #include <net/if.h>
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

std::vector<std::string> getBroadcastAddresses() {
    std::vector<std::string> results;
    results.push_back("255.255.255.255");

#if JUCE_WINDOWS
    ULONG outBufLen = sizeof(IP_ADAPTER_INFO);
    PIP_ADAPTER_INFO pAdapterInfo = reinterpret_cast<IP_ADAPTER_INFO*>(std::malloc(sizeof(IP_ADAPTER_INFO)));
    if (pAdapterInfo != nullptr) {
        if (GetAdaptersInfo(pAdapterInfo, &outBufLen) == ERROR_BUFFER_OVERFLOW) {
            std::free(pAdapterInfo);
            pAdapterInfo = reinterpret_cast<IP_ADAPTER_INFO*>(std::malloc(outBufLen));
        }
        if (pAdapterInfo != nullptr && GetAdaptersInfo(pAdapterInfo, &outBufLen) == NO_ERROR) {
            PIP_ADAPTER_INFO pAdapter = pAdapterInfo;
            while (pAdapter) {
                IP_ADDR_STRING* pIp = &pAdapter->IpAddressList;
                while (pIp) {
                    const char* ipStr = pIp->IpAddress.String;
                    const char* maskStr = pIp->IpMask.String;
                    if (ipStr && maskStr && std::strlen(ipStr) > 0 &&
                        std::strcmp(ipStr, "0.0.0.0") != 0 &&
                        std::strcmp(ipStr, "127.0.0.1") != 0) {
                        uint32_t ip = inet_addr(ipStr);
                        uint32_t mask = inet_addr(maskStr);
                        if (ip != INADDR_NONE && mask != INADDR_NONE) {
                            uint32_t bcast = ip | ~mask;
                            struct in_addr bcastAddr;
                            bcastAddr.s_addr = bcast;
                            char* s = inet_ntoa(bcastAddr);
                            if (s && std::find(results.begin(), results.end(), s) == results.end()) {
                                results.push_back(s);
                            }
                        }
                    }
                    pIp = pIp->Next;
                }
                pAdapter = pAdapter->Next;
            }
        }
        if (pAdapterInfo) std::free(pAdapterInfo);
    }
#else
    struct ifaddrs* ifaddr = nullptr;
    if (getifaddrs(&ifaddr) == 0 && ifaddr != nullptr) {
        for (struct ifaddrs* ifa = ifaddr; ifa != nullptr; ifa = ifa->ifa_next) {
            if (ifa->ifa_addr == nullptr || ifa->ifa_addr->sa_family != AF_INET) continue;
            if (!(ifa->ifa_flags & IFF_UP) || (ifa->ifa_flags & IFF_LOOPBACK)) continue;
            if (ifa->ifa_flags & IFF_BROADCAST) {
                if (ifa->ifa_broadaddr != nullptr) {
                    char host[INET_ADDRSTRLEN] = {0};
                    auto* sin = reinterpret_cast<struct sockaddr_in*>(ifa->ifa_broadaddr);
                    if (inet_ntop(AF_INET, &sin->sin_addr, host, sizeof(host)) != nullptr) {
                        if (std::find(results.begin(), results.end(), host) == results.end()) {
                            results.push_back(host);
                        }
                    }
                } else if (ifa->ifa_netmask != nullptr) {
                    auto* addrSin = reinterpret_cast<struct sockaddr_in*>(ifa->ifa_addr);
                    auto* maskSin = reinterpret_cast<struct sockaddr_in*>(ifa->ifa_netmask);
                    uint32_t bcast = addrSin->sin_addr.s_addr | ~maskSin->sin_addr.s_addr;
                    struct in_addr bcastAddr;
                    bcastAddr.s_addr = bcast;
                    char host[INET_ADDRSTRLEN] = {0};
                    if (inet_ntop(AF_INET, &bcastAddr, host, sizeof(host)) != nullptr) {
                        if (std::find(results.begin(), results.end(), host) == results.end()) {
                            results.push_back(host);
                        }
                    }
                }
            }
        }
        freeifaddrs(ifaddr);
    }
#endif

    return results;
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
        ::sendto(sockHandle, raw, static_cast<size_t>(len), 0, reinterpret_cast<const struct sockaddr*>(&targetAddress), sizeof(targetAddress));
#endif
    };

    const auto targets = getBroadcastAddresses();
    for (const auto& target : targets) {
        sendToAddr(target.c_str());
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
