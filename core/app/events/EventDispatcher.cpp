#include "EventDispatcher.h"

#include "audio/ArtNetPacket.h"
#include "events/DueQueue.h"
#include "timing/MasterClock.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <sstream>
#include <thread>
#include <utility>
#include <vector>

namespace resostage {

namespace {

/** See sendHttp: bounds the damage from an unreachable target. */
constexpr int kHttpConnectTimeoutMs = 2000;

bool parseHttpUrl(const std::string& url, std::string& host, std::string& port, std::string& path) {
    std::string rest = url;
    const std::string httpScheme = "http://";
    if (rest.rfind(httpScheme, 0) == 0) {
        rest = rest.substr(httpScheme.size());
    } else if (rest.rfind("https://", 0) == 0) {
        return false; // HTTPS not supported by this minimal fire-and-forget client
    }

    const auto slashPos = rest.find('/');
    const std::string hostPort = (slashPos == std::string::npos) ? rest : rest.substr(0, slashPos);
    path = (slashPos == std::string::npos) ? "/" : rest.substr(slashPos);

    const auto colonPos = hostPort.find(':');
    if (colonPos == std::string::npos) {
        host = hostPort;
        port = "80";
    } else {
        host = hostPort.substr(0, colonPos);
        port = hostPort.substr(colonPos + 1);
    }
    return !host.empty();
}

} // namespace

EventDispatcher::EventDispatcher() = default;

EventDispatcher::~EventDispatcher() {
    stop();
}

void EventDispatcher::setArtNetTargetAddress(const std::string& ipOrBroadcast) {
    if (artNetTargetAddress == ipOrBroadcast)
        return;
    artNetTargetAddress = ipOrBroadcast;
    // Force a re-resolve: the operator may have switched from broadcast to a
    // specific node, or back.
    std::lock_guard<std::mutex> lock(artNetTargetMutex);
    resolvedTarget.clear();
}

juce::String EventDispatcher::resolvedArtNetTarget() {
    // A specific node was configured: send there and do not second-guess it.
    if (!artNetTargetAddress.empty() && artNetTargetAddress != kLimitedBroadcast)
        return juce::String(artNetTargetAddress);

    std::lock_guard<std::mutex> lock(artNetTargetMutex);
    const auto now = std::chrono::steady_clock::now();
    if (!resolvedTarget.isEmpty() && now < resolvedTargetExpiry)
        return resolvedTarget;

    // Broadcast means the SUBNET's broadcast address, not 255.255.255.255.
    //
    // The limited broadcast is what "broadcast" reads like, and it does not
    // work: a socket bound to every interface has no route for it, and macOS
    // rejects the send outright with EHOSTUNREACH. On this machine that meant
    // Art-Net output never left the process -- 604 sends in ten seconds, every
    // one of them refused, and nothing anywhere said so.
    //
    // The subnet-directed address (192.168.7.255 for a /22 on 192.168.5.184)
    // is routable, reaches every node on the same LAN, and is what Art-Net
    // nodes listen for.
    //
    // Re-resolved periodically rather than once: a laptop at a venue gets
    // plugged into the lighting network after the app is already running, and
    // an address cached from the hotel Wi-Fi would be wrong for the whole
    // show.
    resolvedTarget = juce::String(kLimitedBroadcast);
    for (const juce::IPAddress& local : juce::IPAddress::getAllAddresses(/*includeIPv6=*/false)) {
        if (local.isNull() || local == juce::IPAddress::local())
            continue;
        const juce::IPAddress bcast = juce::IPAddress::getInterfaceBroadcastAddress(local);
        if (!bcast.isNull()) {
            resolvedTarget = bcast.toString();
            break;
        }
    }
    resolvedTargetExpiry = now + std::chrono::seconds(5);
    return resolvedTarget;
}

void EventDispatcher::start() {
    if (running.exchange(true, std::memory_order_acq_rel))
        return;

    // Bind to any free local port: this socket only ever sends. Broadcast is
    // enabled because an Art-Net target may legitimately be a subnet
    // broadcast address, and a socket without it silently fails on one.
    dmxSocket = std::make_unique<juce::DatagramSocket>(/*enableBroadcasting=*/true);
    if (!dmxSocket->bindToPort(0))
        dmxSocket.reset();

    worker = std::thread([this] { workerThreadLoop(); });
}

void EventDispatcher::stop() {
    if (!running.exchange(false, std::memory_order_acq_rel))
        return;
    if (worker.joinable())
        worker.join();
}

bool EventDispatcher::enqueueHttp(const HttpTriggerCommand& cmd) {
    return httpQueue.try_enqueue(cmd);
}

bool EventDispatcher::enqueueDmx(const DmxTriggerCommand& cmd) {
    return dmxQueue.try_enqueue(cmd);
}

void EventDispatcher::sendHttp(const HttpTriggerCommand& cmd) {
    std::string host, port, path;
    if (!parseHttpUrl(cmd.url, host, port, path))
        return;

    // Bounded connect, so an unreachable target cannot stall this worker --
    // and therefore every trigger queued behind it -- for a TCP timeout. Two
    // seconds is already far longer than a cue can wait and still be useful;
    // it is here to bound the damage, not to succeed.
    juce::StreamingSocket socket;
    if (!socket.connect(juce::String(host), std::atoi(port.c_str()), kHttpConnectTimeoutMs))
        return;

    std::ostringstream request;
    request << cmd.method << " " << path << " HTTP/1.1\r\n";
    request << "Host: " << host << "\r\n";
    request << "Content-Length: " << cmd.body.size() << "\r\n";
    request << "Connection: close\r\n";
    request << "\r\n";
    request << cmd.body;

    const std::string requestStr = request.str();
    // Fire-and-forget: the response is intentionally not read or parsed. A
    // trigger is a nudge to another box, not a request whose answer we act on.
    socket.write(requestStr.data(), static_cast<int>(requestStr.size()));
}

void EventDispatcher::sendDmx(const DmxTriggerCommand& cmd) {
    if (dmxSocket == nullptr)
        return;

    // Per-universe Sequence counter: cycles 1..255 (0 disables node-side
    // ordering checks). A fresh universe key starts at 1; the pre-increment
    // wraps 255 -> 1 so 0 is never emitted, keeping the "enabled" signal live.
    auto& seq = artNetSequencePerUniverse[cmd.universe];
    if (seq == 0)
        seq = 1;
    seq = (seq < 255) ? static_cast<uint8_t>(seq + 1) : 1;

    const std::vector<uint8_t> packet = buildArtDmxPacket(cmd.universe, cmd.data, seq);
    // Fire and forget. A light frame that misses is replaced by the next one a
    // few milliseconds later, and blocking this thread to guarantee one frame
    // would delay every frame behind it.
    dmxSocket->write(resolvedArtNetTarget(), kArtNetUdpPort, packet.data(),
                     static_cast<int>(packet.size()));
}

void EventDispatcher::workerThreadLoop() {
    // Not joined to the audio workgroup -- see streamingIoThreadStart(). HTTP
    // and DMX sends are socket calls that block, and this thread sleeps
    // between them; neither belongs inside an audio deadline.

    // Triggers whose moment has not arrived yet.
    //
    // A timeline event is scheduled for when its audio will be HEARD, which is
    // later than when it was rendered -- see engine/timing/OutputLatency.h. The
    // queues above are lock-free and single-reader, so the wait happens here,
    // on this side, rather than by holding the audio thread up.
    //
    // Kept as plain vectors and drained in order. Events arrive in
    // chronological order because the audio thread emits them that way, so the
    // front is always the next one due and a linear scan never has anything to
    // scan past.
    std::vector<HttpTriggerCommand> pendingHttp;
    std::vector<DmxTriggerCommand> pendingDmx;

    // The SAME clock the audio thread stamped these with. A target time is
    // meaningless against a different epoch, and "close enough on this
    // platform" is how a cue ends up firing at an arbitrary moment on the next
    // one.
    const SystemMonotonicClock clock;

    while (running.load(std::memory_order_acquire)) {
        bool didWork = false;
        const uint64_t now = clock.nowNanos();

        HttpTriggerCommand httpCmd;
        while (httpQueue.try_dequeue(httpCmd)) {
            if (httpCmd.targetHostTimeNanos > now)
                pendingHttp.push_back(std::move(httpCmd));
            else
                sendHttp(httpCmd);
            didWork = true;
        }

        DmxTriggerCommand dmxCmd;
        while (dmxQueue.try_dequeue(dmxCmd)) {
            if (dmxCmd.targetHostTimeNanos > now)
                pendingDmx.push_back(std::move(dmxCmd));
            else
                sendDmx(dmxCmd);
            didWork = true;
        }

        // Anything now due. A trigger is never dropped for being late -- a
        // cue that missed its moment by a few milliseconds still has to fire,
        // because the alternative is a light that simply never comes on.
        // Compaction lives in engine/events/DueQueue.h, tested against a
        // clock you can control -- the in-place version this replaced moved an
        // element onto itself and silently emptied the payload it was holding.
        if (drainDue(pendingHttp, now, [this](const HttpTriggerCommand& c) { sendHttp(c); }) > 0)
            didWork = true;
        if (drainDue(pendingDmx, now, [this](const DmxTriggerCommand& c) { sendDmx(c); }) > 0)
            didWork = true;

        // Sleep only when there is nothing at all to do. With something
        // waiting, keep the 2 ms cadence so a due cue is never more than that
        // late -- well inside what anyone can see on a light.
        if (!didWork && pendingHttp.empty() && pendingDmx.empty())
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        else if (!didWork)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    // Whatever is still waiting when the engine stops is deliberately dropped:
    // the show is over, and firing a backlog of cues into a dark room is worse
    // than losing them.

}

} // namespace resostage
