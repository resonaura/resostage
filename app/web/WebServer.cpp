#include "WebServer.h"
#include "EmbeddedAssets.h"

#include "audio/WavStreamDecoder.h"
#include "project/ProjectLoader.h"

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
#include <fstream>
#include <sstream>
#include <string_view>
#include <vector>

namespace resostage {

namespace {

// Max WS text frame we will send. View-filtered payloads are typically a few
// KB; this is a safety net for huge editor projects.
constexpr size_t kWsTxMax = 512 * 1024;

// Target telemetry period — every client starts here and recovers back
// toward it; see kTelemetryMinPeriodUs / LWS_CALLBACK_TIMER for the adaptive
// backoff that can slow an individual client down under backpressure.
constexpr int kTelemetryPeriodUs = WebServer::kTelemetryPeriodUs;
constexpr int kTelemetryMinPeriodUs = WebServer::kTelemetryMinPeriodUs;

// Which SPA tab the client is showing -- drives buildStateJson() so we only
// push fields that page needs (transport/time always).
enum class ClientView : uint8_t { Player, Mixer, Editor, Settings };

// Consecutive backpressure ticks (previous period's write never completed)
// before backing this client off to half its rate. Kept short (~100ms at the
// full 30Hz rate) so a real stall is caught fast.
constexpr int kBackoffAfterConsecutiveDrops = 3;
// Consecutive clean ticks before stepping the rate back up toward
// kTelemetryHz. Kept long (~2s at 30Hz) relative to the backoff trigger so
// a client hovering right at its capacity doesn't oscillate ("float")
// between two rates every couple hundred ms.
constexpr int kRecoverAfterConsecutiveOk = 60;

struct WsSession {
    WebServer* server = nullptr;
    struct lws* wsi = nullptr;
    bool writePending = false;
    bool sendBinaryNext = false;
    ClientView view = ClientView::Player;
    // Adaptive per-client send period -- see LWS_CALLBACK_TIMER below.
    int periodUs = kTelemetryPeriodUs;
    int badStreak = 0;
    int goodStreak = 0;
};

ClientView parseClientView(const std::string& s) {
    if (s == "mixer") return ClientView::Mixer;
    if (s == "editor" || s == "builder") return ClientView::Editor;
    if (s == "settings") return ClientView::Settings;
    return ClientView::Player;
}

static std::vector<uint8_t> buildBinaryTelemetryFrame(const WebUiState& s) {
    const uint16_t numTracks = static_cast<uint16_t>(s.tracks.size());
    const uint16_t numMeters = static_cast<uint16_t>(s.meters.size());
    const uint16_t numLights = static_cast<uint16_t>(s.lightOutput.size());

    size_t ledByteCount = 0;
    for (const auto& lo : s.lightOutput)
        ledByteCount += std::min<size_t>(lo.ledColors.size(), 512) * 3;

    const size_t totalSize = 24
        + static_cast<size_t>(numTracks) * 8
        + static_cast<size_t>(numMeters) * 8
        + static_cast<size_t>(numLights) * 4  // fixtureIdx + ledCount per row
        + ledByteCount;

    std::vector<uint8_t> buf(totalSize);
    uint8_t* p = buf.data();

    const auto writeU16 = [&p](uint16_t val) {
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
    writeU8(2);       // Version 2: per-LED light rows (v1 carried effect params)
    writeU8(0);       // Flags
    writeFloat(static_cast<float>(s.playheadSeconds));
    writeFloat(s.clickPeakDbL);
    writeFloat(s.clickPeakDbR);
    writeU16(numTracks);
    writeU16(numMeters);
    writeU16(numLights);
    writeU16(0); // Reserved

    for (const auto& tr : s.tracks) {
        writeFloat(tr.peakDbL);
        writeFloat(tr.peakDbR);
    }

    for (const auto& m : s.meters) {
        writeFloat(m.peakDbL);
        writeFloat(m.peakDbR);
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

// Percent-decodes a URL query-string value (e.g. "Audio%2Fkick.wav" ->
// "Audio/kick.wav", "+" -> " "). Malformed escapes are passed through as-is.
std::string urlDecode(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size() && std::isxdigit(static_cast<unsigned char>(s[i + 1]))
            && std::isxdigit(static_cast<unsigned char>(s[i + 2]))) {
            const int hi = std::isdigit(static_cast<unsigned char>(s[i + 1])) ? s[i + 1] - '0' : (std::tolower(s[i + 1]) - 'a' + 10);
            const int lo = std::isdigit(static_cast<unsigned char>(s[i + 2])) ? s[i + 2] - '0' : (std::tolower(s[i + 2]) - 'a' + 10);
            out += static_cast<char>((hi << 4) | lo);
            i += 2;
        } else if (s[i] == '+') {
            out += ' ';
        } else {
            out += s[i];
        }
    }
    return out;
}

// Extracts `key`'s value from a raw "a=1&b=2" query string (as returned by
// lws' WSI_TOKEN_HTTP_URI_ARGS), percent-decoded. Empty string if absent.
std::string queryParam(const char* queryArgs, const char* key) {
    if (queryArgs == nullptr)
        return {};
    const std::string args(queryArgs);
    const std::string prefix = std::string(key) + "=";
    size_t pos = 0;
    while (pos < args.size()) {
        const size_t amp = args.find('&', pos);
        const std::string part = args.substr(pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (part.compare(0, prefix.size(), prefix) == 0)
            return urlDecode(part.substr(prefix.size()));
        if (amp == std::string::npos)
            break;
        pos = amp + 1;
    }
    return {};
}

// Guards against NaN/Inf reaching the wire: ostringstream would emit "nan"/
// "inf" tokens, which are not valid JSON and would make every connected
// browser's JSON.parse() throw, silently freezing the remote UI. Mirrors the
// equivalent guard in ProjectJson.cpp's writeNumber().
double finiteOrZero(double v) {
    return std::isfinite(v) ? v : 0.0;
}

// Meter levels: non-finite / absurd values must NOT become 0.0 (0 dBFS =
// full-scale bar flash). Floor them instead.
double finiteOrDbFloor(double v) {
    if (!std::isfinite(v) || v < -144.0)
        return -144.0;
    if (v > 24.0)
        return 24.0;
    return v;
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
        "/api/v1/track/mono",
        "/api/v1/bus/gain",   "/api/v1/bus/mute",   "/api/v1/bus/solo",
        "/api/v1/click/solo",
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
    if (std::strcmp(path, "/api/v1/track/mono") == 0) return WebCommandKind::SetTrackMono;
    if (std::strcmp(path, "/api/v1/bus/gain") == 0) return WebCommandKind::SetBusGain;
    if (std::strcmp(path, "/api/v1/bus/mute") == 0) return WebCommandKind::SetBusMute;
    if (std::strcmp(path, "/api/v1/bus/solo") == 0) return WebCommandKind::SetBusSolo;
    return WebCommandKind::SetClickSolo; // "/api/v1/click/solo" -- last remaining option per isMixerCommandPath's list
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
    {"/api/v1/builder/song/import-folder", WebCommandKind::BuilderSongImportFolder},
    {"/api/v1/builder/song/remove", WebCommandKind::BuilderSongRemove},
    {"/api/v1/builder/song/move", WebCommandKind::BuilderSongMove},
    {"/api/v1/builder/song/update", WebCommandKind::BuilderSongUpdate},
    {"/api/v1/builder/track/add", WebCommandKind::BuilderTrackAdd},
    {"/api/v1/builder/track/remove", WebCommandKind::BuilderTrackRemove},
    {"/api/v1/builder/track/move", WebCommandKind::BuilderTrackMove},
    {"/api/v1/builder/track/update", WebCommandKind::BuilderTrackUpdate},
    {"/api/v1/builder/track/import-wav/begin", WebCommandKind::BuilderTrackImportWavBegin},
    {"/api/v1/builder/region/add", WebCommandKind::BuilderRegionAdd},
    {"/api/v1/builder/region/remove", WebCommandKind::BuilderRegionRemove},
    {"/api/v1/builder/region/update", WebCommandKind::BuilderRegionUpdate},
    {"/api/v1/builder/bus/add", WebCommandKind::BuilderBusAdd},
    {"/api/v1/builder/bus/remove", WebCommandKind::BuilderBusRemove},
    {"/api/v1/builder/bus/move", WebCommandKind::BuilderBusMove},
    {"/api/v1/builder/bus/update", WebCommandKind::BuilderBusUpdate},
    {"/api/v1/builder/event/add", WebCommandKind::BuilderEventAdd},
    {"/api/v1/builder/event/remove", WebCommandKind::BuilderEventRemove},
    {"/api/v1/builder/event/move", WebCommandKind::BuilderEventMove},
    {"/api/v1/builder/event/update", WebCommandKind::BuilderEventUpdate},
    {"/api/v1/builder/section/add", WebCommandKind::BuilderSectionAdd},
    {"/api/v1/builder/section/remove", WebCommandKind::BuilderSectionRemove},
    {"/api/v1/builder/section/update", WebCommandKind::BuilderSectionUpdate},
    {"/api/v1/lighting/config", WebCommandKind::SetLightingConfig},
    {"/api/v1/lighting/fixture/add", WebCommandKind::LightFixtureAdd},
    {"/api/v1/lighting/fixture/remove", WebCommandKind::LightFixtureRemove},
    {"/api/v1/lighting/fixture/update", WebCommandKind::LightFixtureUpdate},
    {"/api/v1/lighting/track/add", WebCommandKind::LightTrackAdd},
    {"/api/v1/lighting/track/remove", WebCommandKind::LightTrackRemove},
    {"/api/v1/lighting/track/move", WebCommandKind::LightTrackMove},
    {"/api/v1/lighting/track/update", WebCommandKind::LightTrackUpdate},
    {"/api/v1/lighting/cue/add", WebCommandKind::LightCueAdd},
    {"/api/v1/lighting/cue/remove", WebCommandKind::LightCueRemove},
    {"/api/v1/lighting/cue/update", WebCommandKind::LightCueUpdate},
    {"/api/v1/timeline/undo", WebCommandKind::TimelineUndo},
    {"/api/v1/timeline/redo", WebCommandKind::TimelineRedo},
    {"/api/v1/settings/audio-device", WebCommandKind::SetAudioOutputDevice},
    {"/api/v1/settings/sample-rate", WebCommandKind::SetSampleRate},
    {"/api/v1/settings/buffer-size", WebCommandKind::SetBufferSize},
    {"/api/v1/settings/midi-output", WebCommandKind::SetMidiOutput},
    {"/api/v1/settings/midi-input", WebCommandKind::SetMidiInput},
    {"/api/v1/settings/midi-virtual-port", WebCommandKind::SetMidiVirtualPort},
    {"/api/v1/settings/keybinding", WebCommandKind::SetKeybinding},
    {"/api/v1/settings/output-channels", WebCommandKind::SetOutputChannels},
    {"/api/v1/settings/midi-learn", WebCommandKind::MidiLearn},
    {"/api/v1/settings/midi-learn-cancel", WebCommandKind::MidiLearnCancel},
    {"/api/v1/settings/midi-clear", WebCommandKind::MidiClear},
    {"/api/v1/transport/seek", WebCommandKind::Seek},
    {"/api/v1/mixer/track/send", WebCommandKind::SetTrackSend},
    {"/api/v1/mixer/track/send/remove", WebCommandKind::RemoveTrackSend},
    {"/api/v1/project/name", WebCommandKind::SetProjectName},
    {"/api/v1/ui/focus-state", WebCommandKind::UiFocusState},
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
    // Nothing served here should ever be cached -- the SPA bundle is
    // rebaked into the binary on every dev iteration with no versioned URL
    // (index.html is always "/"), and WKWebView's persistent disk cache in
    // particular is happy to keep serving a stale bundle across app
    // relaunches without this. Every response is either tiny/dynamic
    // (state/JSON) or the whole point is "must reflect the latest build".
    if (lws_add_http_header_by_name(wsi,
                                    reinterpret_cast<const unsigned char*>("cache-control"),
                                    reinterpret_cast<const unsigned char*>("no-store, must-revalidate"), 24, &p, end))
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
                    if (std::strcmp(uri, "/api/v1/player/peaks") == 0)
                        return server->servePeaks(wsi);
                    if (std::strcmp(uri, "/api/v1/player/peaks-all") == 0)
                        return server->serveAllPeaks(wsi);
                    if (std::strcmp(uri, "/api/v1/player/waveform-raw") == 0) {
                        char argsBuf[512] = "";
                        lws_hdr_copy(wsi, argsBuf, sizeof(argsBuf), WSI_TOKEN_HTTP_URI_ARGS);
                        return server->serveWaveformRaw(wsi, argsBuf);
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
            pss->writePending = false;
            pss->view = ClientView::Player;
            pss->periodUs = kTelemetryPeriodUs;
            pss->badStreak = 0;
            pss->goodStreak = 0;
            server->onClientOpened();
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
            if (server != nullptr)
                server->onClientClosed();
            return 0;
    }

    if (why == LWS_CALLBACK_TIMER) {
            if (pss != nullptr) {
                // Adaptive backoff: pss->writePending still being true here
                // means the write armed last period never actually completed
                // -- SERVER_WRITEABLE hasn't fired since (OS send buffer
                // still full), whether because the browser/JS main thread is
                // too busy to drain the socket or the network/backend can't
                // keep up. Either way, back this client off. Recover only
                // after a long clean streak so a client hovering right at
                // its capacity settles on one rate instead of oscillating.
                if (pss->writePending) {
                    pss->goodStreak = 0;
                    if (++pss->badStreak >= kBackoffAfterConsecutiveDrops) {
                        pss->badStreak = 0;
                        pss->periodUs = std::min(pss->periodUs * 2, kTelemetryMinPeriodUs);
                        server->reportClientPeriodUs(pss->periodUs);
                    }
                } else {
                    pss->badStreak = 0;
                    if (pss->periodUs > kTelemetryPeriodUs && ++pss->goodStreak >= kRecoverAfterConsecutiveOk) {
                        pss->goodStreak = 0;
                        pss->periodUs = std::max(pss->periodUs / 2, kTelemetryPeriodUs);
                        server->reportClientPeriodUs(pss->periodUs);
                    }
                }
                // Always arm exactly one write per period. If the previous
                // write is still pending (slow client), drop that slot —
                // next tick sends the latest prebuilt frame (never backlog).
                pss->writePending = true;
                pss->sendBinaryNext = true;
                lws_callback_on_writable(wsi);
                lws_set_timer_usecs(wsi, pss->periodUs);
            }
            return 0;
    }

    if (why == LWS_CALLBACK_SERVER_WRITEABLE) {
            if (pss == nullptr || server == nullptr || !pss->writePending)
                return 0;

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
            return 0;
    }

    if (why == LWS_CALLBACK_RECEIVE) {
            // Clients may send transport shortcuts or {"view":"mixer"} to
            // scope the outbound telemetry to the active SPA tab.
            if (server == nullptr || in == nullptr || len == 0)
                return 0;
            const std::string msg(static_cast<const char*>(in), len);
            std::string viewRaw;
            if (findJsonField(msg, "\"view\"", viewRaw)
                && viewRaw.size() >= 2 && viewRaw.front() == '"' && viewRaw.back() == '"') {
                const std::string viewName = viewRaw.substr(1, viewRaw.size() - 2);
                if (pss != nullptr)
                    pss->view = parseClientView(viewName);
                // Mirror into server so native UI (Touch Bar highlight) tracks
                // the embedded SPA tab, not a hardcoded "player".
                server->noteClientView(viewName);
                // View change takes effect on the next fixed timer tick —
                // keeps cadence uniform (no burst frames).
                return 0;
            }
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
    }

    // No connected SPA — skip the serialize work. REST /api/v1/state falls
    // back to a live buildStateJson("all") if the cache is empty.
    if (clients.load(std::memory_order_relaxed) <= 0)
        return;

    // Serialize once per publish on the message thread. The WS service thread
    // only does shared_ptr copies of these strings — rebuild cost no longer
    // scales with client count and no longer blocks lws_service.
    //
    // Note: each buildStateJson re-copies `state` under the mutex; at 30 Hz
    // with a single client that is still far cheaper than rebuilding per
    // WS writable (the previous path).
    auto player = std::make_shared<const std::string>(buildStateJson("player"));
    auto mixer = std::make_shared<const std::string>(buildStateJson("mixer"));
    auto editor = std::make_shared<const std::string>(buildStateJson("editor"));
    auto settings = std::make_shared<const std::string>(buildStateJson("settings"));
    auto all = std::make_shared<const std::string>(buildStateJson("all"));
    auto binary = std::make_shared<const std::vector<uint8_t>>(buildBinaryTelemetryFrame(next));

    {
        std::lock_guard<std::mutex> lock(frameMutex);
        frames.player = std::move(player);
        frames.mixer = std::move(mixer);
        frames.editor = std::move(editor);
        frames.settings = std::move(settings);
        frames.all = std::move(all);
        frames.binary = std::move(binary);
        ++frames.generation;
    }
}

std::shared_ptr<const std::string> WebServer::cachedFrameForView(const char* view) const {
    std::lock_guard<std::mutex> lock(frameMutex);
    if (view == nullptr || view[0] == '\0' || std::strcmp(view, "all") == 0)
        return frames.all;
    if (std::strcmp(view, "mixer") == 0)
        return frames.mixer;
    if (std::strcmp(view, "editor") == 0 || std::strcmp(view, "builder") == 0)
        return frames.editor;
    if (std::strcmp(view, "settings") == 0)
        return frames.settings;
    return frames.player;
}

std::shared_ptr<const std::vector<uint8_t>> WebServer::cachedBinaryFrame() const {
    std::lock_guard<std::mutex> lock(frameMutex);
    return frames.binary;
}

bool WebServer::pollCommand(WebCommand& out) {
    return commands.try_dequeue(out);
}

void WebServer::enqueueCommand(WebCommand cmd) {
    const WebCommandKind kind = cmd.kind;
    commands.try_enqueue(std::move(cmd));
    // Transport / setlist: wake the message thread immediately.
    switch (kind) {
        case WebCommandKind::Play:
        case WebCommandKind::Stop:
        case WebCommandKind::StopToStart:
        case WebCommandKind::Next:
        case WebCommandKind::Prev:
        case WebCommandKind::SelectSong:
        case WebCommandKind::Seek:
            if (urgentCommandHook)
                urgentCommandHook();
            break;
        default:
            break;
    }
}

void WebServer::noteClientView(const std::string& view) {
    std::string v = view;
    if (v == "builder") v = "editor";
    if (v != "player" && v != "mixer" && v != "editor" && v != "settings")
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

std::string WebServer::buildStateJson(const char* view) const {
    WebUiState snap;
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        snap = state;
    }

    // View scopes the heavy arrays. Transport / time / status always go out.
    // REST calls with view=nullptr/"all" get the full snapshot.
    const bool all = (view == nullptr || view[0] == '\0'
                      || std::strcmp(view, "all") == 0);
    const bool isPlayer = all || std::strcmp(view, "player") == 0;
    const bool isMixer = all || std::strcmp(view, "mixer") == 0;
    const bool isEditor = all || std::strcmp(view, "editor") == 0
                          || std::strcmp(view, "builder") == 0;
    const bool isSettings = all || std::strcmp(view, "settings") == 0;

    // Songs: player + editor (timeline/hotkeys). Editor needs full detail.
    const bool wantSongs = all || isPlayer || isEditor || isMixer;
    const bool wantSongsFull = all || isEditor; // events, full region fades, clickSends
    const bool wantMeters = all || isPlayer || isMixer;
    const bool wantTracks = all || isPlayer || isMixer || isEditor;
    const bool wantBusses = all || isPlayer || isMixer || isEditor;
    const bool wantClick = all || isPlayer || isMixer;
    const bool wantHealth = all || isPlayer || isSettings;
    const bool wantHealthProcs = all || isSettings;
    // Always ship full device/MIDI lists. They are tiny (~1–2 KB) and omitting
    // them on non-settings views left the SPA with empty selects forever when
    // the first hydrated frame had no lists and merge refused to "clear" later.
    const bool wantSettingsFull = true;
    (void)isSettings; // still used for midiBindings detail below

    std::ostringstream o;
    o.setf(std::ios::fixed);
    o.precision(3);

    // ── Always: transport / time / status ──────────────────────────────
    o << "{"
      << "\"projectName\":\"" << jsonEscape(snap.projectName) << "\","
      << "\"songName\":\"" << jsonEscape(snap.songName) << "\","
      << "\"playheadSeconds\":" << finiteOrZero(snap.playheadSeconds) << ","
      << "\"globalPlayheadSeconds\":" << finiteOrZero(snap.globalPlayheadSeconds) << ","
      << "\"globalBeatsElapsed\":" << finiteOrZero(snap.globalBeatsElapsed) << ","
      << "\"sampleRate\":" << finiteOrZero(snap.sampleRate) << ","
      << "\"drift\":" << finiteOrZero(snap.driftFactor) << ","
      << "\"bpm\":" << finiteOrZero(snap.bpm) << ","
      << "\"playing\":" << (snap.playing ? "true" : "false") << ","
      << "\"hardwareAlarm\":" << (snap.hardwareAlarm ? "true" : "false") << ","
      << "\"songIndex\":" << snap.songIndex << ","
      << "\"songCount\":" << snap.songCount << ","
      << "\"statusMessage\":\"" << jsonEscape(snap.statusMessage) << "\","
      << "\"busy\":" << (snap.busy ? "true" : "false") << ","
      << "\"quitConfirmPending\":" << (snap.quitConfirmPending ? "true" : "false") << ","
      << "\"uiTab\":\"" << jsonEscape(snap.uiTab) << "\","
      << "\"uiTabSeq\":" << snap.uiTabSeq << ","
      << "\"canUndo\":" << (snap.canUndo ? "true" : "false") << ","
      << "\"canRedo\":" << (snap.canRedo ? "true" : "false") << ","
      << "\"undoLabel\":\"" << jsonEscape(snap.undoLabel) << "\","
      << "\"redoLabel\":\"" << jsonEscape(snap.redoLabel) << "\","
      << "\"lastAction\":\"" << jsonEscape(snap.lastAction) << "\","
      << "\"lastActionNonce\":" << snap.lastActionNonce << ","
      << "\"wsHz\":" << effectiveTelemetryHz();

    if (wantClick) {
        o << ","
          << "\"clickGainDb\":" << finiteOrZero(snap.clickGainDb) << ","
          << "\"clickPan\":" << finiteOrZero(snap.clickPan) << ","
          << "\"clickSolo\":" << (snap.clickSolo ? "true" : "false") << ","
          << "\"clickPeakDb\":" << finiteOrDbFloor(snap.clickPeakDb) << ","
          << "\"clickPeakDbL\":" << finiteOrDbFloor(snap.clickPeakDbL) << ","
          << "\"clickPeakDbR\":" << finiteOrDbFloor(snap.clickPeakDbR) << ","
          << "\"streamBufferMinSec\":" << finiteOrZero(snap.streamBufferMinSec) << ","
          << "\"streamBufferAvgSec\":" << finiteOrZero(snap.streamBufferAvgSec) << ","
          << "\"streamResidentTracks\":" << snap.streamResidentTracks << ","
          << "\"streamStreamingTracks\":" << snap.streamStreamingTracks << ","
          << "\"streamBufferUrgent\":" << (snap.streamBufferUrgent ? "true" : "false") << ","
          << "\"streamResidentMiB\":" << finiteOrZero(snap.streamResidentMiB);
    }

    if (wantSongs) {
        o << ",\"songs\":[";
        for (size_t i = 0; i < snap.songs.size(); ++i) {
            if (i) o << ",";
            const auto& song = snap.songs[i];
            o << "{\"name\":\"" << jsonEscape(song.name) << "\","
              << "\"bpm\":" << finiteOrZero(song.bpm) << ","
              << "\"mode\":\"" << (song.autoplay ? "auto" : "wait") << "\","
              << "\"tsNum\":" << song.tsNum << ","
              << "\"tsDen\":" << song.tsDen << ","
              << "\"click\":" << (song.click ? "true" : "false") << ","
              << "\"clickBusId\":\"" << jsonEscape(song.clickBusId) << "\","
              << "\"clickGainDb\":" << finiteOrZero(song.clickGainDb) << ",";

            if (wantSongsFull) {
                o << "\"clickSends\":[";
                for (size_t ci = 0; ci < song.clickSends.size(); ++ci) {
                    if (ci) o << ",";
                    const auto& cs = song.clickSends[ci];
                    o << "{\"busId\":\"" << jsonEscape(cs.busId) << "\","
                      << "\"gainDb\":" << finiteOrZero(cs.gainDb) << ","
                      << "\"enabled\":" << (cs.enabled ? "true" : "false") << "}";
                }
                o << "],";
            } else {
                o << "\"clickSends\":[],";
            }

            // Regions: player needs bounds for timeline length; editor needs
            // full fade/loop detail for the interactive editor.
            o << "\"regions\":[";
            for (size_t j = 0; j < song.regions.size(); ++j) {
                if (j) o << ",";
                const auto& r = song.regions[j];
                o << "{\"id\":\"" << jsonEscape(r.id) << "\","
                  << "\"trackId\":\"" << jsonEscape(r.trackId) << "\","
                  << "\"file\":\"" << jsonEscape(r.file) << "\","
                  << "\"startSeconds\":" << finiteOrZero(r.startSeconds) << ","
                  << "\"sourceOffsetSeconds\":" << finiteOrZero(r.sourceOffsetSeconds) << ","
                  << "\"durationSeconds\":" << finiteOrZero(r.durationSeconds) << ","
                  << "\"gainDb\":" << finiteOrZero(r.gainDb);
                if (wantSongsFull || isPlayer) {
                    o << ",\"fadeInSeconds\":" << finiteOrZero(r.fadeInSeconds)
                      << ",\"fadeOutSeconds\":" << finiteOrZero(r.fadeOutSeconds)
                      << ",\"fadeInCurve\":" << finiteOrZero(r.fadeInCurve)
                      << ",\"fadeOutCurve\":" << finiteOrZero(r.fadeOutCurve)
                      << ",\"loop\":" << (r.loop ? "true" : "false")
                      << ",\"loopLengthSeconds\":" << finiteOrZero(r.loopLengthSeconds);
                }
                o << "}";
            }
            o << "],";

            if (wantSongsFull) {
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
                o << "],";
            } else {
                o << "\"events\":[],";
            }

            // Sections always with songs (section hotkeys on every page).
            o << "\"sections\":[";
            for (size_t j = 0; j < song.sections.size(); ++j) {
                if (j) o << ",";
                const auto& sec = song.sections[j];
                o << "{\"id\":\"" << jsonEscape(sec.id) << "\","
                  << "\"name\":\"" << jsonEscape(sec.name) << "\","
                  << "\"startSeconds\":" << finiteOrZero(sec.startSeconds) << ","
                  << "\"colorIndex\":" << sec.colorIndex << "}";
            }
            o << "],";

            // Light cues always with songs too -- small dataset, and the
            // Player's Timeline needs them for its non-clickable audio-mode
            // hint strip even though it never edits them (see RESTORE_POINT.md
            // Feature 6).
            o << "\"lightCues\":[";
            for (size_t j = 0; j < song.lightCues.size(); ++j) {
                if (j) o << ",";
                const auto& lc = song.lightCues[j];
                o << "{\"id\":\"" << jsonEscape(lc.id) << "\","
                  << "\"trackId\":\"" << jsonEscape(lc.trackId) << "\","
                  << "\"startSeconds\":" << finiteOrZero(lc.startSeconds) << ","
                  << "\"durationSeconds\":" << finiteOrZero(lc.durationSeconds) << ","
                  << "\"colorR\":" << lc.colorR << ","
                  << "\"colorG\":" << lc.colorG << ","
                  << "\"colorB\":" << lc.colorB << ","
                  << "\"intensity\":" << finiteOrZero(lc.intensity) << ","
                  << "\"fadeInSeconds\":" << finiteOrZero(lc.fadeInSeconds) << ","
                  << "\"fadeOutSeconds\":" << finiteOrZero(lc.fadeOutSeconds) << ","
                  << "\"label\":\"" << jsonEscape(lc.label) << "\","
                  << "\"effectType\":\"" << jsonEscape(lc.effectType) << "\","
                  << "\"effectSourceType\":\"" << jsonEscape(lc.effectSourceType) << "\","
                  << "\"effectSourceId\":\"" << jsonEscape(lc.effectSourceId) << "\","
                  << "\"effectIntensity\":" << finiteOrZero(lc.effectIntensity) << ","
                  << "\"tempoSync\":" << (lc.tempoSync ? "true" : "false") << ","
                  << "\"tempoSubdiv\":\"" << jsonEscape(lc.tempoSubdiv) << "\","
                  << "\"effectRateHz\":" << finiteOrZero(lc.effectRateHz) << ","
                  << "\"gradientPreset\":\"" << jsonEscape(lc.gradientPreset) << "\","
                  << "\"gradientColors\":\"" << jsonEscape(lc.gradientColors) << "\","
                  << "\"blendMode\":\"" << jsonEscape(lc.blendMode) << "\"}";
            }
            o << "]}";
        }
        o << "]";
    }

    if (wantMeters) {
        o << ",\"meters\":[";
        for (size_t i = 0; i < snap.meters.size(); ++i) {
            if (i) o << ",";
            o << "{\"id\":\"" << jsonEscape(snap.meters[i].id) << "\","
              << "\"peakDb\":" << finiteOrDbFloor(snap.meters[i].peakDb) << ","
              << "\"peakDbL\":" << finiteOrDbFloor(snap.meters[i].peakDbL) << ","
              << "\"peakDbR\":" << finiteOrDbFloor(snap.meters[i].peakDbR) << ","
              << "\"shortTermLufs\":" << finiteOrZero(snap.meters[i].shortTermLufs) << "}";
        }
        o << "]";
    }

    if (wantTracks) {
        o << ",\"tracks\":[";
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
              << "\"mono\":" << (t.mono ? "true" : "false") << ","
              << "\"sends\":[";
            if (isMixer || all) {
                for (size_t si = 0; si < t.sends.size(); ++si) {
                    if (si) o << ",";
                    o << "{\"busId\":\"" << jsonEscape(t.sends[si].busId) << "\","
                      << "\"gainDb\":" << finiteOrZero(t.sends[si].gainDb) << "}";
                }
            }
            o << "],"
              << "\"peakDb\":" << finiteOrDbFloor(t.peakDb) << ","
              << "\"peakDbL\":" << finiteOrDbFloor(t.peakDbL) << ","
              << "\"peakDbR\":" << finiteOrDbFloor(t.peakDbR) << "}";
        }
        o << "]";
    }

    if (wantBusses) {
        o << ",\"busses\":[";
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
              << "\"peakDb\":" << finiteOrDbFloor(b.peakDb) << ","
              << "\"peakDbL\":" << finiteOrDbFloor(b.peakDbL) << ","
              << "\"peakDbR\":" << finiteOrDbFloor(b.peakDbR) << "}";
        }
        o << "]";
    }

    // Lighting config + fixture roster -- always shipped, tiny like the
    // settings device/MIDI lists (a handful of fixtures at most), and needed
    // by the Settings project card, the Editor's Light-mode timeline, and
    // Player's non-clickable light hint strip alike.
    {
        const auto& li = snap.lighting;
        o << ",\"lighting\":{"
          << "\"enabled\":" << (li.enabled ? "true" : "false") << ","
          << "\"kind\":\"" << jsonEscape(li.kind) << "\","
          << "\"resoLightColumns\":" << li.resoLightColumns << ","
          << "\"resoLightRows\":" << li.resoLightRows << ","
          << "\"idleBehavior\":\"" << jsonEscape(li.idleBehavior) << "\","
          << "\"idleColorR\":" << li.idleColorR << ","
          << "\"idleColorG\":" << li.idleColorG << ","
          << "\"idleColorB\":" << li.idleColorB << ","
          << "\"idleIntensity\":" << finiteOrZero(li.idleIntensity) << ","
          << "\"fixtures\":[";
        for (size_t i = 0; i < li.fixtures.size(); ++i) {
            if (i) o << ",";
            const auto& f = li.fixtures[i];
            o << "{\"id\":\"" << jsonEscape(f.id) << "\","
              << "\"name\":\"" << jsonEscape(f.name) << "\","
              << "\"kind\":\"" << jsonEscape(f.kind) << "\","
              << "\"gridColumn\":" << f.gridColumn << ","
              << "\"gridRow\":" << f.gridRow << ","
              << "\"ledCount\":" << f.ledCount << ","
              << "\"addressable\":" << (f.addressable ? "true" : "false") << ","
              << "\"posX\":" << finiteOrZero(f.posX) << ","
              << "\"posY\":" << finiteOrZero(f.posY) << ","
              << "\"posZ\":" << finiteOrZero(f.posZ) << ","
              << "\"rotationYDeg\":" << finiteOrZero(f.rotationYDeg) << ","
              << "\"mountedHorizontally\":" << (f.mountedHorizontally ? "true" : "false") << ","
              << "\"dmxUniverse\":" << f.dmxUniverse << ","
              << "\"dmxStartChannel\":" << f.dmxStartChannel << ","
              << "\"dmxChannelCount\":" << f.dmxChannelCount << ","
              << "\"shape\":\"" << jsonEscape(f.shape) << "\","
              << "\"channelProfile\":\"" << jsonEscape(f.channelProfile) << "\"}";
        }
        o << "]}";

        o << ",\"lightTracks\":[";
        for (size_t i = 0; i < snap.lightTracks.size(); ++i) {
            if (i) o << ",";
            const auto& lt = snap.lightTracks[i];
            o << "{\"id\":\"" << jsonEscape(lt.id) << "\","
              << "\"name\":\"" << jsonEscape(lt.name) << "\","
              << "\"fixtureIds\":[";
            for (size_t fi = 0; fi < lt.fixtureIds.size(); ++fi) {
                if (fi) o << ",";
                o << "\"" << jsonEscape(lt.fixtureIds[fi]) << "\"";
            }
            o << "]}";
        }
        o << "]";
    }

    if (wantHealth) {
        o << ",\"health\":{"
          << "\"cpuPercent\":" << finiteOrZero(snap.cpuPercent) << ","
          << "\"rssBytes\":" << snap.rssBytes << ","
          << "\"freeBytes\":" << snap.freeBytes << ","
          << "\"underrunCount\":" << snap.underrunCount << ","
          << "\"audioCallbackCount\":" << snap.audioCallbackCount << ","
          << "\"webClientCount\":" << snap.webClientCount << ","
          << "\"processes\":[";
        if (wantHealthProcs) {
            for (size_t i = 0; i < snap.processes.size(); ++i) {
                if (i) o << ",";
                const auto& p = snap.processes[i];
                o << "{\"pid\":" << p.pid
                  << ",\"name\":\"" << jsonEscape(p.name) << "\""
                  << ",\"rssBytes\":" << p.rssBytes
                  << ",\"cpuPercent\":" << finiteOrZero(p.cpuPercent) << "}";
            }
        }
        o << "]}";
    }

    // Settings: always ship keybindings (global hotkeys). Full device/MIDI
    // lists only on settings (and mixer, for channel routing labels).
    const auto& s = snap.settings;
    o << ",\"settings\":{";
    if (wantSettingsFull) {
        o << "\"currentOutputDevice\":\"" << jsonEscape(s.currentOutputDevice) << "\","
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
          << "\"virtualMidiPortEnabled\":" << (s.virtualMidiPortEnabled ? "true" : "false") << ",";
    }
    o << "\"keybindings\":[";
    for (size_t i = 0; i < s.keybindings.size(); ++i) {
        if (i) o << ",";
        o << "{\"action\":\"" << jsonEscape(s.keybindings[i].action) << "\","
          << "\"key\":\"" << jsonEscape(s.keybindings[i].key) << "\"}";
    }
    o << "],\"recentProjects\":[";
    for (size_t i = 0; i < s.recentProjects.size(); ++i) {
        if (i) o << ",";
        o << "{\"path\":\"" << jsonEscape(s.recentProjects[i].path) << "\","
          << "\"displayName\":\"" << jsonEscape(s.recentProjects[i].displayName) << "\","
          << "\"lastOpenedIso\":\"" << jsonEscape(s.recentProjects[i].lastOpenedIso) << "\"}";
    }
    o << "],\"midiBindings\":[";
    if (isSettings || all) {
        for (size_t i = 0; i < s.midiBindings.size(); ++i) {
            if (i) o << ",";
            o << "{\"action\":\"" << jsonEscape(s.midiBindings[i].action) << "\","
              << "\"trigger\":\"" << jsonEscape(s.midiBindings[i].trigger) << "\","
              << "\"channel\":" << s.midiBindings[i].channel << ","
              << "\"number\":" << s.midiBindings[i].number << "}";
        }
    }
    o << "],\"midiLearnAction\":\"" << jsonEscape(s.midiLearnAction) << "\""
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
    } else if (std::strcmp(path, "/api/v1/transport/stop-to-start") == 0) {
        cmd = {WebCommandKind::StopToStart, 0};
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
    } else if (std::strcmp(path, "/api/v1/project/open-recent") == 0) {
        const std::string s(body, bodyLen);
        std::string pathRaw;
        if (!findJsonField(s, "\"path\"", pathRaw) || pathRaw.size() < 2
            || pathRaw.front() != '"' || pathRaw.back() != '"') {
            static const char* kMsg = "{\"error\":\"missing path\"}";
            writeHttpResponse(wsi, HTTP_STATUS_BAD_REQUEST, "application/json",
                              kMsg, std::strlen(kMsg));
            return true;
        }
        cmd = {WebCommandKind::OpenRecentProject, 0, 0.0, pathRaw.substr(1, pathRaw.size() - 2)};
    } else if (std::strcmp(path, "/api/v1/project/clear-recent") == 0) {
        cmd = {WebCommandKind::ClearRecentProjects, 0};
    } else if (std::strcmp(path, "/api/v1/project/quit-decision") == 0) {
        const int choice = parseSelectIndex(body, bodyLen);
        if (choice < 0) {
            writeHttpResponse(wsi, HTTP_STATUS_BAD_REQUEST, "application/json",
                              "{\"error\":\"missing index\"}", 28);
            return true;
        }
        cmd = {WebCommandKind::QuitDecision, choice};
    } else if (std::strcmp(path, "/api/v1/view") == 0) {
        const std::string s(body, bodyLen);
        std::string viewRaw;
        if (findJsonField(s, "\"view\"", viewRaw) && viewRaw.size() >= 2
            && viewRaw.front() == '"' && viewRaw.back() == '"') {
            const std::string viewName = viewRaw.substr(1, viewRaw.size() - 2);
            noteClientView(viewName);
            writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", "{\"ok\":true}", 11);
        } else {
            writeHttpResponse(wsi, HTTP_STATUS_BAD_REQUEST, "application/json",
                              "{\"error\":\"missing view\"}", 24);
        }
        return true;
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

void WebServer::publishAllPeaks(std::string json) {
    std::lock_guard<std::mutex> lock(allPeaksMutex);
    allPeaksJson = std::move(json);
}

int WebServer::serveAllPeaks(struct lws* wsi) {
    std::string json;
    {
        std::lock_guard<std::mutex> lock(allPeaksMutex);
        json = allPeaksJson;
    }
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.c_str(), json.size());
}

void WebServer::publishArchivePath(std::string path) {
    std::lock_guard<std::mutex> lock(archivePathMutex);
    archivePathForRaw = std::move(path);
}

// On-demand true-sample fetch for extreme-zoom waveform rendering (see
// PeakOverview.h's class comment on why the cached pyramid stays coarse
// instead of growing a hyper-fine level for this). Runs entirely on this
// (lws service) thread against a private ProjectLoader opened just for this
// request -- same "independent reader on the same file" pattern
// AudioEngine's background peak builds use -- so it never touches
// AudioEngine's own loader/StreamingEngine state.
int WebServer::serveWaveformRaw(struct lws* wsi, const char* queryArgs) {
    const std::string file = queryParam(queryArgs, "file");
    const double startSec = std::strtod(queryParam(queryArgs, "startSec").c_str(), nullptr);
    const double endSec = std::strtod(queryParam(queryArgs, "endSec").c_str(), nullptr);

    std::string archivePath;
    {
        std::lock_guard<std::mutex> lock(archivePathMutex);
        archivePath = archivePathForRaw;
    }

    auto jsonError = [wsi](int status, const char* msg) {
        return writeHttpResponse(wsi, status, "application/json", msg, std::strlen(msg));
    };

    if (file.empty() || archivePath.empty() || !(endSec > startSec))
        return jsonError(HTTP_STATUS_BAD_REQUEST, "{\"error\":\"bad request\"}");

    ProjectLoader rawLoader;
    std::string error;
    if (!rawLoader.open(archivePath, error))
        return jsonError(HTTP_STATUS_INTERNAL_SERVER_ERROR, "{\"error\":\"archive open failed\"}");

    ProjectLoader::StreamCursor cursor = rawLoader.openStream(file, error);
    if (!cursor.isValid())
        return jsonError(HTTP_STATUS_NOT_FOUND, "{\"error\":\"file not found\"}");

    auto readFn = [&](void* buf, size_t n) -> size_t { return cursor.read(buf, n); };
    WavStreamDecoder decoder;
    if (!decoder.parseHeader(readFn, error) || decoder.numChannels() <= 0 || decoder.sampleRate() <= 0.0)
        return jsonError(HTTP_STATUS_INTERNAL_SERVER_ERROR, "{\"error\":\"bad wav header\"}");

    const int numChannels = decoder.numChannels();
    const double sr = decoder.sampleRate();
    const int64_t totalFrames = decoder.totalFrames();
    const int64_t startFrame = std::clamp<int64_t>(static_cast<int64_t>(startSec * sr), 0, totalFrames);
    // Bound the window generously (a few seconds' worth) -- this endpoint is
    // for extreme zoom-in only, where the visible range is always small; a
    // caller asking for more than this is almost certainly a mistake, not a
    // legitimate zoom level.
    const int64_t maxFrames = static_cast<int64_t>(sr * 10.0);
    const int64_t endFrame = std::clamp<int64_t>(static_cast<int64_t>(endSec * sr), startFrame,
                                                 std::min(totalFrames, startFrame + maxFrames));
    const int64_t framesWanted = endFrame - startFrame;
    if (framesWanted <= 0)
        return jsonError(HTTP_STATUS_OK, "{\"sampleRate\":0,\"samples\":[]}");

    // Audio entries are stored uncompressed (MZ_NO_COMPRESSION, see
    // ProjectLoader::saveAsWithExtras), so this skip is a cheap forward read
    // through already-cached file pages, not real decompression work.
    std::vector<std::vector<float>> planar(static_cast<size_t>(numChannels));
    std::vector<float*> ptrs(static_cast<size_t>(numChannels));
    constexpr int64_t kSkipChunk = 65536;
    std::vector<std::vector<float>> skipBuf(static_cast<size_t>(numChannels));
    for (auto& c : skipBuf)
        c.resize(static_cast<size_t>(kSkipChunk));
    std::vector<float*> skipPtrs(static_cast<size_t>(numChannels));
    for (int c = 0; c < numChannels; ++c)
        skipPtrs[static_cast<size_t>(c)] = skipBuf[static_cast<size_t>(c)].data();
    int64_t toSkip = startFrame;
    while (toSkip > 0) {
        const int64_t chunk = std::min(toSkip, kSkipChunk);
        const int64_t got = decoder.decodeFrames(readFn, skipPtrs.data(), chunk);
        if (got <= 0)
            break;
        toSkip -= got;
    }

    for (auto& c : planar)
        c.resize(static_cast<size_t>(framesWanted));
    for (int c = 0; c < numChannels; ++c)
        ptrs[static_cast<size_t>(c)] = planar[static_cast<size_t>(c)].data();
    const int64_t gotFrames = decoder.decodeFrames(readFn, ptrs.data(), framesWanted);

    std::ostringstream o;
    o.setf(std::ios::fixed);
    o.precision(5);
    o << "{\"sampleRate\":" << sr << ",\"startSec\":" << (static_cast<double>(startFrame) / sr)
      << ",\"samples\":[";
    for (int64_t i = 0; i < gotFrames; ++i) {
        if (i)
            o << ",";
        float mixed = 0.0f;
        for (int c = 0; c < numChannels; ++c)
            mixed += planar[static_cast<size_t>(c)][static_cast<size_t>(i)];
        mixed /= static_cast<float>(numChannels);
        o << mixed;
    }
    o << "]}";
    const std::string json = o.str();
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

} // namespace resostage
