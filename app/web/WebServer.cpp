#include "WebServer.h"
#include "EmbeddedAssets.h"

#include <libwebsockets.h>

#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <vector>

namespace resoset {

namespace {

// lws requires LWS_PRE bytes of padding before every write buffer.
constexpr size_t kWsTxMax = 16 * 1024;

struct WsSession {
    WebServer* server = nullptr;
    struct lws* wsi = nullptr;
    bool writePending = false;
};

// Per-HTTP-transaction body accumulator for small REST POSTs.
struct HttpSession {
    char path[256]{};
    char method[16]{};
    std::vector<char> body;
    bool isApi = false;
    bool isStatic = false;
};

std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// Guards against NaN/Inf reaching the wire: ostringstream would emit "nan"/
// "inf" tokens, which are not valid JSON and would make every connected
// browser's JSON.parse() throw, silently freezing the remote UI. Mirrors the
// equivalent guard in ProjectJson.cpp's writeNumber().
double finiteOrZero(double v) {
    return std::isfinite(v) ? v : 0.0;
}

// Minimal body parse for {"index": N}. Avoids a JSON dependency for one field.
int parseSelectIndex(const char* body, size_t len) {
    if (body == nullptr || len == 0)
        return -1;
    const std::string s(body, len);
    const auto pos = s.find("\"index\"");
    if (pos == std::string::npos)
        return -1;
    const auto colon = s.find(':', pos);
    if (colon == std::string::npos)
        return -1;
    try {
        return std::stoi(s.substr(colon + 1));
    } catch (...) {
        return -1;
    }
}

int writeHttpResponse(struct lws* wsi, int status, const char* contentType,
                      const char* body, size_t bodyLen) {
    uint8_t buf[LWS_PRE + 512];
    uint8_t* start = &buf[LWS_PRE];
    uint8_t* p = start;
    uint8_t* end = &buf[sizeof(buf) - 1];

    if (lws_add_http_common_headers(wsi, static_cast<unsigned int>(status), contentType,
                                    bodyLen, &p, end))
        return 1;
    // CORS for LAN tablets / other origins (local network only use-case).
    if (lws_add_http_header_by_name(wsi,
                                    reinterpret_cast<const unsigned char*>("access-control-allow-origin"),
                                    reinterpret_cast<const unsigned char*>("*"), 1, &p, end))
        return 1;
    if (lws_finalize_write_http_header(wsi, start, &p, end))
        return 1;

    if (body != nullptr && bodyLen > 0) {
        // Body may be large (SPA); stage via a heap buffer with LWS_PRE headroom.
        std::vector<uint8_t> tx(LWS_PRE + bodyLen);
        std::memcpy(tx.data() + LWS_PRE, body, bodyLen);
        if (lws_write(wsi, tx.data() + LWS_PRE, bodyLen, LWS_WRITE_HTTP_FINAL) < 0)
            return 1;
    } else {
        // Empty body still needs FINAL for h2 stream close.
        unsigned char empty = 0;
        lws_write(wsi, &empty, 0, LWS_WRITE_HTTP_FINAL);
    }

    if (lws_http_transaction_completed(wsi))
        return -1;
    return 0;
}

} // namespace

// ---------------------------------------------------------------------------
// HTTP callback (protocol index 0)
// ---------------------------------------------------------------------------

int resosetHttpCallback(struct lws* wsi, int reason, void* user, void* in, size_t len) {
    auto* pss = static_cast<HttpSession*>(user);
    auto* server = static_cast<WebServer*>(lws_context_user(lws_get_context(wsi)));
    const auto why = static_cast<enum lws_callback_reasons>(reason);

    // if/else (not switch-enum): lws has 100+ callback reasons; only a few apply.
    if (why == LWS_CALLBACK_HTTP) {
            if (pss == nullptr || server == nullptr)
                return -1;

            pss->body.clear();
            pss->isApi = false;
            pss->isStatic = false;

            const char* uri = static_cast<const char*>(in);
            if (uri == nullptr)
                uri = "/";

            // WebSocket upgrade (e.g. GET /ws) must not be answered as HTML --
            // hand it back to lws so the connection switches to the "resoset"
            // protocol callback.
            if (lws_hdr_total_length(wsi, WSI_TOKEN_UPGRADE) > 0
                || std::strcmp(uri, "/ws") == 0) {
                return lws_callback_http_dummy(wsi, why, user, in, len);
            }

            // lws sets different URI tokens per method; POST_URI present => POST.
            const bool isPost = lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) > 0;
            const char* method = isPost ? "POST" : "GET";

            std::snprintf(pss->path, sizeof(pss->path), "%s", uri);
            std::snprintf(pss->method, sizeof(pss->method), "%s", method);

            if (std::strncmp(uri, "/api/", 5) == 0) {
                pss->isApi = true;

                if (!isPost) {
                    if (std::strcmp(uri, "/api/v1/state") == 0) {
                        const std::string json = server->buildStateJson();
                        return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json",
                                                 json.c_str(), json.size());
                    }
                    return writeHttpResponse(wsi, HTTP_STATUS_NOT_FOUND, "application/json",
                                             "{\"error\":\"not found\"}", 27);
                }

                // POST with no body (Content-Length 0 / absent): handle now.
                // POSTs with a body wait for HTTP_BODY_COMPLETION.
                const int contentLen = lws_hdr_total_length(wsi, WSI_TOKEN_HTTP_CONTENT_LENGTH);
                char clBuf[32] = "0";
                if (contentLen > 0)
                    lws_hdr_copy(wsi, clBuf, sizeof(clBuf), WSI_TOKEN_HTTP_CONTENT_LENGTH);
                const long cl = std::strtol(clBuf, nullptr, 10);
                if (cl <= 0) {
                    if (server->handleHttpApi(wsi, pss->path, pss->method, "", 0))
                        return 0;
                    return writeHttpResponse(wsi, HTTP_STATUS_NOT_FOUND, "application/json",
                                             "{\"error\":\"not found\"}", 27);
                }
                return 0;
            }

            pss->isStatic = true;
            return server->serveStatic(wsi, uri);
    }

    if (why == LWS_CALLBACK_HTTP_BODY) {
            if (pss == nullptr || !pss->isApi)
                return lws_callback_http_dummy(wsi, why, user, in, len);
            const char* chunk = static_cast<const char*>(in);
            if (chunk != nullptr && len > 0) {
                // Cap body size to keep bad clients from filling RAM.
                if (pss->body.size() + len > 4096)
                    return -1;
                pss->body.insert(pss->body.end(), chunk, chunk + len);
            }
            return 0;
    }

    if (why == LWS_CALLBACK_HTTP_BODY_COMPLETION) {
            if (pss == nullptr || server == nullptr || !pss->isApi)
                return lws_callback_http_dummy(wsi, why, user, in, len);
            const char* body = pss->body.empty() ? "" : pss->body.data();
            const size_t bodyLen = pss->body.size();
            if (server->handleHttpApi(wsi, pss->path, pss->method, body, bodyLen))
                return 0;
            return writeHttpResponse(wsi, HTTP_STATUS_NOT_FOUND, "application/json",
                                     "{\"error\":\"not found\"}", 27);
    }

    return lws_callback_http_dummy(wsi, why, user, in, len);
}

// ---------------------------------------------------------------------------
// WebSocket callback (protocol index 1)
// ---------------------------------------------------------------------------

int resosetWsCallback(struct lws* wsi, int reason, void* user, void* in, size_t len) {
    auto* pss = static_cast<WsSession*>(user);
    auto* server = static_cast<WebServer*>(lws_context_user(lws_get_context(wsi)));
    (void)in;
    (void)len;
    const auto why = static_cast<enum lws_callback_reasons>(reason);

    if (why == LWS_CALLBACK_ESTABLISHED) {
            if (pss == nullptr || server == nullptr)
                return -1;
            pss->server = server;
            pss->wsi = wsi;
            pss->writePending = true;
            server->onClientOpened();
            // ~30 FPS telemetry.
            lws_set_timer_usecs(wsi, 33 * 1000);
            lws_callback_on_writable(wsi);
            return 0;
    }

    if (why == LWS_CALLBACK_CLOSED) {
            if (server != nullptr)
                server->onClientClosed();
            return 0;
    }

    if (why == LWS_CALLBACK_TIMER) {
            if (pss != nullptr) {
                pss->writePending = true;
                lws_callback_on_writable(wsi);
                lws_set_timer_usecs(wsi, 33 * 1000);
            }
            return 0;
    }

    if (why == LWS_CALLBACK_SERVER_WRITEABLE) {
            if (pss == nullptr || server == nullptr || !pss->writePending)
                return 0;
            pss->writePending = false;

            const std::string json = server->buildStateJson();
            if (json.size() + LWS_PRE > kWsTxMax)
                return 0;

            std::vector<uint8_t> buf(LWS_PRE + json.size());
            std::memcpy(buf.data() + LWS_PRE, json.data(), json.size());
            const int n = lws_write(wsi, buf.data() + LWS_PRE, json.size(), LWS_WRITE_TEXT);
            if (n < 0)
                return -1;
            return 0;
    }

    if (why == LWS_CALLBACK_RECEIVE) {
            // Optional: clients may send {"action":"play"} over WS too.
            if (server == nullptr || in == nullptr || len == 0)
                return 0;
            const std::string msg(static_cast<const char*>(in), len);
            if (msg.find("\"play\"") != std::string::npos)
                server->enqueueCommand({WebCommandKind::Play, 0});
            else if (msg.find("\"stop\"") != std::string::npos)
                server->enqueueCommand({WebCommandKind::Stop, 0});
            else if (msg.find("\"next\"") != std::string::npos)
                server->enqueueCommand({WebCommandKind::Next, 0});
            else if (msg.find("\"prev\"") != std::string::npos)
                server->enqueueCommand({WebCommandKind::Prev, 0});
            else if (msg.find("\"select\"") != std::string::npos) {
                const int idx = parseSelectIndex(msg.c_str(), msg.size());
                if (idx >= 0)
                    server->enqueueCommand({WebCommandKind::SelectSong, idx});
            }
            return 0;
    }

    return 0;
}

// ---------------------------------------------------------------------------
// WebServer
// ---------------------------------------------------------------------------

WebServer::WebServer() = default;

WebServer::~WebServer() {
    stop();
}

bool WebServer::start(uint16_t port, std::string& error) {
    if (running.load(std::memory_order_acquire)) {
        error = "WebServer already running";
        return false;
    }

    stopRequested.store(false, std::memory_order_release);

    // Protocols must outlive the context; keep them as static storage.
    static struct lws_protocols protocols[] = {
        {
            "http",
            // lws wants lws_callback_function*; our free functions match.
            [](struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) -> int {
                return resosetHttpCallback(wsi, static_cast<int>(reason), user, in, len);
            },
            sizeof(HttpSession),
            4096,
            0, nullptr, 0
        },
        {
            "resoset",
            [](struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) -> int {
                return resosetWsCallback(wsi, static_cast<int>(reason), user, in, len);
            },
            sizeof(WsSession),
            kWsTxMax,
            0, nullptr, 0
        },
        LWS_PROTOCOL_LIST_TERM
    };

    // Quiet by default -- ERR only. (lws is chatty at NOTICE.)
    lws_set_log_level(LLL_ERR | LLL_WARN, nullptr);

    struct lws_context_creation_info info;
    std::memset(&info, 0, sizeof(info));
    info.port = port;
    info.protocols = protocols;
    info.options = LWS_SERVER_OPTION_HTTP_HEADERS_SECURITY_BEST_PRACTICES_ENFORCE
                 | LWS_SERVER_OPTION_VALIDATE_UTF8;
    info.user = this;
    // No mounts -- everything is served from memory in the HTTP callback.
    info.mounts = nullptr;

    context = lws_create_context(&info);
    if (context == nullptr) {
        error = "lws_create_context failed (port in use?)";
        return false;
    }

    boundPort.store(port, std::memory_order_relaxed);
    running.store(true, std::memory_order_release);
    serviceThread = std::thread([this] { serviceLoop(); });
    return true;
}

void WebServer::stop() {
    if (!running.load(std::memory_order_acquire) && context == nullptr)
        return;

    stopRequested.store(true, std::memory_order_release);
    if (context != nullptr)
        lws_cancel_service(context);

    if (serviceThread.joinable())
        serviceThread.join();

    if (context != nullptr) {
        lws_context_destroy(context);
        context = nullptr;
    }
    running.store(false, std::memory_order_release);
    clients.store(0, std::memory_order_relaxed);
}

void WebServer::serviceLoop() {
    while (!stopRequested.load(std::memory_order_acquire)) {
        // timeout 50ms so we notice stopRequested promptly even without cancel.
        const int n = lws_service(context, 50);
        if (n < 0)
            break;
    }
}

void WebServer::publishState(const WebUiState& next) {
    std::lock_guard<std::mutex> lock(stateMutex);
    state = next;
}

bool WebServer::pollCommand(WebCommand& out) {
    return commands.try_dequeue(out);
}

void WebServer::enqueueCommand(WebCommand cmd) {
    commands.try_enqueue(cmd);
}

void WebServer::onClientOpened() {
    clients.fetch_add(1, std::memory_order_relaxed);
}

void WebServer::onClientClosed() {
    int expected = clients.load(std::memory_order_relaxed);
    while (expected > 0
           && !clients.compare_exchange_weak(expected, expected - 1, std::memory_order_relaxed)) {
        // retry
    }
    if (expected <= 0)
        clients.store(0, std::memory_order_relaxed);
}

void WebServer::broadcastWritable() {
    // Unused for now -- per-session timers drive telemetry.
}

std::string WebServer::buildStateJson() const {
    WebUiState snap;
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        snap = state;
    }

    std::ostringstream o;
    o.setf(std::ios::fixed);
    o.precision(3);

    o << "{"
      << "\"projectName\":\"" << jsonEscape(snap.projectName) << "\","
      << "\"songName\":\"" << jsonEscape(snap.songName) << "\","
      << "\"playheadSeconds\":" << finiteOrZero(snap.playheadSeconds) << ","
      << "\"sampleRate\":" << finiteOrZero(snap.sampleRate) << ","
      << "\"drift\":" << finiteOrZero(snap.driftFactor) << ","
      << "\"bpm\":" << finiteOrZero(snap.bpm) << ","
      << "\"playing\":" << (snap.playing ? "true" : "false") << ","
      << "\"hardwareAlarm\":" << (snap.hardwareAlarm ? "true" : "false") << ","
      << "\"songIndex\":" << snap.songIndex << ","
      << "\"songCount\":" << snap.songCount << ",";

    o << "\"songs\":[";
    for (size_t i = 0; i < snap.songs.size(); ++i) {
        if (i) o << ",";
        o << "{\"name\":\"" << jsonEscape(snap.songs[i].name) << "\","
          << "\"bpm\":" << finiteOrZero(snap.songs[i].bpm) << ","
          << "\"mode\":\"" << (snap.songs[i].autoplay ? "auto" : "wait") << "\"}";
    }
    o << "],";

    o << "\"meters\":[";
    for (size_t i = 0; i < snap.meters.size(); ++i) {
        if (i) o << ",";
        o << "{\"id\":\"" << jsonEscape(snap.meters[i].id) << "\","
          << "\"peakDb\":" << finiteOrZero(snap.meters[i].peakDb) << ","
          << "\"shortTermLufs\":" << finiteOrZero(snap.meters[i].shortTermLufs) << "}";
    }
    o << "],";

    o << "\"tracks\":[";
    for (size_t i = 0; i < snap.tracks.size(); ++i) {
        if (i) o << ",";
        const auto& t = snap.tracks[i];
        o << "{\"id\":\"" << jsonEscape(t.id) << "\","
          << "\"name\":\"" << jsonEscape(t.name) << "\","
          << "\"busId\":\"" << jsonEscape(t.busId) << "\","
          << "\"gainDb\":" << finiteOrZero(t.gainDb) << ","
          << "\"pan\":" << finiteOrZero(t.pan) << ","
          << "\"mute\":" << (t.mute ? "true" : "false") << ","
          << "\"solo\":" << (t.solo ? "true" : "false") << ","
          << "\"sends\":" << t.sends << ","
          << "\"peakDb\":" << finiteOrZero(t.peakDb) << "}";
    }
    o << "],";

    o << "\"busses\":[";
    for (size_t i = 0; i < snap.busses.size(); ++i) {
        if (i) o << ",";
        const auto& b = snap.busses[i];
        o << "{\"id\":\"" << jsonEscape(b.id) << "\","
          << "\"name\":\"" << jsonEscape(b.name) << "\","
          << "\"gainDb\":" << finiteOrZero(b.gainDb) << ","
          << "\"mute\":" << (b.mute ? "true" : "false") << ","
          << "\"solo\":" << (b.solo ? "true" : "false") << ","
          << "\"isAux\":" << (b.isAux ? "true" : "false") << ","
          << "\"startChannel\":" << b.startChannel << ","
          << "\"peakDb\":" << finiteOrZero(b.peakDb) << "}";
    }
    o << "],";

    o << "\"health\":{"
      << "\"cpuPercent\":" << finiteOrZero(snap.cpuPercent) << ","
      << "\"rssBytes\":" << snap.rssBytes << ","
      << "\"freeBytes\":" << snap.freeBytes << ","
      << "\"underrunCount\":" << snap.underrunCount << ","
      << "\"audioCallbackCount\":" << snap.audioCallbackCount << ","
      << "\"webClientCount\":" << snap.webClientCount
      << "}"
      << "}";

    return o.str();
}

bool WebServer::handleHttpApi(struct lws* wsi, const char* path, const char* method,
                               const char* body, size_t bodyLen) {
    if (path == nullptr || method == nullptr)
        return false;
    if (std::strcmp(method, "POST") != 0)
        return false;

    WebCommand cmd;
    bool ok = true;

    if (std::strcmp(path, "/api/v1/transport/play") == 0) {
        cmd = {WebCommandKind::Play, 0};
    } else if (std::strcmp(path, "/api/v1/transport/stop") == 0) {
        cmd = {WebCommandKind::Stop, 0};
    } else if (std::strcmp(path, "/api/v1/transport/next") == 0) {
        cmd = {WebCommandKind::Next, 0};
    } else if (std::strcmp(path, "/api/v1/transport/prev") == 0) {
        cmd = {WebCommandKind::Prev, 0};
    } else if (std::strcmp(path, "/api/v1/transport/select") == 0) {
        const int idx = parseSelectIndex(body, bodyLen);
        if (idx < 0) {
            writeHttpResponse(wsi, HTTP_STATUS_BAD_REQUEST, "application/json",
                              "{\"error\":\"missing index\"}", 28);
            return true;
        }
        cmd = {WebCommandKind::SelectSong, idx};
    } else {
        ok = false;
    }

    if (!ok)
        return false;

    enqueueCommand(cmd);
    writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", "{\"ok\":true}", 11);
    return true;
}

int WebServer::serveStatic(struct lws* wsi, const char* path) {
    // SPA: everything maps to index.html (single page).
    (void)path;
    return writeHttpResponse(wsi, HTTP_STATUS_OK, embedded_assets::kIndexHtmlMime,
                             embedded_assets::kIndexHtml,
                             std::strlen(embedded_assets::kIndexHtml));
}

} // namespace resoset
