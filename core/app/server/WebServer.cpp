#include "WebServer.h"

#include "network/UdpDiscovery.h"
#include "project/ProjectJson.h"
#include "events/MidiNoteActivity.h"
#include "server/WireTypes.h"
#include "server/BuilderJson.h"
#include "server/WebServerHttp.h"
#include <juce_core/juce_core.h>

#include <libwebsockets.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <optional>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace resostage {

using namespace wire;
using webserver_http::writeHttpResponse;
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

static std::vector<uint8_t> buildBinaryTelemetryFrame(const WebUiState& s, uint32_t seq) {
    const uint16_t numTracks = static_cast<uint16_t>(s.tracks.size());
    const uint16_t numMeters = static_cast<uint16_t>(s.meters.size());
    const uint16_t numLights = static_cast<uint16_t>(s.lightOutput.size());
    const uint16_t numBusses = static_cast<uint16_t>(s.busses.size());

    // Sparse per-track pitch bitmaps: worst case is 1024 tracks × 128 pitches
    // (about 18 KiB including row indices), while ordinary sessions send only
    // a few active rows. This is a full snapshot, not an event delta, so a lost
    // UDP packet cannot leave a key lit indefinitely.
    std::array<std::array<uint64_t, 2>, kMaxActiveMidiTracks> activeMidiMasks{};
    for (const auto& note : s.activeMidiNotes) {
        if (note.trackIndex < 0
            || static_cast<size_t>(note.trackIndex) >= kMaxActiveMidiTracks
            || note.pitch < 0 || note.pitch >= static_cast<int>(kMidiPitchCount))
            continue;
        const auto pitch = static_cast<size_t>(note.pitch);
        activeMidiMasks[static_cast<size_t>(note.trackIndex)][pitch / 64]
            |= uint64_t{1} << (pitch % 64);
    }
    uint16_t activeMidiTrackRows = 0;
    for (const auto& mask : activeMidiMasks)
        if (mask[0] != 0 || mask[1] != 0) ++activeMidiTrackRows;

    size_t ledByteCount = 0;
    for (const auto& lo : s.lightOutput)
        ledByteCount += std::min<size_t>(lo.ledColors.size(), 512) * 3;

    // v9 header is 66 bytes:
    // Layout:
    //   0  u16 magic (0x5253)
    //   2  u8  version (9)
    //   3  u8  flags (bit 0 = playing)
    //   4  u32 seq (monotonically increasing frame index)
    //   8  f32 playheadSeconds
    //  12  f32 clickPeakDbL
    //  16  f32 clickPeakDbR
    //  20  f32 clickIntervalPeakDbL
    //  24  f32 clickIntervalPeakDbR
    //  28  f32 bpm
    //  32  i16 songIndex
    //  34  u16 reserved (0)
    //  36  f32 globalPlayheadSeconds
    //  40  f32 driftFactor
    //  44  f32 cpuPercent
    //  48  f32 ramMb
    //  52  f32 totalRamMb
    //  56  u16 cpuCoreCount
    //  58  u16 numTracks
    //  60  u16 numMeters
    //  62  u16 numLights
    //  64  u16 numBusses
    // = 66 bytes
    const size_t totalSize = 66
        + static_cast<size_t>(numTracks) * 8
        + static_cast<size_t>(numMeters) * 16
        + static_cast<size_t>(numTracks)          // per-track flags
        + static_cast<size_t>(numBusses)          // per-bus flags
        + static_cast<size_t>(activeMidiTrackRows) * 18 // index + pitch mask
        + static_cast<size_t>(numLights) * 4  // fixtureIdx + ledCount per row
        + ledByteCount;

    std::vector<uint8_t> buf(totalSize);
    uint8_t* p = buf.data();

    const auto writeU32 = [&p](uint32_t val) {
        std::memcpy(p, &val, 4);
        p += 4;
    };
    const auto writeU64 = [&p](uint64_t val) {
        std::memcpy(p, &val, 8);
        p += 8;
    };
    const auto writeU16 = [&p](uint16_t val) {
        std::memcpy(p, &val, 2);
        p += 2;
    };
    const auto writeI16 = [&p](int16_t val) {
        std::memcpy(p, &val, 2);
        p += 2;
    };
    const auto writeU8 = [&p](uint8_t val) {
        *p++ = val;
    };
    const auto writeFloat = [&p](float val) {
        std::memcpy(p, &val, 4);
        p += 4;
    };

    writeU16(0x5253); // Magic "RS" (0x5253 in little-endian)
    writeU8(9);       // Version 9: v8 + active MIDI pitch masks
    writeU8(s.playing ? 1 : 0);
    writeU32(seq);
    writeFloat(static_cast<float>(s.playheadSeconds));
    writeFloat(s.clickPeakDbL);
    writeFloat(s.clickPeakDbR);
    writeFloat(s.clickIntervalPeakDbL);
    writeFloat(s.clickIntervalPeakDbR);
    writeFloat(static_cast<float>(s.bpm));
    writeI16(static_cast<int16_t>(s.songIndex));
    writeU16(activeMidiTrackRows);
    writeFloat(static_cast<float>(s.globalPlayheadSeconds));
    writeFloat(static_cast<float>(s.driftFactor)); // drift-correction factor
    writeFloat(static_cast<float>(std::max(0.0, s.cpuPercent)));
    writeFloat(static_cast<float>(s.rssBytes) / (1024.0f * 1024.0f));
    writeFloat(static_cast<float>(s.systemTotalBytes) / (1024.0f * 1024.0f));
    writeU16(static_cast<uint16_t>(std::max(1u, static_cast<uint32_t>(s.cpuCoreCount))));
    writeU16(numTracks);
    writeU16(numMeters);
    writeU16(numLights);
    writeU16(numBusses);

    for (const auto& tr : s.tracks) {
        writeFloat(tr.peakDbL);
        writeFloat(tr.peakDbR);
    }

    for (const auto& m : s.meters) {
        writeFloat(m.peakDbL);
        writeFloat(m.peakDbR);
        // What a bar is driven by. The peaks above stay as the last
        // callback's: the clip latch and the dB readout want that one.
        writeFloat(m.intervalPeakDbL);
        writeFloat(m.intervalPeakDbR);
    }

    // Per-track mixer flags (v5). Bit 0 = mute, bit 1 = solo, bit 2 =
    // soloActiveInGroup (this track is silenced by someone else's solo), bit 3 = soloSafe.
    for (const auto& tr : s.tracks) {
        uint8_t flags = 0;
        if (tr.mute) flags |= 1;
        if (tr.solo) flags |= 2;
        if (tr.soloActiveInGroup) flags |= 4;
        if (tr.soloSafe) flags |= 8;
        writeU8(flags);
    }
    // Per-bus mixer flags (v5).
    for (const auto& b : s.busses) {
        uint8_t flags = 0;
        if (b.mute) flags |= 1;
        if (b.solo) flags |= 2;
        if (b.soloActiveInGroup) flags |= 4;
        if (b.soloSafe) flags |= 8;
        writeU8(flags);
    }

    // Version 9 rows: u16 track index, then two u64 masks for pitches 0–63
    // and 64–127. Empty snapshots have zero rows and explicitly clear state.
    for (uint16_t track = 0; track < kMaxActiveMidiTracks; ++track) {
        const auto& mask = activeMidiMasks[track];
        if (mask[0] == 0 && mask[1] == 0) continue;
        writeU16(track);
        writeU64(mask[0]);
        writeU64(mask[1]);
    }

    // Per-LED wire colors, backend-rendered (see resolveLedWireColors) --
    // the frontend draws these as-is and never re-simulates an effect.
    // Each row: fixtureIdx (u16), ledCount (u16), then ledCount RGB triples.
    for (uint16_t i = 0; i < numLights; ++i) {
        const auto& lo = s.lightOutput[i];
        writeU16(static_cast<uint16_t>(std::max(0, lo.fixtureIdx)));
        const uint16_t n = static_cast<uint16_t>(
            std::min<size_t>(lo.ledColors.size(), 512));
        writeU16(n);
        for (uint16_t j = 0; j < n; ++j) {
            writeU8(static_cast<uint8_t>(std::clamp(lo.ledColors[j].r, 0, 255)));
            writeU8(static_cast<uint8_t>(std::clamp(lo.ledColors[j].g, 0, 255)));
            writeU8(static_cast<uint8_t>(std::clamp(lo.ledColors[j].b, 0, 255)));
        }
    }

    return buf;
}

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
                    return writeJsonError(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, "temp file");
                }
                return 0;
            }

            if (std::strncmp(uri, "/api/", 5) == 0) {
                pss->isApi = true;

                if (!isPost) {
                    if (std::strcmp(uri, "/api/v1/state") == 0) {
                        // Prefer prebuilt full frame; fall back to live build.
                        auto frame = server->cachedFrameForView("all");
                        const std::string json = frame && !frame->empty()
                            ? *frame
                            : server->buildStateJson("all");
                        return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json",
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
                        return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json",
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
                    double startSeconds = 0.0;
                    server->takeTrackImportTarget(songIndex, trackIndex, fileName, startSeconds);

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
                                                      static_cast<double>(trackIndex), finalPath,
                                                      "{\"startSeconds\":" + std::to_string(startSeconds) + "}"});
                } else {
                    server->enqueueCommand(
                        WebCommand{WebCommandKind::LoadProjectFromPath, 0, 0.0, std::string(pss->uploadPath)});
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
                server->registerUdpSubscriber(clientIp);
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

void WebServer::setTargetTelemetryHz(int hz) {
    const int clamped = std::clamp(hz, kTelemetryMinHz, kTelemetryHz);
    targetTelemetryHz_.store(clamped, std::memory_order_relaxed);
    effectiveTelemetryHz_.store(clamped, std::memory_order_relaxed);
}

void WebServer::publishState(const WebUiState& next) {
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        state = next;
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
    // over loopback to 127.0.0.1:kUdpTelemetryPort and all remote UDP subscribers across LAN.
    // Decimated to match targetTelemetryHz_.
    const int targetHz = targetTelemetryHz_.load(std::memory_order_relaxed);
    const double targetPeriodSec = 1.0 / (targetHz > 0 ? targetHz : 60);
    const double nowSec = juce::Time::getMillisecondCounterHiRes() * 0.001;

    if (nowSec - lastUdpSendTimeSec_ >= targetPeriodSec - 0.002) {
        lastUdpSendTimeSec_ = nowSec;
        if (udpSocket_ != nullptr && binary != nullptr && !binary->empty()) {
            udpSocket_->write("127.0.0.1", kUdpTelemetryPort, binary->data(), static_cast<int>(binary->size()));

            std::lock_guard<std::mutex> lock(udpSubscribersMutex_);
            udpSubscribers_.erase(
                std::remove_if(udpSubscribers_.begin(), udpSubscribers_.end(),
                    [nowSec](const RemoteUdpSubscriber& s) { return (nowSec - s.lastSeenSec) > 15.0; }),
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
    return commands.try_dequeue(out);
}

void WebServer::enqueueCommand(WebCommand cmd) {
    commands.try_enqueue(std::move(cmd));
    // Wake the message thread immediately so all incoming web commands
    // (transport, mixer faders, mutes, solos, actions, cues, settings) apply instantly.
    if (urgentCommandHook)
        urgentCommandHook();
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

void WebServer::registerUdpSubscriber(const std::string& ip, int port) {
    if (ip.empty() || port <= 0 || port > 65535)
        return;
    // libwebsockets may report an IPv4 peer through an IPv6-mapped address.
    // DatagramSocket's IPv4 write expects the dotted quad.
    const std::string normalizedIp = ip.rfind("::ffff:", 0) == 0 ? ip.substr(7) : ip;
    const double nowSec = juce::Time::getMillisecondCounterHiRes() * 0.001;
    std::lock_guard<std::mutex> lock(udpSubscribersMutex_);
    for (auto& s : udpSubscribers_) {
        if (s.ip == normalizedIp && s.port == port) {
            s.lastSeenSec = nowSec;
            return;
        }
    }
    udpSubscribers_.push_back({normalizedIp, port, nowSec});
}

} // namespace resostage
