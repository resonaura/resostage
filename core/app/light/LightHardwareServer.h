#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct lws_context;
struct lws;

namespace resostage {

// Real-hardware transport for ResoLightBar fixtures: dials OUT (as a WS
// *client*) to each fixture's configured IP:port and streams binary
// lighting frames per resolight/firmware/shared/ResoLightProtocol.h -- the
// wire format both this class and resolight/firmware/src/main.cpp compile
// from the same header. Entirely separate from WebServer (the operator-facing HTTP/WS UI
// server) and from EventDispatcher (Art-Net/HTTP trigger dispatch): its own
// port-free lws client context, its own thread, so a stalled/unreachable
// board can never add latency to the UI or to DMX output. The default rig
// (no fixture has a host configured -- pure 3D-preview mode) costs this
// class nothing beyond one idle UDP-listener thread; no outbound
// connections are ever attempted until the operator types in an IP.
//
// Threading contract:
//   - start()/stop()                    -- call from any thread.
//   - updateFixtureFrame()               -- call from LightEngine's
//     real-time thread, every tick, only for fixtures with a configured
//     host. Never touches libwebsockets (that would be unsafe -- lws is only
//     ever driven from its own service thread below); it encodes the frame
//     and hands it to a non-blocking UDP socket right there, which is what
//     keeps light latency down to the engine tick. O(1), one syscall, and it
//     cannot block: a full socket buffer drops the frame, which is the right
//     answer for periodic full-state data.
//   - syncActiveFixtures()               -- call from LightEngine's thread
//     once per tick with the full current "should have a live connection"
//     fixture set, independent of which fixtures actually resolved a cue
//     this tick (see .cpp for why connection lifecycle is decoupled from
//     frame delivery, mirroring how DMX/Art-Net fixtures with no active
//     cue simply hold their last-received value on real hardware).
//   - discoveredBoards()/fixtureLinkStatus() -- safe from any thread (HTTP
//     handlers, the JUCE message thread); read-only snapshots under a
//     mutex.
//   - All actual libwebsockets calls (connect, write, close, service) run
//     exclusively on this class's own network thread.
class LightHardwareServer {
public:
    LightHardwareServer();
    ~LightHardwareServer();

    LightHardwareServer(const LightHardwareServer&) = delete;
    LightHardwareServer& operator=(const LightHardwareServer&) = delete;

    void start();
    void stop();

    void updateFixtureFrame(const std::string& fixtureId,
                             const std::string& host,
                             uint16_t port,
                             uint8_t channelsPerPixel,
                             const uint8_t* pixelBytes,
                             size_t pixelByteCount,
                             double refreshHz);

    struct ActiveFixtureTarget {
        std::string fixtureId;
        std::string host;
        uint16_t port = 0;
    };
    // Fixtures that currently have a hardware host configured, whether or
    // not they have an active cue this tick -- drives connection
    // open/keep-alive/close independently of frame delivery. Anything
    // previously tracked but absent here has its connection gracefully
    // closed (the Connection bookkeeping itself is kept around, not freed,
    // so a fixture that gets its host re-added later reconnects instantly
    // without waiting out a stale backoff timer -- see .cpp).
    void syncActiveFixtures(const std::vector<ActiveFixtureTarget>& active);

    struct DiscoveredBoard {
        std::string mac;
        std::string ip;
        std::string name;
        std::string chipType; // "esp32" | "esp8266" | "unknown"
        double lastSeenSecondsAgo = 0.0;
    };
    // Boards heard on the discovery UDP broadcast within the last ~30s.
    std::vector<DiscoveredBoard> discoveredBoards() const;

    struct FixtureLinkStatus {
        bool configured = false; // a host is set for this fixture at all
        bool connected = false;
        double lastFrameSecondsAgo = -1.0;
        double lastStatusSecondsAgo = -1.0;
        int rssiDbm = 0;
        std::string chipType;
    };
    FixtureLinkStatus fixtureLinkStatus(const std::string& fixtureId) const;

    // Opaque per-fixture connection bookkeeping. Defined in the .cpp; listed
    // as a public incomplete type only so the free-function lws client
    // callback (which libwebsockets requires as a plain C-style function
    // pointer, not a member) can cast opaque_user_data back to Connection*.
    // Not part of the external API -- never construct or touch one from
    // outside LightHardwareServer.cpp.
    struct Connection;

private:
    void discoveryThreadLoop();
    void networkThreadLoop();

    // Called on the LightEngine thread from updateFixtureFrame(). See its
    // definition for why the send happens there rather than on the network
    // thread.
    void sendFrameOverUdp(Connection& conn, uint8_t channelsPerPixel, const uint8_t* pixelBytes,
                          size_t pixelByteCount, double refreshHz, const std::string& host);

    std::atomic<bool> running_{false};
    std::thread discoveryThread_;
    std::thread networkThread_;
    int discoverySocket_ = -1;
    // Non-blocking, send-only. One socket for every board: the destination is
    // per-sendto, so there is nothing per-connection to keep.
    int udpSocket_ = -1;

    mutable std::mutex connectionsMutex_;
    // Keyed by fixtureId. Never erased once created (see syncActiveFixtures
    // doc comment) -- bounded by the number of distinct fixtures ever
    // configured with a hardware host in this process's lifetime, which for
    // a real light rig is at most a few dozen, not a growth concern.
    std::map<std::string, std::unique_ptr<Connection>> connections_;

    struct DiscoveredEntry {
        std::string ip;
        std::string name;
        std::string chipType;
        std::chrono::steady_clock::time_point lastSeenAt{};
    };
    mutable std::mutex discoveredMutex_;
    std::map<std::string, DiscoveredEntry> discovered_; // keyed by MAC (hex string)

    lws_context* clientContext_ = nullptr;
};

} // namespace resostage
