#pragma once

#include <juce_core/juce_core.h>

#include <readerwriterqueue.h>

#include <atomic>
#include <cstdint>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace resostage {

/**
 * When a trigger should actually leave the machine, on the host clock.
 *
 * Not when it was generated. The audio it belongs with is still sitting in the
 * device's buffers for tens of milliseconds after the render callback hands it
 * over, so a light cue sent immediately arrives before its own downbeat -- by
 * an amount that changes with the buffer size. Zero means "as soon as
 * possible", which is what a manual or on-load trigger wants. See
 * engine/timing/OutputLatency.h.
 */
struct HttpTriggerCommand {
    std::string url;
    std::string method = "POST";
    std::string body;
    uint64_t targetHostTimeNanos = 0;
};

struct DmxTriggerCommand {
    int universe = 0;
    std::vector<uint8_t> data; // up to 512 bytes, per DMX512
    /** See HttpTriggerCommand::targetHostTimeNanos. */
    uint64_t targetHostTimeNanos = 0;
};

// Fires HTTP and DMX (Art-Net UDP) trigger commands off the audio thread, on
// a dedicated background worker thread, so a slow or unreachable target
// never risks a real-time deadline.
//
// DMX/Art-Net: packets built by engine/audio/ArtNetPacket (unit-tested + UDP
// loopback). Hardware fixtures not required for CI. HTTP triggers use a
// minimal HTTP/1.1 client (fire-and-forget).
//
// Both sit on JUCE's socket classes rather than on BSD sockets directly. That
// is not a style preference: <arpa/inet.h>, <netdb.h> and a bare sendto() do
// not exist on Windows, where the same job needs Winsock2 and a WSAStartup
// somebody has to remember to call. JUCE already carries that per-platform
// difference, so the alternative was a second copy of it here.
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

    /**
     * One send-only UDP socket for the life of the dispatcher.
     *
     * Bound to an ephemeral port with broadcast enabled, because an Art-Net
     * target may be a broadcast address. Held rather than opened per packet:
     * at 44 frames a second per universe, opening a socket per send would be
     * most of the work.
     */
    std::unique_ptr<juce::DatagramSocket> dmxSocket;

    /** Where an ArtDMX packet actually goes. See the definition. */
    juce::String resolvedArtNetTarget();

    /** What "broadcast" is configured as, and what it resolves to. */
    static constexpr const char* kLimitedBroadcast = "255.255.255.255";
    std::mutex artNetTargetMutex;
    juce::String resolvedTarget;
    std::chrono::steady_clock::time_point resolvedTargetExpiry{};
    std::string artNetTargetAddress = kLimitedBroadcast;
};

} // namespace resostage
