/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "WebServer.h"

#include "network/UDPDiscovery.h"
#include "project/ProjectJson.h"
#include "events/MidiNoteActivity.h"
#include "server/WireTypes.h"
#include "server/BuilderJson.h"
#include "server/CommandBodyLimits.h"
#include "server/WebServerHttp.h"
#include "server/WebServerTelemetryBinary.h"
#include <juce_core/juce_core.h>

#include <libwebsockets.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <optional>
#include <new>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace resostage {

using namespace wire;
using webserver_http::writeHTTPResponse;
using webserver_http::writeJsonEnabled;
using webserver_http::writeJsonError;
using webserver_http::writeJsonOk;

namespace {

// Max WS text frame we will send. View-filtered payloads are typically a few
// KB; this is a safety net for huge editor projects.
constexpr size_t kWsTxMax = 512 * 1024;

// Target telemetry period — every client starts here and recovers back
// toward it; see kTelemetryMinPeriodUs / LWS_CALLBACK_TIMER for the adaptive
// backoff that can slow an individual client down under backpressure.
constexpr int kTelemetryPeriodUs = WebServer::kTelemetryPeriodUs;
[[maybe_unused]] constexpr int kTelemetryMinPeriodUs = WebServer::kTelemetryMinPeriodUs;

// Which SPA tab the client is showing -- drives buildStateJson() so we only
// push fields that page needs (transport/time always).
enum class ClientView : uint8_t { Player, Mixer, Editor, Settings, Light };

// Consecutive backpressure ticks (previous period's write never completed)
// before backing this client off to half its rate. Kept short (~100ms at the
// full 30Hz rate) so a real stall is caught fast.
[[maybe_unused]] constexpr int kBackoffAfterConsecutiveDrops = 3;
// Consecutive clean ticks before stepping the rate back up toward
// kTelemetryHz. Kept long (~2s at 30Hz) relative to the backoff trigger so
// a client hovering right at its capacity doesn't oscillate ("float")
// between two rates every couple hundred ms.
[[maybe_unused]] constexpr int kRecoverAfterConsecutiveOk = 60;

struct WsSession {
    WebServer* server = nullptr;
    struct lws* wsi = nullptr;
    bool writePending = false;
    bool sendBinaryNext = false;
    ClientView view = ClientView::Player;
    // Adaptive per-client send period -- see LWS_CALLBACK_TIMER below.
    int periodUs = kTelemetryPeriodUs;
    // Last period reported to the server's shared "effective Hz" readout, so
    // it is only written when it actually changes -- see the TIMER handler.
    int reportedPeriodUs = 0;
    // Slowest period the CLIENT has asked for, 0 when it hasn't asked.
    //
    // Backpressure backoff (periodUs) reacts to a socket that will not drain;
    // this is the client saying up front that it cannot USE frames any faster,
    // because it has capped its own frame rate (see lib/performance.ts). Both
    // apply, and the slower of the two wins: there is no point pushing 60
    // frames a second at a UI that repaints 15 times, and every one of those
    // frames costs a serialize here and a parse plus a React commit there.
    int requestedPeriodUs = 0;
    int badStreak = 0;
    int goodStreak = 0;
    // Frame generation this client has already been sent. The cache only bumps
    // its generation when the serialized bytes actually change, so this lets an
    // idle app send nothing rather than re-pushing an identical ~20 KB frame at
    // the telemetry rate. Plain integer on purpose: lws allocates WsSession
    // with malloc and never runs a constructor, so no member here may have one.
    uint64_t lastSentGeneration = 0;
};

WebServer::ViewSlot slotForView(ClientView v) {
    switch (v) {
        case ClientView::Mixer: return WebServer::ViewSlot::Mixer;
        case ClientView::Editor: return WebServer::ViewSlot::Editor;
        case ClientView::Settings: return WebServer::ViewSlot::Settings;
        case ClientView::Light: return WebServer::ViewSlot::Light;
        case ClientView::Player: break;
    }
    return WebServer::ViewSlot::Player;
}

ClientView parseClientView(const std::string& s) {
    if (s == "mixer") return ClientView::Mixer;
    if (s == "editor" || s == "builder") return ClientView::Editor;
    if (s == "settings") return ClientView::Settings;
    if (s == "light") return ClientView::Light;
    return ClientView::Player;
}


// Per-HTTP-transaction bounded body accumulator for REST POSTs. Upload
// Project/media uploads bypass `body` entirely -- large archives and media
// must use bounded RAM, so their bytes are streamed
// straight to `uploadFile` instead of buffered in RAM.
struct HttpSession {
    char path[256]{};
    char method[16]{};
    std::vector<char> body;
    bool bodyRejected = false;
    bool isApi = false;
    bool isStatic = false;
    bool isUpload = false;
    bool isWavUpload = false; // distinguishes .../builder/track/import-wav/upload from project upload
    char uploadPath[512]{};
    FILE* uploadFile = nullptr;
    uint64_t uploadBytes = 0;
    bool uploadFailed = false;
    int importSongIndex = -1;
    int importTrackIndex = -1;
    double importStartSeconds = 0.0;
    char importFileName[257]{};
    char importRequestId[65]{};
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
    std::error_code ec;
    std::filesystem::path dir = std::filesystem::temp_directory_path(ec);
    if (ec) return {};
    std::filesystem::path file =
        dir / ("resostage-upload-" + std::to_string(ts) + "-" + std::to_string(n) + extension);
    return file.string();
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

// CORS preflight response for the dev-server case (Vite on :2900 issuing
// cross-origin POSTs to the native backend on :2899). `Content-Type:
// application/json` isn't a CORS "simple" header, so every POST from that
// origin triggers an OPTIONS preflight first -- without this, the browser
// blocks the real request even though the server would have accepted it
// (this doesn't come up in production, where the SPA is served from the
// same origin as the API and no preflight is ever issued).
int writeCorsPreflightResponse(struct lws* wsi) {
    // Same size as writeHTTPResponse's buffer -- the security-best-practices
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
    // lws allocates raw protocol storage, not a C++ object. Bind/drop delimit
    // each HTTP transaction (including keep-alive), so construct/destruct the
    // vector explicitly rather than leaking or treating zeroed bytes as one.
    if (why == LWS_CALLBACK_HTTP_BIND_PROTOCOL) {
        if (pss != nullptr) new (pss) HttpSession{};
        return 0;
    }
    if (why == LWS_CALLBACK_HTTP_DROP_PROTOCOL) {
        if (pss != nullptr) {
            if (pss->uploadFile != nullptr) {
                std::fclose(pss->uploadFile);
                std::remove(pss->uploadPath);
                if (server != nullptr && pss->isWavUpload)
                    server->finishTrackImport(pss->importRequestId, false, "Media upload interrupted");
            }
            pss->~HttpSession();
        }
        return 0;
    }
    const auto failUpload = [&](int status, const std::string& error) {
        if (pss != nullptr) {
            if (pss->uploadFile != nullptr) std::fclose(pss->uploadFile);
            pss->uploadFile = nullptr;
            std::remove(pss->uploadPath);
            pss->uploadFailed = true;
            if (server != nullptr && pss->isWavUpload)
                server->finishTrackImport(pss->importRequestId, false, error);
        }
        return writeJsonError(wsi, status, error);
    };

    // if/else (not switch-enum): lws has 100+ callback reasons; only a few apply.
    if (why == LWS_CALLBACK_HTTP) {
            if (pss == nullptr || server == nullptr)
                return -1;

            pss->body.clear();
            pss->bodyRejected = false;
            pss->isApi = false;
            pss->isStatic = false;
            pss->isUpload = false;
            pss->isWavUpload = false;
            pss->uploadBytes = 0;
            pss->uploadFailed = false;
            pss->importSongIndex = pss->importTrackIndex = -1;
            pss->importStartSeconds = 0.0;
            pss->importFileName[0] = '\0';
            pss->importRequestId[0] = '\0';
            if (pss->uploadFile != nullptr) {
                // Defensive: a previous transaction on a kept-alive connection
                // aborted mid-upload without a BODY_COMPLETION/CLOSE. Don't leak
                // the handle or the partial temp file into this new request.
                std::fclose(pss->uploadFile);
                std::remove(pss->uploadPath);
                pss->uploadFile = nullptr;
            }
            pss->uploadPath[0] = '\0';

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
                if (isWavUpload) {
                    char contentLength[32]{};
                    lws_hdr_copy(wsi, contentLength, sizeof(contentLength), WSI_TOKEN_HTTP_CONTENT_LENGTH);
                    if (contentLength[0] != '\0') {
                        uint64_t declaredSize = 0;
                        const auto end = contentLength + std::strlen(contentLength);
                        const auto parsed = std::from_chars(contentLength, end, declaredSize);
                        if (parsed.ec != std::errc{} || parsed.ptr != end || declaredSize > 20ULL * 1024 * 1024 * 1024) {
                            pss->uploadFailed = true;
                            return writeJsonError(wsi, 413, "Media file exceeds the 20 GiB limit or has an invalid size");
                        }
                    }
                }
                if (isWavUpload) {
                    char argsBuf[512]{};
                    lws_hdr_copy(wsi, argsBuf, sizeof(argsBuf), WSI_TOKEN_HTTP_URI_ARGS);
                    std::string fileName;
                    const auto requestId = webserver_http::queryParam(argsBuf, "requestId");
                    if (!server->takeTrackImportTarget(pss->importSongIndex, pss->importTrackIndex,
                            fileName, pss->importStartSeconds, requestId)) {
                        pss->uploadFailed = true;
                        return writeJsonError(wsi, 409, "Media upload ticket is missing or expired");
                    }
                    std::snprintf(pss->importRequestId, sizeof(pss->importRequestId), "%s", requestId.c_str());
                    std::snprintf(pss->importFileName, sizeof(pss->importFileName), "%s", fileName.c_str());
                }
                const std::string tempPath = makeUploadTempPath(isWavUpload ? ".wav" : ".rsnraset");
                if (tempPath.empty()) {
                    return failUpload(HTTP_STATUS_INTERNAL_SERVER_ERROR, "Temporary directory is unavailable");
                }
                std::snprintf(pss->uploadPath, sizeof(pss->uploadPath), "%s", tempPath.c_str());
                pss->uploadFile = std::fopen(pss->uploadPath, "wb");
                if (pss->uploadFile == nullptr) {
                    return failUpload(HTTP_STATUS_INTERNAL_SERVER_ERROR, "Could not create a temporary upload file");
                }
                return 0;
            }

            if (std::strncmp(uri, "/api/", 5) == 0) {
                pss->isApi = true;

                if (!isPost) {
                    if (std::strcmp(uri, "/api/v1/builder/track/import-status") == 0) {
                        char argsBuf[512]{};
                        lws_hdr_copy(wsi, argsBuf, sizeof(argsBuf), WSI_TOKEN_HTTP_URI_ARGS);
                        return server->serveTrackImportStatus(wsi, webserver_http::queryParam(argsBuf, "requestId"));
                    }
                    if (std::strcmp(uri, "/api/v1/state") == 0) {
                        // Prefer prebuilt full frame; fall back to live build.
                        auto frame = server->cachedFrameForView("all");
                        const std::string json = frame && !frame->empty()
                            ? *frame
                            : server->buildStateJson("all");
                        return writeHTTPResponse(wsi, HTTP_STATUS_OK, "application/json",
                                                 json.c_str(), json.size());
                    }
                    if (std::strcmp(uri, "/api/v1/project/export-status") == 0)
                        return server->serveExportStatus(wsi);
                    if (std::strcmp(uri, "/api/v1/project/download") == 0)
                        return server->serveExportDownload(wsi);
                    if (std::strcmp(uri, "/api/v1/render/status") == 0)
                        return server->serveAudioRenderStatus(wsi);
                    if (std::strcmp(uri, "/api/v1/plugins/list") == 0)
                        return server->servePluginCatalog(wsi);
                    if (std::strcmp(uri, "/api/v1/plugins/slot/parameters") == 0) {
                        char argsBuf[512] = "";
                        lws_hdr_copy(wsi, argsBuf, sizeof(argsBuf), WSI_TOKEN_HTTP_URI_ARGS);
                        return server->servePluginParameters(wsi, argsBuf);
                    }
                    if (std::strcmp(uri, "/api/v1/player/peaks") == 0)
                        return server->servePeaks(wsi);
                    if (std::strcmp(uri, "/api/v1/player/peaks-all") == 0)
                        return server->serveAllPeaks(wsi);
                    if (std::strcmp(uri, "/api/v1/player/waveform-raw") == 0) {
                        char argsBuf[512] = "";
                        lws_hdr_copy(wsi, argsBuf, sizeof(argsBuf), WSI_TOKEN_HTTP_URI_ARGS);
                        return server->serveWaveformRaw(wsi, argsBuf);
                    }
                    if (std::strncmp(uri, "/api/v1/recording/", 18) == 0 && std::strstr(uri, "/peaks") != nullptr) {
                        char argsBuf[512] = "";
                        lws_hdr_copy(wsi, argsBuf, sizeof(argsBuf), WSI_TOKEN_HTTP_URI_ARGS);
                        return server->serveLiveRecordingPeaks(wsi, uri, argsBuf);
                    }
                    if (std::strcmp(uri, "/api/v1/ui/menu") == 0)
                        return server->serveUiMenu(wsi);
                    if (std::strcmp(uri, "/api/v1/remote/discovered-devices") == 0)
                        return server->serveDiscoveredDevices(wsi);
                    if (std::strcmp(uri, "/api/v1/remote/discovery") == 0)
                        return server->serveDiscoveryStatus(wsi);
                    if (std::strcmp(uri, "/api/v1/audio/mixgraph") == 0) {
                        const std::string json = server->buildStateJson("mixgraph");
                        return writeHTTPResponse(wsi, HTTP_STATUS_OK, "application/json",
                                                 json.c_str(), json.size());
                    }
                    return writeJsonError(wsi, HTTP_STATUS_NOT_FOUND, "not found");
                }

                // POST with no body (Content-Length 0 / absent): handle now.
                // POSTs with a body wait for HTTP_BODY_COMPLETION.
                const int contentLen = lws_hdr_total_length(wsi, WSI_TOKEN_HTTP_CONTENT_LENGTH);
                char clBuf[32] = "0";
                if (contentLen > 0)
                    lws_hdr_copy(wsi, clBuf, sizeof(clBuf), WSI_TOKEN_HTTP_CONTENT_LENGTH);
                const long cl = std::strtol(clBuf, nullptr, 10);
                if (cl > 0 && static_cast<uint64_t>(cl) > command_body::limitForPath(pss->path)) {
                    pss->bodyRejected = true;
                    return writeJsonError(wsi, 413, "Editor command exceeds its bounded payload limit");
                }
                if (cl <= 0) {
                    if (server->handleHttpApi(wsi, pss->path, pss->method, "", 0))
                        return 0;
                    return writeJsonError(wsi, HTTP_STATUS_NOT_FOUND, "not found");
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
                if (pss->uploadFailed) return -1;
                if (pss->uploadFile != nullptr && in != nullptr && len > 0) {
                    constexpr uint64_t kMaximumMediaUploadBytes = 20ULL * 1024 * 1024 * 1024;
                    const bool tooLarge = pss->isWavUpload
                        && len > kMaximumMediaUploadBytes - pss->uploadBytes;
                    if (tooLarge || std::fwrite(in, 1, len, pss->uploadFile) != len) {
                        std::fclose(pss->uploadFile);
                        pss->uploadFile = nullptr;
                        std::remove(pss->uploadPath);
                        pss->uploadFailed = true;
                        return failUpload(tooLarge ? 413 : HTTP_STATUS_INTERNAL_SERVER_ERROR,
                            tooLarge ? "Media file exceeds the 20 GiB limit" : "Could not write uploaded media to disk");
                    }
                    pss->uploadBytes += len;
                }
                return 0;
            }
            const char* chunk = static_cast<const char*>(in);
            if (pss->bodyRejected) return -1;
            if (chunk != nullptr && len > 0) {
                if (!command_body::canAppend(pss->body.size(), len, command_body::limitForPath(pss->path))) {
                    pss->bodyRejected = true;
                    return writeJsonError(wsi, 413, "Editor command exceeds its bounded payload limit");
                }
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
                if (server != nullptr && pss->isWavUpload)
                    server->finishTrackImport(pss->importRequestId, false, "Media upload interrupted");
            }
            return lws_callback_http_dummy(wsi, why, user, in, len);
    }

    if (why == LWS_CALLBACK_HTTP_BODY_COMPLETION) {
            if (pss == nullptr || server == nullptr || !pss->isApi)
                return lws_callback_http_dummy(wsi, why, user, in, len);
            if (pss->bodyRejected) return -1;
            if (pss->isUpload) {
                if (pss->uploadFailed) return -1;
                if (pss->uploadFile != nullptr) {
                    const bool flushed = std::fclose(pss->uploadFile) == 0;
                    pss->uploadFile = nullptr;
                    if (!flushed) {
                        std::remove(pss->uploadPath);
                        pss->uploadFailed = true;
                        return failUpload(HTTP_STATUS_INTERNAL_SERVER_ERROR,
                            "Could not finalize uploaded media on disk");
                    }
                }
                if (pss->isWavUpload) {
                    const std::string fileName = pss->importFileName;

                    // Rename to the original filename (sanitized) so the
                    // archive entry importWavForTrackAsync creates ends up
                    // "Audio/kick.wav" instead of a generic temp name --
                    // The original extension is required for video retention.
                    // Use this upload's unique basename to avoid a later upload
                    // replacing a file still being consumed by the import worker.
                    std::string finalPath = pss->uploadPath;
                    if (!fileName.empty()) {
                        const std::filesystem::path dir =
                            std::filesystem::path(pss->uploadPath).parent_path();
                        const std::filesystem::path renamed =
                            dir / (std::filesystem::path(pss->uploadPath).stem().string() + "-"
                                   + sanitizeUploadFileName(fileName));
                        std::error_code ec;
                        std::filesystem::rename(pss->uploadPath, renamed, ec);
                        if (ec) {
                            std::remove(pss->uploadPath);
                            return failUpload(HTTP_STATUS_INTERNAL_SERVER_ERROR,
                                "Could not preserve the uploaded media filename: " + ec.message());
                        }
                        finalPath = renamed.string();
                    }
                    wire::WTrackImportBeginPayload options;
                    options.startSeconds = pss->importStartSeconds;
                    options.requestId = pss->importRequestId;
                    std::string optionsJson;
                    (void)glz::write_json(options, optionsJson);
                    if (!server->enqueueCommand(WebCommand{WebCommandKind::BuilderTrackImportWAVUpload, pss->importSongIndex,
                                                      static_cast<double>(pss->importTrackIndex), finalPath,
                                                      std::move(optionsJson)})) {
                        std::remove(finalPath.c_str());
                        return failUpload(503, "Core command queue is full; retry the media import");
                    }
                } else {
                    if (!server->enqueueCommand(
                        WebCommand{WebCommandKind::LoadProjectFromPath, 0, 0.0, std::string(pss->uploadPath)}))
                        return failUpload(503, "Core command queue is full; retry the project upload");
                }
                return writeJsonOk(wsi);
            }
            const char* body = pss->body.empty() ? "" : pss->body.data();
            const size_t bodyLen = pss->body.size();
            if (server->handleHttpApi(wsi, pss->path, pss->method, body, bodyLen))
                return 0;
            return writeJsonError(wsi, HTTP_STATUS_NOT_FOUND, "not found");
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
            pss->writePending = false;
            pss->view = ClientView::Player;
            server->noteViewOpened(WebServer::ViewSlot::Player);
            pss->periodUs = kTelemetryPeriodUs;
            pss->requestedPeriodUs = 0;
            pss->reportedPeriodUs = 0;
            pss->badStreak = 0;
            pss->goodStreak = 0;
            server->onClientOpened();
            char clientIp[64] = "";
            lws_get_peer_simple(wsi, clientIp, sizeof(clientIp));
            if (clientIp[0] != '\0')
                server->registerUDPSubscriber(clientIp);
            server->reportClientPeriodUs(pss->periodUs);
            // Every client starts at the full target cadence (see
            // WebServer::kTelemetryHz) and adapts from there -- see
            // LWS_CALLBACK_TIMER below.
            lws_set_timer_usecs(wsi, kTelemetryPeriodUs);
            // First frame on the next timer tick so all clients stay phase-
            // aligned to their own clock from connect.
            return 0;
    }

    if (why == LWS_CALLBACK_CLOSED) {
            if (server != nullptr) {
                if (pss != nullptr)
                    server->noteViewClosed(slotForView(pss->view));
                server->onClientClosed();
            }
            return 0;
    }

    if (why == LWS_CALLBACK_TIMER) {
            if (pss != nullptr) {
                // The frontend manages frame rate via requestedPeriodUs (set by
                // telemetryHz messages). No server-side backoff/reduction.
                const int effectivePeriodUs = pss->requestedPeriodUs;
                if (pss->reportedPeriodUs != effectivePeriodUs) {
                    pss->reportedPeriodUs = effectivePeriodUs;
                    server->reportClientPeriodUs(effectivePeriodUs);
                }
                pss->writePending = true;
                pss->sendBinaryNext = true;
                lws_callback_on_writable(wsi);
                lws_set_timer_usecs(wsi, effectivePeriodUs);
            }
            return 0;
    }

    if (why == LWS_CALLBACK_SERVER_WRITEABLE) {
            if (pss == nullptr || server == nullptr || !pss->writePending)
                return 0;

            // Nothing has changed since this client's last frame -- skip the
            // write entirely rather than re-push identical bytes. writePending
            // is cleared either way, so the adaptive backoff still sees a clean
            // tick and does not mistake a quiet app for a stalled client.
            // Safe on the client: the SPA reconnects on `onclose`, never on a
            // frame-staleness timer, and a frozen frame means a frozen state.
            const uint64_t generation = server->frameGeneration();
            if (generation != 0 && generation == pss->lastSentGeneration) {
                pss->writePending = false;
                pss->sendBinaryNext = false;
                return 0;
            }

            if (pss->sendBinaryNext) {
                pss->sendBinaryNext = false;
                const auto binFrame = server->cachedBinaryFrame();
                if (binFrame && !binFrame->empty() && binFrame->size() + LWS_PRE <= kWsTxMax) {
                    std::vector<uint8_t> buf(LWS_PRE + binFrame->size());
                    std::memcpy(buf.data() + LWS_PRE, binFrame->data(), binFrame->size());
                    const int n = lws_write(wsi, buf.data() + LWS_PRE, binFrame->size(), LWS_WRITE_BINARY);
                    if (n < 0)
                        return -1;
                }
                // Chain to send structural JSON frame next
                lws_callback_on_writable(wsi);
                return 0;
            }

            pss->writePending = false;

            const char* viewName = "player";
            switch (pss->view) {
                case ClientView::Mixer: viewName = "mixer"; break;
                case ClientView::Editor: viewName = "editor"; break;
                case ClientView::Settings: viewName = "settings"; break;
                case ClientView::Light: viewName = "light"; break;
                case ClientView::Player: default: viewName = "player"; break;
            }
            // Hot path: only a shared_ptr copy of a pre-serialized frame.
            // No mutex-held ostringstream, no per-client rebuild.
            const auto frame = server->cachedFrameForView(viewName);
            if (!frame || frame->empty() || frame->size() + LWS_PRE > kWsTxMax)
                return 0;

            std::vector<uint8_t> buf(LWS_PRE + frame->size());
            std::memcpy(buf.data() + LWS_PRE, frame->data(), frame->size());
            const int n = lws_write(wsi, buf.data() + LWS_PRE, frame->size(), LWS_WRITE_TEXT);
            if (n < 0)
                return -1;
            // Recorded only after the JSON half actually went out, so a client
            // that dropped mid-pair re-sends both next tick.
            pss->lastSentGeneration = generation;
            return 0;
    }

    if (why == LWS_CALLBACK_RECEIVE) {
        if (lws_frame_is_binary(wsi)) {
            if (server != nullptr && in != nullptr && len >= 1 && len <= 4) {
                server->injectMidi(static_cast<const uint8_t*>(in), static_cast<int>(len));
            }
            return 0;
        }

        // Clients may send transport shortcuts or {"view":"mixer"} to
        // scope the outbound telemetry to the active SPA tab.
        glz::generic doc;
        const auto ec = glz::read_json(doc, std::string_view(static_cast<const char*>(in), len));
        if (!ec) {
            std::string viewName;
            if (builder_json::getString(doc, "view", viewName) && !viewName.empty()) {
                if (pss != nullptr) {
                    const ClientView next = parseClientView(viewName);
                    if (next != pss->view) {
                        server->noteViewClosed(slotForView(pss->view));
                        server->noteViewOpened(slotForView(next));
                        pss->view = next;
                    }
                }
                // Mirror into server so native UI (Touch Bar highlight) tracks
                // the embedded SPA tab, not a hardcoded "player".
                server->noteClientView(viewName);
                // View change takes effect on the next fixed timer tick —
                // keeps cadence uniform (no burst frames).
                return 0;
            }

            int hz = 0;
            if (builder_json::getInt(doc, "telemetryHz", hz) && hz > 0) {
                if (pss != nullptr) {
                    const int clamped =
                        std::clamp(hz, WebServer::kTelemetryMinHz, WebServer::kTelemetryHz);
                    pss->requestedPeriodUs = 1'000'000 / clamped;
                    if (server != nullptr)
                        server->setTargetTelemetryHz(clamped);
                }
                return 0;
            }

            std::string action;
            if (builder_json::getString(doc, "action", action)
                || builder_json::getString(doc, "type", action)
                || builder_json::getString(doc, "command", action)) {
                if (action == "midi") {
                    int status = 0, d1 = 0, d2 = 0;
                    if (builder_json::getInt(doc, "status", status)
                        && builder_json::getInt(doc, "data1", d1)
                        && builder_json::getInt(doc, "data2", d2)) {
                        const uint8_t pkt[3] = { static_cast<uint8_t>(status),
                                                 static_cast<uint8_t>(d1),
                                                 static_cast<uint8_t>(d2) };
                        if (server != nullptr)
                            server->injectMidi(pkt, 3);
                    }
                    return 0;
                }
                if (action == "play")
                    server->enqueueCommand({WebCommandKind::Play, 0});
                else if (action == "stop")
                    server->enqueueCommand({WebCommandKind::Stop, 0});
                else if (action == "next")
                    server->enqueueCommand({WebCommandKind::Next, 0});
                else if (action == "prev")
                    server->enqueueCommand({WebCommandKind::Prev, 0});
                else if (action == "select") {
                    int idx = -1;
                    if (builder_json::getInt(doc, "index", idx) && idx >= 0)
                        server->enqueueCommand({WebCommandKind::SelectSong, idx});
                }
            }
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

void WebServer::injectMidi(const uint8_t* data, int length, int targetTrackIndex) {
    if (midiInputHandler != nullptr)
        midiInputHandler(data, length, targetTrackIndex);
}

bool WebServer::start(uint16_t port, std::string& error) {
    if (running.load(std::memory_order_acquire)) {
        error = "WebServer already running";
        return false;
    }

    stopRequested.store(false, std::memory_order_release);

    udpSocket_ = std::make_unique<juce::DatagramSocket>(/*enableBroadcasting=*/false);
    if (!udpSocket_->bindToPort(0)) {
        udpSocket_.reset();
    }

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
    info.options = LWS_SERVER_OPTION_VALIDATE_UTF8;
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
    udpSocket_.reset();
    running.store(false, std::memory_order_release);
    clients.store(0, std::memory_order_relaxed);
}

void WebServer::serviceLoop() {
    while (!stopRequested.load(std::memory_order_acquire)) {
        // 5ms poll: snappy timer delivery without spinning. Was 50ms which
        // alone added up to half a frame of jitter on top of the 33ms period.
        const int n = lws_service(context, 5);
        if (n < 0)
            break;
    }
}

void WebServer::publishState(const WebUiState& next) {
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        state = next;
        state.stateSessionId = stateSessionId_;
    }

    const auto watched = [this](ViewSlot slot) {
        return viewClients_[static_cast<size_t>(slot)].load(std::memory_order_relaxed) > 0;
    };
    const auto buildIf = [this](bool wanted, const char* view) {
        return wanted ? std::make_shared<const std::string>(buildStateJson(view))
                      : std::shared_ptr<const std::string>{};
    };

    auto player = buildIf(watched(ViewSlot::Player), "player");
    auto mixer = buildIf(watched(ViewSlot::Mixer), "mixer");
    auto editor = buildIf(watched(ViewSlot::Editor), "editor");
    auto settings = buildIf(watched(ViewSlot::Settings), "settings");
    auto light = buildIf(watched(ViewSlot::Light), "light");
    const uint32_t seq = ++telemetrySeq_;
    auto binary = std::make_shared<const std::vector<uint8_t>>(buildBinaryTelemetryFrame(next, seq));

    // High-speed UDP telemetry for embedded (Electron) mode: send binary telemetry frame
    // over loopback to 127.0.0.1:kUDPTelemetryPort and all remote UDP subscribers across LAN.
    // Decimated to match targetTelemetryHz_.
    const int targetHz = targetTelemetryHz_.load(std::memory_order_relaxed);
    const double targetPeriodSec = 1.0 / (targetHz > 0 ? targetHz : 60);
    const double nowSec = juce::Time::getMillisecondCounterHiRes() * 0.001;

    if (nowSec - lastUDPSendTimeSec_ >= targetPeriodSec - 0.002) {
        lastUDPSendTimeSec_ = nowSec;
        if (udpSocket_ != nullptr && binary != nullptr && !binary->empty()) {
            udpSocket_->write("127.0.0.1", kUDPTelemetryPort, binary->data(), static_cast<int>(binary->size()));

            std::lock_guard<std::mutex> lock(udpSubscribersMutex_);
            udpSubscribers_.erase(
                std::remove_if(udpSubscribers_.begin(), udpSubscribers_.end(),
                    [nowSec](const RemoteUDPSubscriber& s) { return (nowSec - s.lastSeenSec) > 15.0; }),
                udpSubscribers_.end());
            for (const auto& sub : udpSubscribers_) {
                udpSocket_->write(sub.ip.c_str(), sub.port, binary->data(), static_cast<int>(binary->size()));
            }
        }
    }

    if (clients.load(std::memory_order_relaxed) <= 0)
        return;

    {
        std::lock_guard<std::mutex> lock(frameMutex);

        // Only bump the generation when the bytes actually changed. Clients
        // skip a write whose generation they already hold (see
        // LWS_CALLBACK_SERVER_WRITEABLE), so an idle app -- transport stopped,
        // nobody touching anything -- goes from pushing a full ~20 KB frame at
        // the telemetry rate to pushing nothing at all.
        //
        // This only works because nothing in an idle frame ticks on its own
        // any more: audioCallbackCount used to, and was measured to be the
        // single reason consecutive idle frames differed (see
        // SystemHealth::sample). It is now frozen between 1 Hz samples, which
        // doubles as a natural keepalive -- an idle client still gets one
        // frame a second.
        // A view nobody is watching was not rebuilt; it keeps whatever it had
        // and counts as unchanged, so an unwatched tab can never by itself
        // force a generation bump and defeat the skip.
        bool changed = false;
        const auto adopt = [&changed](std::shared_ptr<const std::string>& cached,
                                      std::shared_ptr<const std::string>& fresh) {
            if (fresh == nullptr)
                return;
            if (cached == nullptr || *cached != *fresh) {
                cached = std::move(fresh);
                changed = true;
            }
        };
        adopt(frames.player, player);
        adopt(frames.mixer, mixer);
        adopt(frames.editor, editor);
        adopt(frames.settings, settings);
        adopt(frames.light, light);

        if (frames.binary == nullptr || *frames.binary != *binary) {
            frames.binary = std::move(binary);
            changed = true;
        }

        if (changed)
            ++frames.generation;
    }
}

std::shared_ptr<const std::string> WebServer::cachedFrameForView(const char* view) const {
    std::lock_guard<std::mutex> lock(frameMutex);
    // "all" is never cached: its only consumer is GET /api/v1/state, a
    // low-frequency endpoint that builds it live rather than have the 30 Hz
    // publish pay for a full snapshot nobody is streaming.
    if (view == nullptr || view[0] == '\0' || std::strcmp(view, "all") == 0)
        return {};
    if (std::strcmp(view, "mixer") == 0)
        return frames.mixer;
    if (std::strcmp(view, "editor") == 0 || std::strcmp(view, "builder") == 0)
        return frames.editor;
    if (std::strcmp(view, "settings") == 0)
        return frames.settings;
    if (std::strcmp(view, "light") == 0)
        return frames.light;
    return frames.player;
}

std::shared_ptr<const std::vector<uint8_t>> WebServer::cachedBinaryFrame() const {
    std::lock_guard<std::mutex> lock(frameMutex);
    return frames.binary;
}

uint64_t WebServer::frameGeneration() const {
    std::lock_guard<std::mutex> lock(frameMutex);
    return frames.generation;
}

bool WebServer::pollCommand(WebCommand& out) {
    if (!commands.try_dequeue(out)) return false;
    commandBytes.release(out.path.size() + out.json.size());
    return true;
}

bool WebServer::enqueueCommand(WebCommand cmd) {
    const auto size = cmd.path.size() + cmd.json.size();
    if (!commandBytes.reserve(size)) return false;
    if (!commands.try_enqueue(std::move(cmd))) {
        commandBytes.release(size);
        return false;
    }
    // Wake the message thread immediately so all incoming web commands
    // (transport, mixer faders, mutes, solos, actions, cues, settings) apply instantly.
    if (urgentCommandHook)
        urgentCommandHook();
    return true;
}

void WebServer::noteClientView(const std::string& view) {
    std::string v = view;
    if (v == "builder") v = "editor";
    if (v != "player" && v != "mixer" && v != "editor" && v != "light" && v != "settings")
        return;
    std::lock_guard<std::mutex> lock(clientViewMutex);
    clientView = std::move(v);
}

std::string WebServer::lastClientView() const {
    std::lock_guard<std::mutex> lock(clientViewMutex);
    return clientView;
}

void WebServer::onClientOpened() {
    clients.fetch_add(1, std::memory_order_relaxed);
}

void WebServer::noteViewOpened(ViewSlot slot) {
    viewClients_[static_cast<size_t>(slot)].fetch_add(1, std::memory_order_relaxed);
}

void WebServer::noteViewClosed(ViewSlot slot) {
    auto& counter = viewClients_[static_cast<size_t>(slot)];
    int expected = counter.load(std::memory_order_relaxed);
    while (expected > 0
           && !counter.compare_exchange_weak(expected, expected - 1, std::memory_order_relaxed)) {
        // retry
    }
}

void WebServer::reportClientPeriodUs(int periodUs) {
    if (periodUs <= 0)
        return;
    effectiveTelemetryHz_.store(std::max(1, 1'000'000 / periodUs), std::memory_order_relaxed);
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

} // namespace resostage
