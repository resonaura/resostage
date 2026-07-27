#include "WebServer.h"
#include "EmbeddedAssets.h"

#include <libwebsockets.h>

#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string_view>
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

// Per-HTTP-transaction body accumulator for small REST POSTs. Upload
// (/api/v1/project/upload) is the one path that bypasses `body` entirely --
// project archives can be tens/hundreds of MB, so its bytes are streamed
// straight to `uploadFile` instead of buffered in RAM.
struct HttpSession {
    char path[256]{};
    char method[16]{};
    std::vector<char> body;
    bool isApi = false;
    bool isStatic = false;
    bool isUpload = false;
    bool isWavUpload = false; // distinguishes .../builder/track/import-wav/upload from project upload
    char uploadPath[512]{};
    FILE* uploadFile = nullptr;
};

// Unique temp path for a single upload's bytes; the message thread deletes it
// once it has been fed into ProjectLoader/importWavForTrackAsync (success or
// failure). Extension matters here beyond cosmetics: importWavForTrackAsync
// derives the archive-internal file entry name from this path's basename, so
// a WAV upload must land in a ".wav" file, not ".rsnraset".
std::string makeUploadTempPath(const char* extension) {
    static std::atomic<uint64_t> counter{0};
    const auto n = counter.fetch_add(1, std::memory_order_relaxed);
    const auto ts = std::chrono::steady_clock::now().time_since_epoch().count();
    std::filesystem::path dir = std::filesystem::temp_directory_path();
    std::filesystem::path file =
        dir / ("resostage-upload-" + std::to_string(ts) + "-" + std::to_string(n) + extension);
    return file.string();
}

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

// Finds "key": <raw-value-text> (up to the next , or }) and returns the raw
// slice, trimmed. Same "avoid a JSON dependency" spirit as parseSelectIndex.
bool findJsonField(const std::string& s, const char* key, std::string& outRaw) {
    const auto pos = s.find(key);
    if (pos == std::string::npos)
        return false;
    const auto colon = s.find(':', pos);
    if (colon == std::string::npos)
        return false;
    size_t start = colon + 1;
    while (start < s.size() && (s[start] == ' ' || s[start] == '\t'))
        ++start;
    size_t end = start;
    while (end < s.size() && s[end] != ',' && s[end] != '}')
        ++end;
    while (end > start && (s[end - 1] == ' ' || s[end - 1] == '\t'))
        --end;
    outRaw = s.substr(start, end - start);
    return !outRaw.empty();
}

// Minimal body parse for {"index": N, "value": X} where X is a number or a
// JSON boolean (mixer mute/solo send booleans; gain/pan send numbers).
bool parseIndexAndValue(const char* body, size_t len, int& outIndex, double& outValue) {
    if (body == nullptr || len == 0)
        return false;
    const std::string s(body, len);
    std::string idxRaw, valRaw;
    if (!findJsonField(s, "\"index\"", idxRaw) || !findJsonField(s, "\"value\"", valRaw))
        return false;
    try {
        outIndex = std::stoi(idxRaw);
    } catch (...) {
        return false;
    }
    if (valRaw == "true") {
        outValue = 1.0;
    } else if (valRaw == "false") {
        outValue = 0.0;
    } else {
        try {
            outValue = std::stod(valRaw);
        } catch (...) {
            return false;
        }
    }
    return true;
}

bool isMixerCommandPath(const char* path) {
    static const char* const kPaths[] = {
        "/api/v1/track/gain", "/api/v1/track/pan",  "/api/v1/track/mute", "/api/v1/track/solo",
        "/api/v1/bus/gain",   "/api/v1/bus/mute",   "/api/v1/bus/solo",
    };
    for (const char* p : kPaths)
        if (std::strcmp(path, p) == 0)
            return true;
    return false;
}

WebCommandKind mixerCommandKindForPath(const char* path) {
    if (std::strcmp(path, "/api/v1/track/gain") == 0) return WebCommandKind::SetTrackGain;
    if (std::strcmp(path, "/api/v1/track/pan") == 0) return WebCommandKind::SetTrackPan;
    if (std::strcmp(path, "/api/v1/track/mute") == 0) return WebCommandKind::SetTrackMute;
    if (std::strcmp(path, "/api/v1/track/solo") == 0) return WebCommandKind::SetTrackSolo;
    if (std::strcmp(path, "/api/v1/bus/gain") == 0) return WebCommandKind::SetBusGain;
    if (std::strcmp(path, "/api/v1/bus/mute") == 0) return WebCommandKind::SetBusMute;
    return WebCommandKind::SetBusSolo; // "/api/v1/bus/solo" -- last remaining option per isMixerCommandPath's list
}

// Builder and Settings paths carry their whole payload as a raw JSON
// pass-through (see WebCommand::json) -- WebServer does no field parsing for
// these at all, unlike the mixer paths above.
struct BuilderRoute {
    const char* path;
    WebCommandKind kind;
};
constexpr BuilderRoute kBuilderRoutes[] = {
    {"/api/v1/builder/song/add", WebCommandKind::BuilderSongAdd},
    {"/api/v1/builder/song/remove", WebCommandKind::BuilderSongRemove},
    {"/api/v1/builder/song/move", WebCommandKind::BuilderSongMove},
    {"/api/v1/builder/song/update", WebCommandKind::BuilderSongUpdate},
    {"/api/v1/builder/track/add", WebCommandKind::BuilderTrackAdd},
    {"/api/v1/builder/track/remove", WebCommandKind::BuilderTrackRemove},
    {"/api/v1/builder/track/move", WebCommandKind::BuilderTrackMove},
    {"/api/v1/builder/track/update", WebCommandKind::BuilderTrackUpdate},
    {"/api/v1/builder/track/import-wav/begin", WebCommandKind::BuilderTrackImportWavBegin},
    {"/api/v1/builder/bus/add", WebCommandKind::BuilderBusAdd},
    {"/api/v1/builder/bus/remove", WebCommandKind::BuilderBusRemove},
    {"/api/v1/builder/bus/move", WebCommandKind::BuilderBusMove},
    {"/api/v1/builder/bus/update", WebCommandKind::BuilderBusUpdate},
    {"/api/v1/builder/event/add", WebCommandKind::BuilderEventAdd},
    {"/api/v1/builder/event/remove", WebCommandKind::BuilderEventRemove},
    {"/api/v1/builder/event/move", WebCommandKind::BuilderEventMove},
    {"/api/v1/builder/event/update", WebCommandKind::BuilderEventUpdate},
    {"/api/v1/settings/audio-device", WebCommandKind::SetAudioOutputDevice},
    {"/api/v1/settings/sample-rate", WebCommandKind::SetSampleRate},
    {"/api/v1/settings/buffer-size", WebCommandKind::SetBufferSize},
    {"/api/v1/settings/midi-output", WebCommandKind::SetMidiOutput},
    {"/api/v1/settings/midi-input", WebCommandKind::SetMidiInput},
    {"/api/v1/settings/keybinding", WebCommandKind::SetKeybinding},
    {"/api/v1/settings/output-channels", WebCommandKind::SetOutputChannels},
    {"/api/v1/transport/seek", WebCommandKind::Seek},
};

bool builderCommandKindForPath(const char* path, WebCommandKind& outKind) {
    for (const auto& route : kBuilderRoutes) {
        if (std::strcmp(path, route.path) == 0) {
            outKind = route.kind;
            return true;
        }
    }
    return false;
}

// Keeps a WAV upload's archive entry human-readable ("Audio/kick.wav")
// instead of a generic temp name -- see makeUploadTempPath's doc comment.
// Deliberately conservative: only characters that are safe as both a
// filesystem path component and a zip entry name survive.
std::string sanitizeUploadFileName(const std::string& name) {
    std::string out;
    out.reserve(name.size());
    for (char c : name) {
        if (std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == '_' || c == ' ')
            out += c;
        else
            out += '_';
    }
    if (out.size() > 120)
        out = out.substr(out.size() - 120); // keep the extension end, not an arbitrarily-truncated prefix
    if (out.empty() || out.find('.') == std::string::npos)
        out += ".wav";
    return out;
}

int writeHttpResponse(struct lws* wsi, int status, const char* contentType,
                      const char* body, size_t bodyLen,
                      const char* contentDisposition = nullptr) {
    uint8_t buf[LWS_PRE + 768];
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
    if (contentDisposition != nullptr) {
        if (lws_add_http_header_by_name(
                wsi, reinterpret_cast<const unsigned char*>("content-disposition"),
                reinterpret_cast<const unsigned char*>(contentDisposition),
                static_cast<int>(std::strlen(contentDisposition)), &p, end))
            return 1;
    }
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

// CORS preflight response for the dev-server case (Vite on :2900 issuing
// cross-origin POSTs to the native backend on :2899). `Content-Type:
// application/json` isn't a CORS "simple" header, so every POST from that
// origin triggers an OPTIONS preflight first -- without this, the browser
// blocks the real request even though the server would have accepted it
// (this doesn't come up in production, where the SPA is served from the
// same origin as the API and no preflight is ever issued).
int writeCorsPreflightResponse(struct lws* wsi) {
    // Same size as writeHttpResponse's buffer -- the security-best-practices
    // headers lws_add_http_common_headers() injects (CSP, X-Frame-Options,
    // etc., see LWS_SERVER_OPTION_HTTP_HEADERS_SECURITY_BEST_PRACTICES_ENFORCE
    // below) eat a few hundred bytes on their own, so anything smaller
    // silently fails partway through adding our own headers.
    uint8_t buf[LWS_PRE + 768];
    uint8_t* start = &buf[LWS_PRE];
    uint8_t* p = start;
    uint8_t* end = &buf[sizeof(buf) - 1];

    if (lws_add_http_common_headers(wsi, HTTP_STATUS_OK, "text/plain", 0, &p, end))
        return 1;
    if (lws_add_http_header_by_name(wsi,
                                    reinterpret_cast<const unsigned char*>("access-control-allow-origin"),
                                    reinterpret_cast<const unsigned char*>("*"), 1, &p, end))
        return 1;
    static const char kMethods[] = "GET, POST, OPTIONS";
    if (lws_add_http_header_by_name(
            wsi, reinterpret_cast<const unsigned char*>("access-control-allow-methods"),
            reinterpret_cast<const unsigned char*>(kMethods),
            static_cast<int>(std::strlen(kMethods)), &p, end))
        return 1;
    static const char kHeaders[] = "Content-Type";
    if (lws_add_http_header_by_name(
            wsi, reinterpret_cast<const unsigned char*>("access-control-allow-headers"),
            reinterpret_cast<const unsigned char*>(kHeaders),
            static_cast<int>(std::strlen(kHeaders)), &p, end))
        return 1;
    static const char kMaxAge[] = "86400";
    if (lws_add_http_header_by_name(wsi,
                                    reinterpret_cast<const unsigned char*>("access-control-max-age"),
                                    reinterpret_cast<const unsigned char*>(kMaxAge),
                                    static_cast<int>(std::strlen(kMaxAge)), &p, end))
        return 1;
    if (lws_finalize_write_http_header(wsi, start, &p, end))
        return 1;

    unsigned char empty = 0;
    if (lws_write(wsi, &empty, 0, LWS_WRITE_HTTP_FINAL) < 0)
        return 1;
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
            pss->isUpload = false;
            pss->isWavUpload = false;
            if (pss->uploadFile != nullptr) {
                // Defensive: a previous transaction on a kept-alive connection
                // aborted mid-upload without a BODY_COMPLETION/CLOSE. Don't leak
                // the handle or the partial temp file into this new request.
                std::fclose(pss->uploadFile);
                std::remove(pss->uploadPath);
                pss->uploadFile = nullptr;
            }

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
            const bool isOptions = lws_hdr_total_length(wsi, WSI_TOKEN_OPTIONS_URI) > 0;
            const char* method = isPost ? "POST" : "GET";

            // Cross-origin preflight (see writeCorsPreflightResponse's doc
            // comment) -- only ever hit in dev mode, but must be answered
            // before anything else or every mutating request from the Vite
            // dev server silently fails client-side.
            if (isOptions)
                return writeCorsPreflightResponse(wsi);

            std::snprintf(pss->path, sizeof(pss->path), "%s", uri);
            std::snprintf(pss->method, sizeof(pss->method), "%s", method);

            // Project/WAV upload: stream bytes straight to a temp file rather
            // than through the small-JSON body accumulator below (archives
            // and audio files can be tens/hundreds of MB; the 4096-byte cap
            // below is for {"index":N}-sized bodies).
            const bool isProjectUpload = isPost && std::strcmp(uri, "/api/v1/project/upload") == 0;
            const bool isWavUpload =
                isPost && std::strcmp(uri, "/api/v1/builder/track/import-wav/upload") == 0;
            if (isProjectUpload || isWavUpload) {
                pss->isApi = true;
                pss->isUpload = true;
                pss->isWavUpload = isWavUpload;
                const std::string tempPath = makeUploadTempPath(isWavUpload ? ".wav" : ".rsnraset");
                std::snprintf(pss->uploadPath, sizeof(pss->uploadPath), "%s", tempPath.c_str());
                pss->uploadFile = std::fopen(pss->uploadPath, "wb");
                if (pss->uploadFile == nullptr) {
                    return writeHttpResponse(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, "application/json",
                                             "{\"error\":\"temp file\"}", 22);
                }
                return 0;
            }

            if (std::strncmp(uri, "/api/", 5) == 0) {
                pss->isApi = true;

                if (!isPost) {
                    if (std::strcmp(uri, "/api/v1/state") == 0) {
                        const std::string json = server->buildStateJson();
                        return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json",
                                                 json.c_str(), json.size());
                    }
                    if (std::strcmp(uri, "/api/v1/project/export-status") == 0)
                        return server->serveExportStatus(wsi);
                    if (std::strcmp(uri, "/api/v1/project/download") == 0)
                        return server->serveExportDownload(wsi);
                    if (std::strcmp(uri, "/api/v1/player/peaks") == 0)
                        return server->servePeaks(wsi);
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
            if (pss->isUpload) {
                if (pss->uploadFile != nullptr && in != nullptr && len > 0)
                    std::fwrite(in, 1, len, pss->uploadFile);
                return 0;
            }
            const char* chunk = static_cast<const char*>(in);
            if (chunk != nullptr && len > 0) {
                // Cap body size to keep bad clients from filling RAM.
                if (pss->body.size() + len > 4096)
                    return -1;
                pss->body.insert(pss->body.end(), chunk, chunk + len);
            }
            return 0;
    }

    if (why == LWS_CALLBACK_CLOSED_HTTP) {
            // Client disconnected mid-upload: don't leak the handle or leave a
            // half-written archive sitting in the temp dir forever.
            if (pss != nullptr && pss->uploadFile != nullptr) {
                std::fclose(pss->uploadFile);
                std::remove(pss->uploadPath);
                pss->uploadFile = nullptr;
            }
            return lws_callback_http_dummy(wsi, why, user, in, len);
    }

    if (why == LWS_CALLBACK_HTTP_BODY_COMPLETION) {
            if (pss == nullptr || server == nullptr || !pss->isApi)
                return lws_callback_http_dummy(wsi, why, user, in, len);
            if (pss->isUpload) {
                if (pss->uploadFile != nullptr) {
                    std::fclose(pss->uploadFile);
                    pss->uploadFile = nullptr;
                }
                if (pss->isWavUpload) {
                    int songIndex = -1, trackIndex = -1;
                    std::string fileName;
                    server->takeTrackImportTarget(songIndex, trackIndex, fileName);

                    // Rename to the original filename (sanitized) so the
                    // archive entry importWavForTrackAsync creates ends up
                    // "Audio/kick.wav" instead of a generic temp name --
                    // best-effort, falls back to the temp path as-is.
                    std::string finalPath = pss->uploadPath;
                    if (!fileName.empty()) {
                        const std::filesystem::path dir =
                            std::filesystem::path(pss->uploadPath).parent_path();
                        const std::filesystem::path renamed =
                            dir / (std::to_string(reinterpret_cast<uintptr_t>(wsi)) + "-"
                                   + sanitizeUploadFileName(fileName));
                        std::error_code ec;
                        std::filesystem::rename(pss->uploadPath, renamed, ec);
                        if (!ec)
                            finalPath = renamed.string();
                    }
                    server->enqueueCommand(WebCommand{WebCommandKind::BuilderTrackImportWavUpload, songIndex,
                                                      static_cast<double>(trackIndex), finalPath, ""});
                } else {
                    server->enqueueCommand(
                        WebCommand{WebCommandKind::LoadProjectFromPath, 0, 0.0, std::string(pss->uploadPath)});
                }
                return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", "{\"ok\":true}", 11);
            }
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
      << "\"songCount\":" << snap.songCount << ","
      << "\"statusMessage\":\"" << jsonEscape(snap.statusMessage) << "\","
      << "\"busy\":" << (snap.busy ? "true" : "false") << ",";

    o << "\"songs\":[";
    for (size_t i = 0; i < snap.songs.size(); ++i) {
        if (i) o << ",";
        const auto& song = snap.songs[i];
        o << "{\"name\":\"" << jsonEscape(song.name) << "\","
          << "\"bpm\":" << finiteOrZero(song.bpm) << ","
          << "\"mode\":\"" << (song.autoplay ? "auto" : "wait") << "\","
          << "\"tsNum\":" << song.tsNum << ","
          << "\"tsDen\":" << song.tsDen << ","
          << "\"click\":" << (song.click ? "true" : "false") << ","
          << "\"clickBusId\":\"" << jsonEscape(song.clickBusId) << "\",";

        o << "\"tracks\":[";
        for (size_t j = 0; j < song.tracks.size(); ++j) {
            if (j) o << ",";
            const auto& t = song.tracks[j];
            o << "{\"id\":\"" << jsonEscape(t.id) << "\","
              << "\"name\":\"" << jsonEscape(t.name) << "\","
              << "\"busId\":\"" << jsonEscape(t.busId) << "\","
              << "\"file\":\"" << jsonEscape(t.file) << "\","
              << "\"gainDb\":" << finiteOrZero(t.gainDb) << ","
              << "\"pan\":" << finiteOrZero(t.pan) << ","
              << "\"mute\":" << (t.mute ? "true" : "false") << ","
              << "\"solo\":" << (t.solo ? "true" : "false") << ","
              << "\"sendsCount\":" << t.sendsCount << "}";
        }
        o << "],";

        o << "\"events\":[";
        for (size_t j = 0; j < song.events.size(); ++j) {
            if (j) o << ",";
            const auto& e = song.events[j];
            o << "{\"id\":\"" << jsonEscape(e.id) << "\","
              << "\"type\":\"" << jsonEscape(e.type) << "\","
              << "\"timeSeconds\":" << finiteOrZero(e.timeSeconds) << ","
              << "\"triggerOnLoad\":" << (e.triggerOnLoad ? "true" : "false") << ","
              << "\"latencyMs\":" << finiteOrZero(e.latencyMs) << ","
              << "\"midiChannel\":" << e.midiChannel << ","
              << "\"midiProgram\":" << e.midiProgram << ","
              << "\"midiCC\":" << e.midiCC << ","
              << "\"midiCCValue\":" << e.midiCCValue << ","
              << "\"midiNote\":" << e.midiNote << ","
              << "\"midiVelocity\":" << e.midiVelocity << ","
              << "\"httpUrl\":\"" << jsonEscape(e.httpUrl) << "\"}";
        }
        o << "]}";
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
          << "\"channels\":" << b.channels << ","
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
      << "},";

    const auto& s = snap.settings;
    o << "\"settings\":{"
      << "\"currentOutputDevice\":\"" << jsonEscape(s.currentOutputDevice) << "\","
      << "\"outputDevices\":[";
    for (size_t i = 0; i < s.outputDevices.size(); ++i) {
        if (i) o << ",";
        o << "\"" << jsonEscape(s.outputDevices[i]) << "\"";
    }
    o << "],"
      << "\"sampleRate\":" << finiteOrZero(s.sampleRate) << ","
      << "\"availableSampleRates\":[";
    for (size_t i = 0; i < s.availableSampleRates.size(); ++i) {
        if (i) o << ",";
        o << finiteOrZero(s.availableSampleRates[i]);
    }
    o << "],"
      << "\"bufferSize\":" << s.bufferSize << ","
      << "\"availableBufferSizes\":[";
    for (size_t i = 0; i < s.availableBufferSizes.size(); ++i) {
        if (i) o << ",";
        o << s.availableBufferSizes[i];
    }
    o << "],"
      << "\"outputChannelNames\":[";
    for (size_t i = 0; i < s.outputChannelNames.size(); ++i) {
        if (i) o << ",";
        o << "\"" << jsonEscape(s.outputChannelNames[i]) << "\"";
    }
    o << "],"
      << "\"activeOutputChannels\":[";
    for (size_t i = 0; i < s.activeOutputChannels.size(); ++i) {
        if (i) o << ",";
        o << (s.activeOutputChannels[i] ? "true" : "false");
    }
    o << "],"
      << "\"midiOutputs\":[";
    for (size_t i = 0; i < s.midiOutputs.size(); ++i) {
        if (i) o << ",";
        o << "\"" << jsonEscape(s.midiOutputs[i]) << "\"";
    }
    o << "],"
      << "\"midiInputs\":[";
    for (size_t i = 0; i < s.midiInputs.size(); ++i) {
        if (i) o << ",";
        o << "\"" << jsonEscape(s.midiInputs[i]) << "\"";
    }
    o << "],"
      << "\"keybindings\":[";
    for (size_t i = 0; i < s.keybindings.size(); ++i) {
        if (i) o << ",";
        o << "{\"action\":\"" << jsonEscape(s.keybindings[i].action) << "\","
          << "\"key\":\"" << jsonEscape(s.keybindings[i].key) << "\"}";
    }
    o << "]"
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
        cmd = {WebCommandKind::SelectSong, idx, 0.0};
    } else if (isMixerCommandPath(path)) {
        int idx = 0;
        double value = 0.0;
        if (!parseIndexAndValue(body, bodyLen, idx, value)) {
            writeHttpResponse(wsi, HTTP_STATUS_BAD_REQUEST, "application/json",
                              "{\"error\":\"missing index/value\"}", 34);
            return true;
        }
        cmd = {mixerCommandKindForPath(path), idx, value};
    } else if (std::strcmp(path, "/api/v1/project/new") == 0) {
        cmd = {WebCommandKind::NewProject, 0};
    } else if (std::strcmp(path, "/api/v1/project/load-dialog") == 0) {
        cmd = {WebCommandKind::OpenLoadDialog, 0};
    } else if (std::strcmp(path, "/api/v1/project/save") == 0) {
        cmd = {WebCommandKind::SaveProject, 0};
    } else if (std::strcmp(path, "/api/v1/project/save-as") == 0) {
        cmd = {WebCommandKind::SaveProjectAs, 0};
    } else if (std::strcmp(path, "/api/v1/project/export") == 0) {
        beginExport();
        cmd = {WebCommandKind::ExportProjectForDownload, 0};
    } else if (WebCommandKind builderKind; builderCommandKindForPath(path, builderKind)) {
        if (builderKind == WebCommandKind::BuilderTrackImportWavBegin) {
            const std::string s(body, bodyLen);
            std::string songRaw, indexRaw, fileNameRaw;
            int songIndex = -1, trackIndex = -1;
            if (findJsonField(s, "\"songIndex\"", songRaw))
                try { songIndex = std::stoi(songRaw); } catch (...) {}
            if (findJsonField(s, "\"index\"", indexRaw))
                try { trackIndex = std::stoi(indexRaw); } catch (...) {}
            std::string fileName;
            if (findJsonField(s, "\"fileName\"", fileNameRaw) && fileNameRaw.size() >= 2
                && fileNameRaw.front() == '"' && fileNameRaw.back() == '"')
                fileName = fileNameRaw.substr(1, fileNameRaw.size() - 2);
            beginTrackImport(songIndex, trackIndex, fileName);
        }
        cmd = {builderKind, 0, 0.0, "", std::string(body, bodyLen)};
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
    std::string_view p(path != nullptr && path[0] != '\0' ? path : "/");
    if (p == "/")
        p = embedded_assets::kIndexHtmlPath;

    for (const auto& asset : embedded_assets::kAssets) {
        if (p == asset.path)
            return writeHttpResponse(wsi, HTTP_STATUS_OK, asset.mimeType, asset.data, asset.length);
    }

    // Unknown path (e.g. a future client-side route, or a stray request for
    // something that was never built) -- fall back to index.html rather than
    // a bare 404 so a refresh on a deep link still resolves to the SPA.
    for (const auto& asset : embedded_assets::kAssets) {
        if (std::string_view(asset.path) == embedded_assets::kIndexHtmlPath)
            return writeHttpResponse(wsi, HTTP_STATUS_OK, asset.mimeType, asset.data, asset.length);
    }
    return writeHttpResponse(wsi, HTTP_STATUS_NOT_FOUND, "text/plain", "not found", 9);
}

void WebServer::beginExport() {
    std::lock_guard<std::mutex> lock(exportMutex);
    exportReady = false;
    exportFilePath.clear();
    exportFileName.clear();
}

void WebServer::completeExport(std::string filePath, std::string fileName) {
    std::lock_guard<std::mutex> lock(exportMutex);
    exportFilePath = std::move(filePath);
    exportFileName = std::move(fileName);
    exportReady = true;
}

void WebServer::failExport() {
    std::lock_guard<std::mutex> lock(exportMutex);
    exportReady = false;
    exportFilePath.clear();
    exportFileName.clear();
}

void WebServer::beginTrackImport(int songIndex, int trackIndex, std::string fileName) {
    std::lock_guard<std::mutex> lock(importMutex);
    pendingImportSongIndex = songIndex;
    pendingImportTrackIndex = trackIndex;
    pendingImportFileName = std::move(fileName);
}

void WebServer::takeTrackImportTarget(int& songIndex, int& trackIndex, std::string& fileName) {
    std::lock_guard<std::mutex> lock(importMutex);
    songIndex = pendingImportSongIndex;
    trackIndex = pendingImportTrackIndex;
    fileName = pendingImportFileName;
    pendingImportSongIndex = -1;
    pendingImportTrackIndex = -1;
    pendingImportFileName.clear();
}

void WebServer::publishPeaks(std::string json) {
    std::lock_guard<std::mutex> lock(peaksMutex);
    peaksJson = std::move(json);
}

int WebServer::servePeaks(struct lws* wsi) {
    std::string json;
    {
        std::lock_guard<std::mutex> lock(peaksMutex);
        json = peaksJson;
    }
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.c_str(), json.size());
}

int WebServer::serveExportStatus(struct lws* wsi) {
    bool ready = false;
    std::string name;
    {
        std::lock_guard<std::mutex> lock(exportMutex);
        ready = exportReady;
        name = exportFileName;
    }
    std::ostringstream o;
    o << "{\"ready\":" << (ready ? "true" : "false") << ",\"fileName\":\"" << jsonEscape(name) << "\"}";
    const std::string json = o.str();
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.c_str(), json.size());
}

int WebServer::serveExportDownload(struct lws* wsi) {
    std::string path, name;
    bool ready = false;
    {
        std::lock_guard<std::mutex> lock(exportMutex);
        ready = exportReady;
        path = exportFilePath;
        name = exportFileName;
    }
    if (!ready) {
        return writeHttpResponse(wsi, HTTP_STATUS_NOT_FOUND, "application/json",
                                 "{\"error\":\"not ready\"}", 21);
    }

    std::ifstream in(path, std::ios::binary);
    if (!in) {
        failExport();
        return writeHttpResponse(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, "application/json",
                                 "{\"error\":\"missing file\"}", 24);
    }
    std::vector<char> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    in.close();

    // One-shot: the polled export-status/download handshake is meant for a
    // single click-to-download, not a reusable link.
    std::remove(path.c_str());
    failExport();

    const std::string disposition = "attachment; filename=\"" + name + "\"";
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/zip", bytes.data(), bytes.size(),
                             disposition.c_str());
}

} // namespace resoset
