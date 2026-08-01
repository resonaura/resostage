#pragma once

#include <readerwriterqueue.h>

#include <atomic>
#include <cstdint>
#include <string>
#include <thread>
#include <vector>

namespace resostage {

struct HttpTriggerCommand {
    std::string url;
    std::string method = "POST";
    std::string body;
};

struct DmxTriggerCommand {
    int universe = 0;
    std::vector<uint8_t> data; // up to 512 bytes, per DMX512
};

// Fires HTTP and DMX (Art-Net UDP) trigger commands off the audio thread, on
// a dedicated background worker thread, so a slow or unreachable target
// never risks a real-time deadline.
//
// DMX/Art-Net: packets built by engine/audio/ArtNetPacket (unit-tested + UDP
// loopback). Hardware fixtures not required for CI. HTTP triggers use a
// minimal raw-socket HTTP/1.1 client (fire-and-forget).
class EventDispatcher {
public:
    EventDispatcher();
    ~EventDispatcher();

    EventDispatcher(const EventDispatcher&) = delete;
    EventDispatcher& operator=(const EventDispatcher&) = delete;

    void start();
    void stop();

    // Lock-free: safe to call from the audio thread. Never blocks. Returns
    // false if the queue is momentarily full (command dropped).
    bool enqueueHttp(const HttpTriggerCommand& cmd);
    bool enqueueDmx(const DmxTriggerCommand& cmd);

    // Where ArtDMX UDP packets are sent; defaults to the local broadcast
    // address so any Art-Net node on the subnet picks them up.
    void setArtNetTargetAddress(const std::string& ipOrBroadcast);

private:
    void workerThreadLoop();
    void sendHttp(const HttpTriggerCommand& cmd);
    void sendDmx(const DmxTriggerCommand& cmd);

    moodycamel::ReaderWriterQueue<HttpTriggerCommand> httpQueue{256};
    // 1024 slots: LightEngine sends ~44 packets/s × N universes continuously.
    moodycamel::ReaderWriterQueue<DmxTriggerCommand> dmxQueue{1024};
    std::thread worker;
    std::atomic<bool> running{false};

    int dmxSocket = -1;
    std::string artNetTargetAddress = "255.255.255.255";
};

} // namespace resostage
