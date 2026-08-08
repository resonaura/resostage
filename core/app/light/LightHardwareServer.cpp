#include "LightHardwareServer.h"

#include "ResoLightProtocol.h"

#include <libwebsockets.h>

#include <algorithm>
#include <arpa/inet.h>
#include <cstring>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

// Design notes (why this shape, not something simpler):
//
// - lws is already vendored and proven in this codebase for the WS *server*
//   role (WebServer.cpp). The client role is the same library, same frame
//   handling (handshake, masking, ping/pong, fragmentation all handled
//   internally) -- reusing it here is strictly less risky than hand-rolling
//   a second WebSocket implementation, and keeps one networking dependency
//   for the whole app instead of two.
// - ResoStage is the WS *client*, dialing OUT to each board -- see
//   ResoLightProtocol.h's module doc for why (rig-configuration UX: the
//   operator types in a bar's IP once; ResoStage owns connection lifecycle
//   for however many boards exist, rather than N boards all needing to know
//   ResoStage's address and reconnect logic themselves).
// - Every lws_* call happens exclusively on networkThreadLoop's own thread
//   (the one running lws_service on clientContext_). LightEngine's
//   real-time thread (updateFixtureFrame/syncActiveFixtures) only ever
//   touches plain mutex-guarded POD state on a Connection -- never an lws
//   handle -- because lws is not documented as safe to drive from a thread
//   other than the one running its service loop.
// - Connections are identified to lws via opaque_user_data (a raw
//   Connection*, stable for the process lifetime -- see the header's doc
//   comment on why Connections are never erased), avoiding any per-session
//   allocation lifecycle to get wrong.

namespace resostage {

namespace {
constexpr double kMinBackoffSeconds = 1.0;
constexpr double kMaxBackoffSeconds = 15.0;
constexpr double kDiscoveryStaleSeconds = 30.0;
constexpr int kRxBufferSize = 256; // status heartbeat is 12 bytes; generous headroom
} // namespace

struct LightHardwareServer::Connection {
    std::string fixtureId;

    // Written by updateFixtureFrame/syncActiveFixtures (LightEngine thread),
    // read by networkThreadLoop (network thread). Plain data only.
    // mutexes are mutable so const fixtureLinkStatus() can lock them.
    mutable std::mutex targetMutex;
    std::string host;
    uint16_t port = 0;
    bool wantsConnection = false;
    bool hostChanged = false; // set when host/port differs from what's connected

    // Latest resolved frame. Same threading split as targetMutex.
    mutable std::mutex frameMutex;
    uint8_t channelsPerPixel = 3;
    std::vector<uint8_t> pixelBytes;
    double refreshHz = 44.0;
    bool hasFrame = false;
    std::chrono::steady_clock::time_point lastSentAt{};

    // UDP light-frame delivery. `udpPort` is 0 until the board's status frame
    // reports one; while it is 0 the WebSocket path below carries the frames,
    // so a board on older firmware keeps working.
    //
    // Everything here is touched ONLY by the LightEngine thread (which does
    // the sendto) except udpPort, which the network thread writes when a
    // status frame arrives -- hence the atomic. Sending straight from the
    // engine thread is the entire point: it is what removes the hand-off to
    // the service loop, and with it up to a full refresh period plus the
    // 5 ms lws_service poll quantisation.
    std::atomic<uint16_t> udpPort{0};
    std::atomic<uint32_t> udpAddr{0}; // network byte order, resolved on the engine thread
    std::string udpAddrHost; // host string udpAddr was resolved from
    // Atomic because the two transports increment it from different threads.
    // They are mutually exclusive (the WS path is skipped once udpPort is
    // known) but the changeover itself would otherwise be a torn read.
    std::atomic<uint32_t> sequence{0};
    std::chrono::steady_clock::time_point lastUdpSentAt{};
    std::vector<uint8_t> udpScratch;

    // Status last reported by the board (StatusFrame). Written from the
    // network thread's LWS_CALLBACK_CLIENT_RECEIVE, read from any thread.
    mutable std::mutex statusMutex;
    bool everConnected = false;
    std::chrono::steady_clock::time_point lastStatusAt{};
    std::chrono::steady_clock::time_point connectedSince{};
    int rssiDbm = 0;
    std::string chipType = "unknown";

    // Network-thread-only state (never touched from any other thread, so
    // deliberately unguarded -- only networkThreadLoop and the lws callback
    // it drives ever read/write these).
    enum class State { Idle, Connecting, Open, ClosingForRedial };
    State state = State::Idle;
    struct lws* wsi = nullptr;
    std::chrono::steady_clock::time_point nextAttemptAt{};
    double backoffSeconds = kMinBackoffSeconds;
    std::string dialHost; // snapshot of host/port actually being dialed --
    uint16_t dialPort = 0; // kept stable for the pointer lws holds during connect
};

namespace {

std::string macToHex(const uint8_t mac[6]) {
    static const char* hex = "0123456789abcdef";
    std::string s;
    s.reserve(17);
    for (int i = 0; i < 6; ++i) {
        if (i > 0) s.push_back(':');
        s.push_back(hex[(mac[i] >> 4) & 0xF]);
        s.push_back(hex[mac[i] & 0xF]);
    }
    return s;
}

const char* chipTypeName(uint8_t raw) {
    if (raw == static_cast<uint8_t>(resolight::ChipType::Esp32)) return "esp32";
    if (raw == static_cast<uint8_t>(resolight::ChipType::Esp8266)) return "esp8266";
    return "unknown";
}

int clientCallback(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
    (void)user;
    auto* conn = static_cast<LightHardwareServer::Connection*>(lws_get_opaque_user_data(wsi));

    if (reason == LWS_CALLBACK_CLIENT_ESTABLISHED) {
        if (conn == nullptr) return -1;
        conn->wsi = wsi;
        conn->state = LightHardwareServer::Connection::State::Open;
        conn->backoffSeconds = kMinBackoffSeconds;
        {
            std::lock_guard<std::mutex> lk(conn->statusMutex);
            conn->everConnected = true;
            conn->connectedSince = std::chrono::steady_clock::now();
        }
        return 0;
    }

    if (reason == LWS_CALLBACK_CLIENT_WRITEABLE) {
        if (conn == nullptr) return 0;
        std::vector<uint8_t> buf;
        {
            std::lock_guard<std::mutex> lk(conn->frameMutex);
            if (!conn->hasFrame) return 0;
            const uint8_t cpp = conn->channelsPerPixel > 0 ? conn->channelsPerPixel : 1;
            const uint16_t pixelCount = static_cast<uint16_t>(conn->pixelBytes.size() / cpp);
            const size_t total = resolight::lightFramePayloadSize(pixelCount, cpp);
            buf.resize(LWS_PRE + total);
            resolight::encodeLightFrameHeader(buf.data() + LWS_PRE, pixelCount, cpp, 0,
                                              conn->sequence.fetch_add(1, std::memory_order_relaxed));
            std::memcpy(buf.data() + LWS_PRE + resolight::kLightFrameHeaderSize,
                        conn->pixelBytes.data(), conn->pixelBytes.size());
            conn->lastSentAt = std::chrono::steady_clock::now();
        }
        const int n = lws_write(wsi, buf.data() + LWS_PRE, buf.size() - LWS_PRE, LWS_WRITE_BINARY);
        if (n < 0) return -1;
        return 0;
    }

    if (reason == LWS_CALLBACK_CLIENT_RECEIVE) {
        if (conn != nullptr && in != nullptr) {
            resolight::StatusFrame sf{};
            if (resolight::decodeStatusFrame(static_cast<const uint8_t*>(in), len, sf)) {
                // The board naming its UDP port is what moves light frames off
                // this socket -- see sendFrameOverUdp(). Until then (or on a
                // board reporting 0) the writable path below keeps carrying
                // them, so older firmware still lights up.
                conn->udpPort.store(sf.lightUdpPort, std::memory_order_relaxed);
                std::lock_guard<std::mutex> lk(conn->statusMutex);
                conn->rssiDbm = -static_cast<int>(sf.rssiAbs);
                conn->chipType = chipTypeName(sf.chipType);
                conn->lastStatusAt = std::chrono::steady_clock::now();
            }
        }
        return 0;
    }

    if (reason == LWS_CALLBACK_CLIENT_CONNECTION_ERROR || reason == LWS_CALLBACK_CLIENT_CLOSED) {
        if (conn != nullptr) {
            conn->wsi = nullptr;
            conn->state = LightHardwareServer::Connection::State::Idle;
            conn->backoffSeconds = std::min(conn->backoffSeconds * 2.0, kMaxBackoffSeconds);
            conn->nextAttemptAt = std::chrono::steady_clock::now() +
                std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                    std::chrono::duration<double>(conn->backoffSeconds));
        }
        return 0;
    }

    return 0;
}

} // namespace

LightHardwareServer::LightHardwareServer() = default;

LightHardwareServer::~LightHardwareServer() {
    stop();
}

void LightHardwareServer::start() {
    if (running_.exchange(true, std::memory_order_acq_rel))
        return;

    static struct lws_protocols protocols[] = {
        {
            "resolight",
            clientCallback,
            0, // per-session data: unused, we use opaque_user_data instead
            kRxBufferSize,
            0, nullptr, 0
        },
        LWS_PROTOCOL_LIST_TERM
    };

    lws_set_log_level(LLL_ERR, nullptr);

    struct lws_context_creation_info info;
    std::memset(&info, 0, sizeof(info));
    info.port = CONTEXT_PORT_NO_LISTEN; // client-only: never listens
    info.protocols = protocols;
    info.options = 0;

    // Send-only, non-blocking UDP socket for light frames. Created before the
    // threads so the very first frame can already go out on it. A failure
    // here is survivable: udpPort stays unusable and every board falls back
    // to the WebSocket path.
    udpSocket_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (udpSocket_ >= 0) {
        const int flags = ::fcntl(udpSocket_, F_GETFL, 0);
        if (flags >= 0)
            ::fcntl(udpSocket_, F_SETFL, flags | O_NONBLOCK);
        // A light frame is one datagram; make sure the kernel will take a
        // burst of them (one per board) without blocking the engine thread.
        const int sndbuf = 256 * 1024;
        ::setsockopt(udpSocket_, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
    }

    clientContext_ = lws_create_context(&info);
    // clientContext_ == nullptr is survivable: networkThreadLoop below
    // simply has nothing to service and every connection attempt is
    // skipped -- the rig behaves exactly like preview-only mode instead of
    // crashing the app over an optional feature.

    discoveryThread_ = std::thread([this] { discoveryThreadLoop(); });
    networkThread_ = std::thread([this] { networkThreadLoop(); });
}

void LightHardwareServer::stop() {
    if (!running_.exchange(false, std::memory_order_acq_rel))
        return;

    if (discoverySocket_ >= 0) {
        // Wake the blocking recvfrom() in discoveryThreadLoop by closing
        // out from under it -- simpler and more portable than a self-pipe
        // for a listener this low-traffic; the loop's recvfrom error path
        // just re-checks `running_` and exits.
        ::close(discoverySocket_);
        discoverySocket_ = -1;
    }
    if (udpSocket_ >= 0) {
        ::close(udpSocket_);
        udpSocket_ = -1;
    }
    if (discoveryThread_.joinable())
        discoveryThread_.join();

    if (clientContext_ != nullptr)
        lws_cancel_service(clientContext_);
    if (networkThread_.joinable())
        networkThread_.join();
    if (clientContext_ != nullptr) {
        lws_context_destroy(clientContext_);
        clientContext_ = nullptr;
    }
}

void LightHardwareServer::updateFixtureFrame(const std::string& fixtureId, const std::string& host, uint16_t port,
                                              uint8_t channelsPerPixel, const uint8_t* pixelBytes,
                                              size_t pixelByteCount, double refreshHz) {
    Connection* conn = nullptr;
    {
        std::lock_guard<std::mutex> lk(connectionsMutex_);
        auto it = connections_.find(fixtureId);
        if (it == connections_.end()) {
            auto owned = std::make_unique<Connection>();
            owned->fixtureId = fixtureId;
            conn = owned.get();
            connections_.emplace(fixtureId, std::move(owned));
        } else {
            conn = it->second.get();
        }
    }
    {
        std::lock_guard<std::mutex> lk(conn->targetMutex);
        if (conn->host != host || conn->port != port) {
            conn->host = host;
            conn->port = port;
            conn->hostChanged = true;
        }
        conn->wantsConnection = true;
    }
    {
        std::lock_guard<std::mutex> lk(conn->frameMutex);
        conn->channelsPerPixel = channelsPerPixel;
        conn->pixelBytes.assign(pixelBytes, pixelBytes + pixelByteCount);
        conn->refreshHz = refreshHz;
        conn->hasFrame = true;
    }

    // Preferred path: straight out of this thread, the instant the frame
    // exists. The WebSocket path in networkThreadLoop() stays as the fallback
    // for a board that has not told us a UDP port (older firmware), and its
    // own rate limiter keeps it from double-sending when UDP is carrying the
    // frames.
    sendFrameOverUdp(*conn, channelsPerPixel, pixelBytes, pixelByteCount, refreshHz, host);
}

// Called on the LightEngine thread. One non-blocking sendto per frame per
// board -- cheaper than the vector work the caller already did to build the
// pixel bytes, and it never blocks: a full socket buffer returns EWOULDBLOCK
// and we simply drop that frame, which for periodic full-state data is
// exactly the right answer.
void LightHardwareServer::sendFrameOverUdp(Connection& conn, uint8_t channelsPerPixel,
                                            const uint8_t* pixelBytes, size_t pixelByteCount,
                                            double refreshHz, const std::string& host) {
    const uint16_t port = conn.udpPort.load(std::memory_order_relaxed);
    if (port == 0 || udpSocket_ < 0 || pixelBytes == nullptr || pixelByteCount == 0)
        return;

    const auto now = std::chrono::steady_clock::now();
    const double interval = 1.0 / std::max(1.0, refreshHz);
    if (conn.lastUdpSentAt.time_since_epoch().count() != 0
        && std::chrono::duration<double>(now - conn.lastUdpSentAt).count() < interval)
        return;

    // Resolve the host once and cache it -- inet_pton on a dotted quad is
    // cheap, but this runs 60 times a second per board and the address only
    // changes when the operator retypes it.
    if (conn.udpAddrHost != host) {
        in_addr addr{};
        if (::inet_pton(AF_INET, host.c_str(), &addr) != 1)
            return; // not a literal IP; the WS path resolves names for us
        conn.udpAddr.store(addr.s_addr, std::memory_order_relaxed);
        conn.udpAddrHost = host;
    }
    const uint32_t rawAddr = conn.udpAddr.load(std::memory_order_relaxed);
    if (rawAddr == 0)
        return;

    const uint8_t cpp = channelsPerPixel > 0 ? channelsPerPixel : 1;
    const size_t pixels = pixelByteCount / cpp;
    if (pixels == 0 || pixels > 0xFFFF)
        return;
    const size_t total = resolight::lightFramePayloadSize(static_cast<uint16_t>(pixels), cpp);

    conn.udpScratch.resize(total);
    resolight::encodeLightFrameHeader(conn.udpScratch.data(), static_cast<uint16_t>(pixels), cpp,
                                      /*flags=*/0,
                                      conn.sequence.fetch_add(1, std::memory_order_relaxed));
    std::memcpy(conn.udpScratch.data() + resolight::kLightFrameHeaderSize, pixelBytes,
                pixelByteCount);

    sockaddr_in dest{};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(port);
    dest.sin_addr.s_addr = rawAddr;

    const ssize_t sent = ::sendto(udpSocket_, conn.udpScratch.data(), conn.udpScratch.size(),
                                  0, reinterpret_cast<sockaddr*>(&dest), sizeof(dest));
    if (sent >= 0)
        conn.lastUdpSentAt = now;
}

void LightHardwareServer::syncActiveFixtures(const std::vector<ActiveFixtureTarget>& active) {
    std::lock_guard<std::mutex> lk(connectionsMutex_);
    for (auto& [fixtureId, connPtr] : connections_) {
        const bool stillActive = std::any_of(active.begin(), active.end(),
            [&](const ActiveFixtureTarget& t) { return t.fixtureId == fixtureId; });
        if (!stillActive) {
            std::lock_guard<std::mutex> tlk(connPtr->targetMutex);
            connPtr->wantsConnection = false;
        }
    }
    for (const auto& t : active) {
        auto it = connections_.find(t.fixtureId);
        if (it == connections_.end()) {
            auto owned = std::make_unique<Connection>();
            owned->fixtureId = t.fixtureId;
            {
                std::lock_guard<std::mutex> tlk(owned->targetMutex);
                owned->host = t.host;
                owned->port = t.port;
                owned->wantsConnection = true;
                owned->hostChanged = true;
            }
            connections_.emplace(t.fixtureId, std::move(owned));
        } else {
            std::lock_guard<std::mutex> tlk(it->second->targetMutex);
            if (it->second->host != t.host || it->second->port != t.port) {
                it->second->host = t.host;
                it->second->port = t.port;
                it->second->hostChanged = true;
            }
            it->second->wantsConnection = true;
        }
    }
}

std::vector<LightHardwareServer::DiscoveredBoard> LightHardwareServer::discoveredBoards() const {
    std::vector<DiscoveredBoard> out;
    std::lock_guard<std::mutex> lk(discoveredMutex_);
    const auto now = std::chrono::steady_clock::now();
    for (const auto& [mac, entry] : discovered_) {
        const double ago = std::chrono::duration<double>(now - entry.lastSeenAt).count();
        if (ago > kDiscoveryStaleSeconds) continue;
        DiscoveredBoard b;
        b.mac = mac;
        b.ip = entry.ip;
        b.name = entry.name;
        b.chipType = entry.chipType;
        b.lastSeenSecondsAgo = ago;
        out.push_back(std::move(b));
    }
    return out;
}

LightHardwareServer::FixtureLinkStatus LightHardwareServer::fixtureLinkStatus(const std::string& fixtureId) const {
    FixtureLinkStatus status;
    const Connection* conn = nullptr;
    {
        std::lock_guard<std::mutex> lk(connectionsMutex_);
        auto it = connections_.find(fixtureId);
        if (it == connections_.end()) return status;
        conn = it->second.get();
    }
    if (conn == nullptr) return status;
    status.configured = true;

    const auto now = std::chrono::steady_clock::now();
    bool recentlySent = false;
    {
        std::lock_guard<std::mutex> lk(conn->frameMutex);
        if (conn->hasFrame) {
            status.lastFrameSecondsAgo =
                std::chrono::duration<double>(now - conn->lastSentAt).count();
            recentlySent = status.lastFrameSecondsAgo < 2.0;
        }
    }
    std::lock_guard<std::mutex> lk(conn->statusMutex);
    const bool hasStatus = conn->lastStatusAt.time_since_epoch().count() != 0;
    const double statusAgo = hasStatus
        ? std::chrono::duration<double>(now - conn->lastStatusAt).count()
        : -1.0;
    // Prefer a recent board heartbeat; fall back to "we successfully sent a
    // frame very recently" when the board never emits status (older firmware).
    status.connected = conn->everConnected &&
        ((hasStatus && statusAgo >= 0.0 && statusAgo < 10.0) || recentlySent);
    status.rssiDbm = conn->rssiDbm;
    status.chipType = conn->chipType;
    status.lastStatusSecondsAgo = statusAgo;
    return status;
}

void LightHardwareServer::discoveryThreadLoop() {
    discoverySocket_ = socket(AF_INET, SOCK_DGRAM, 0);
    if (discoverySocket_ < 0) return;

    const int reuse = 1;
    setsockopt(discoverySocket_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(resolight::kDiscoveryPort);
    if (bind(discoverySocket_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(discoverySocket_);
        discoverySocket_ = -1;
        return; // port in use or no permission -- discovery is optional, not fatal
    }

    uint8_t buf[128];
    while (running_.load(std::memory_order_acquire)) {
        sockaddr_in from{};
        socklen_t fromLen = sizeof(from);
        const ssize_t n = recvfrom(discoverySocket_, buf, sizeof(buf), 0,
                                    reinterpret_cast<sockaddr*>(&from), &fromLen);
        if (n < 0) break; // socket closed by stop(), or a real error -- either way, exit
        if (!running_.load(std::memory_order_acquire)) break;

        resolight::DiscoveryBeacon beacon{};
        if (!resolight::decodeDiscoveryBeacon(buf, static_cast<size_t>(n), beacon))
            continue;

        char ipStr[INET_ADDRSTRLEN] = {0};
        inet_ntop(AF_INET, &from.sin_addr, ipStr, sizeof(ipStr));

        DiscoveredEntry entry;
        entry.ip = ipStr;
        entry.name = beacon.name;
        entry.chipType = chipTypeName(beacon.chipType);
        entry.lastSeenAt = std::chrono::steady_clock::now();

        const std::string mac = macToHex(beacon.mac);
        std::lock_guard<std::mutex> lk(discoveredMutex_);
        discovered_[mac] = std::move(entry);
    }
}

void LightHardwareServer::networkThreadLoop() {
    if (clientContext_ == nullptr) return;

    while (running_.load(std::memory_order_acquire)) {
        const auto now = std::chrono::steady_clock::now();
        {
            std::lock_guard<std::mutex> lk(connectionsMutex_);
            for (auto& [fixtureId, connPtr] : connections_) {
                Connection& conn = *connPtr;

                bool wants = false, hostChanged = false;
                std::string host;
                uint16_t port = 0;
                {
                    std::lock_guard<std::mutex> tlk(conn.targetMutex);
                    wants = conn.wantsConnection;
                    hostChanged = conn.hostChanged;
                    conn.hostChanged = false;
                    host = conn.host;
                    port = conn.port;
                }

                // Host changed (or hardware was un-paired) while a
                // connection was open/connecting -- drop it so the next
                // pass redials the right target instead of talking to a
                // stale one. Safe to call lws_set_timeout here: we are on
                // the thread that owns clientContext_'s service loop.
                if ((hostChanged || !wants) && conn.wsi != nullptr &&
                    conn.state == Connection::State::Open) {
                    lws_set_timeout(conn.wsi, PENDING_TIMEOUT_CLOSE_SEND, 1);
                    conn.state = Connection::State::ClosingForRedial;
                }

                if (!wants || host.empty() || port == 0) continue;

                if (conn.state == Connection::State::Idle && now >= conn.nextAttemptAt) {
                    conn.dialHost = host; // stable storage for the duration of the dial
                    conn.dialPort = port;

                    struct lws_client_connect_info ccinfo;
                    std::memset(&ccinfo, 0, sizeof(ccinfo));
                    ccinfo.context = clientContext_;
                    ccinfo.address = conn.dialHost.c_str();
                    ccinfo.port = conn.dialPort;
                    ccinfo.path = resolight::kLightWsPath;
                    ccinfo.host = conn.dialHost.c_str();
                    ccinfo.origin = conn.dialHost.c_str();
                    ccinfo.protocol = "resolight";
                    ccinfo.opaque_user_data = &conn;
                    ccinfo.ssl_connection = 0;

                    conn.state = Connection::State::Connecting;
                    if (lws_client_connect_via_info(&ccinfo) == nullptr) {
                        conn.state = Connection::State::Idle;
                        conn.backoffSeconds = std::min(conn.backoffSeconds * 2.0, kMaxBackoffSeconds);
                        conn.nextAttemptAt = now + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                                                        std::chrono::duration<double>(conn.backoffSeconds));
                    }
                } else if (conn.state == Connection::State::Open && conn.wsi != nullptr) {
                    // Fallback only. Once the board has named a UDP port the
                    // frames go out from the engine thread the moment they
                    // exist (sendFrameOverUdp), and re-sending them here would
                    // be both redundant and, at this loop's 5 ms poll
                    // granularity, later.
                    bool due = false;
                    if (conn.udpPort.load(std::memory_order_relaxed) == 0) {
                        std::lock_guard<std::mutex> flk(conn.frameMutex);
                        const double intervalSec = 1.0 / std::max(1.0, conn.refreshHz);
                        due = conn.hasFrame &&
                              std::chrono::duration<double>(now - conn.lastSentAt).count() >= intervalSec;
                    }
                    if (due) lws_callback_on_writable(conn.wsi);
                }
            }
        }

        const int n = lws_service(clientContext_, 5);
        if (n < 0) break;
    }
}

} // namespace resostage
