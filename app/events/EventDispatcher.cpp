#include "EventDispatcher.h"

#include "../platform/AudioWorkgroup.h"
#include "audio/ArtNetPacket.h"

#include <algorithm>
#include <arpa/inet.h>
#include <cerrno>
#include <chrono>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sstream>
#include <sys/socket.h>
#include <unistd.h>

namespace resoset {

namespace {

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
    if (dmxSocket >= 0)
        close(dmxSocket);
}

void EventDispatcher::setArtNetTargetAddress(const std::string& ipOrBroadcast) {
    artNetTargetAddress = ipOrBroadcast;
}

void EventDispatcher::start() {
    if (running.exchange(true, std::memory_order_acq_rel))
        return;

    dmxSocket = socket(AF_INET, SOCK_DGRAM, 0);
    if (dmxSocket >= 0) {
        const int broadcastEnable = 1;
        setsockopt(dmxSocket, SOL_SOCKET, SO_BROADCAST, &broadcastEnable, sizeof(broadcastEnable));
    }

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

    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* result = nullptr;
    if (getaddrinfo(host.c_str(), port.c_str(), &hints, &result) != 0 || result == nullptr)
        return;

    const int sock = socket(result->ai_family, result->ai_socktype, result->ai_protocol);
    if (sock < 0) {
        freeaddrinfo(result);
        return;
    }

    // Non-blocking connect with a bounded timeout so an unreachable host
    // can't stall this worker thread (and therefore subsequent queued
    // events) indefinitely. This never runs on the audio thread.
    const int flags = fcntl(sock, F_GETFL, 0);
    fcntl(sock, F_SETFL, flags | O_NONBLOCK);

    const int connectResult = connect(sock, result->ai_addr, result->ai_addrlen);
    freeaddrinfo(result);

    if (connectResult < 0 && errno == EINPROGRESS) {
        fd_set writeSet;
        FD_ZERO(&writeSet);
        FD_SET(sock, &writeSet);
        timeval timeout{2, 0};
        const int selectResult = select(sock + 1, nullptr, &writeSet, nullptr, &timeout);
        if (selectResult <= 0) {
            close(sock);
            return;
        }
        int soError = 0;
        socklen_t len = sizeof(soError);
        getsockopt(sock, SOL_SOCKET, SO_ERROR, &soError, &len);
        if (soError != 0) {
            close(sock);
            return;
        }
    } else if (connectResult < 0) {
        close(sock);
        return;
    }

    fcntl(sock, F_SETFL, flags); // restore blocking mode for send()

    std::ostringstream request;
    request << cmd.method << " " << path << " HTTP/1.1\r\n";
    request << "Host: " << host << "\r\n";
    request << "Content-Length: " << cmd.body.size() << "\r\n";
    request << "Connection: close\r\n";
    request << "\r\n";
    request << cmd.body;

    const std::string requestStr = request.str();
    send(sock, requestStr.data(), requestStr.size(), 0);
    // Fire-and-forget: the response is intentionally not read or parsed.
    close(sock);
}

void EventDispatcher::sendDmx(const DmxTriggerCommand& cmd) {
    if (dmxSocket < 0)
        return;

    const std::vector<uint8_t> packet = buildArtDmxPacket(cmd.universe, cmd.data);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(kArtNetUdpPort);
    if (inet_pton(AF_INET, artNetTargetAddress.c_str(), &addr.sin_addr) != 1)
        return;

    sendto(dmxSocket, packet.data(), packet.size(), 0, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr));
}

void EventDispatcher::workerThreadLoop() {
    joinCurrentThreadToDefaultOutputWorkgroup();

    while (running.load(std::memory_order_acquire)) {
        bool didWork = false;

        HttpTriggerCommand httpCmd;
        while (httpQueue.try_dequeue(httpCmd)) {
            sendHttp(httpCmd);
            didWork = true;
        }

        DmxTriggerCommand dmxCmd;
        while (dmxQueue.try_dequeue(dmxCmd)) {
            sendDmx(dmxCmd);
            didWork = true;
        }

        if (!didWork)
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    // MUST happen before this thread returns/exits -- see the matching
    // comment in CoreMidiDispatcher::workerThreadLoop().
    leaveCurrentThreadWorkgroupIfJoined();
}

} // namespace resoset
