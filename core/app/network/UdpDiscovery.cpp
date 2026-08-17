#include "UdpDiscovery.h"

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

    socket->write("255.255.255.255", kDiscoveryPort, raw, len);

    const auto addrs = juce::IPAddress::getAllAddresses(false);
    for (const auto& addr : addrs) {
        const juce::String s = addr.toString();
        if (s.startsWith("127.") || s.startsWith("169.254.")) continue;
        auto parts = juce::StringArray::fromTokens(s, ".", "");
        if (parts.size() == 4) {
            juce::String bcast = parts[0] + "." + parts[1] + "." + parts[2] + ".255";
            socket->write(bcast, kDiscoveryPort, raw, len);
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
    juce::String senderIp;
    int senderPort = 0;
    uint32_t lastAnnounceMs = 0;

    while (isRunning.load() && !threadShouldExit()) {
        uint32_t nowMs = juce::Time::getMillisecondCounter();
        if (nowMs - lastAnnounceMs >= 2000) { // Announce every 2 seconds
            sendAnnounce();
            lastAnnounceMs = nowMs;
        }

        if (socket && socket->waitUntilReady(true, 250) > 0) {
            int read = socket->read(buffer, sizeof(buffer) - 1, false, senderIp, senderPort);
            if (read > 0) {
                buffer[read] = '\0';
                parseIncomingDatagram(buffer, read, senderIp);
            }
        }
    }
}

} // namespace resostage
