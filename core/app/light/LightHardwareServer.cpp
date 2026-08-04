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
            resolight::encodeLightFrameHeader(buf.data() + LWS_PRE, pixelCount, cpp, 0);
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
                    bool due = false;
                    {
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
