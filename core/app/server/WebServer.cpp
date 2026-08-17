#include "WebServer.h"

#include "audio/WavStreamDecoder.h"
#include "network/UdpDiscovery.h"
#include "platform/MenuModel.h"
#include "project/ProjectJson.h"
#include "project/ProjectLoader.h"
#include "server/WireTypes.h"
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
#include <fstream>
#include <optional>
#include <sstream>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace resostage {

using namespace wire;

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

static std::vector<uint8_t> buildBinaryTelemetryFrame(const WebUiState& s) {
    const uint16_t numTracks = static_cast<uint16_t>(s.tracks.size());
    const uint16_t numMeters = static_cast<uint16_t>(s.meters.size());
    const uint16_t numLights = static_cast<uint16_t>(s.lightOutput.size());
    const uint16_t numBusses = static_cast<uint16_t>(s.busses.size());

    size_t ledByteCount = 0;
    for (const auto& lo : s.lightOutput)
        ledByteCount += std::min<size_t>(lo.ledColors.size(), 512) * 3;

    // v6 header is 46 bytes: v5 header (42) + driftFactor (f32 at offset 34),
    // with numTracks/numMeters/numLights/numBusses shifted to 38-45.
    // Layout:
    //   0  u16 magic (0x5253)
    //   2  u8  version (6)
    //   3  u8  flags (bit 0 = playing)
    //   4  f32 playheadSeconds
    //   8  f32 clickPeakDbL
    //  12  f32 clickPeakDbR
    //  16  f32 clickIntervalPeakDbL
    //  20  f32 clickIntervalPeakDbR
    //  24  f32 bpm
    //  28  i16 songIndex
    //  30  f32 globalPlayheadSeconds
    //  34  f32 driftFactor  <-- NEW in v6
    //  38  u16 numTracks
    //  40  u16 numMeters
    //  42  u16 numLights
    //  44  u16 numBusses
    // = 46 bytes
    const size_t totalSize = 46
        + static_cast<size_t>(numTracks) * 8
        + static_cast<size_t>(numMeters) * 16
        + static_cast<size_t>(numTracks)          // per-track flags
        + static_cast<size_t>(numBusses)          // per-bus flags
        + static_cast<size_t>(numLights) * 4  // fixtureIdx + ledCount per row
        + ledByteCount;

    std::vector<uint8_t> buf(totalSize);
    uint8_t* p = buf.data();

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
    // Version 6: v5 + driftFactor in header.
    writeU8(6);
    writeU8(s.playing ? 1 : 0);
    writeFloat(static_cast<float>(s.playheadSeconds));
    writeFloat(s.clickPeakDbL);
    writeFloat(s.clickPeakDbR);
    writeFloat(s.clickIntervalPeakDbL);
    writeFloat(s.clickIntervalPeakDbR);
    writeFloat(static_cast<float>(s.bpm));
    writeI16(static_cast<int16_t>(s.songIndex));
    writeFloat(static_cast<float>(s.globalPlayheadSeconds));
    writeFloat(static_cast<float>(s.driftFactor)); // v6: drift-correction factor
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
    // soloActiveInGroup (this track is silenced by someone else's solo).
    for (const auto& tr : s.tracks) {
        uint8_t flags = 0;
        if (tr.mute) flags |= 1;
        if (tr.solo) flags |= 2;
        if (tr.soloActiveInGroup) flags |= 4;
        writeU8(flags);
    }
    // Per-bus mixer flags (v5).
    for (const auto& b : s.busses) {
        uint8_t flags = 0;
        if (b.mute) flags |= 1;
        if (b.solo) flags |= 2;
        if (b.soloActiveInGroup) flags |= 4;
        writeU8(flags);
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

// Extension → MIME type for the on-disk SPA (index.html, assets/*.js,
// *.css, images/fonts). Served files always carry no-store (see
// writeHttpResponse) so a freshly rebuilt bundle is never stale.
std::string mimeTypeForPath(const std::string& path) {
    const auto dot = path.rfind('.');
    const std::string ext = dot == std::string::npos ? "" : path.substr(dot + 1);
    if (ext == "html") return "text/html";
    if (ext == "js") return "application/javascript";
    if (ext == "mjs") return "application/javascript";
    if (ext == "css") return "text/css";
    if (ext == "json") return "application/json";
    if (ext == "svg") return "image/svg+xml";
    if (ext == "png") return "image/png";
    if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
    if (ext == "gif") return "image/gif";
    if (ext == "webp") return "image/webp";
    if (ext == "ico") return "image/x-icon";
    if (ext == "woff") return "font/woff";
    if (ext == "woff2") return "font/woff2";
    if (ext == "ttf") return "font/ttf";
    if (ext == "otf") return "font/otf";
    if (ext == "map") return "application/json";
    return "application/octet-stream";
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
        "/api/v1/bus/gain",   "/api/v1/bus/pan",    "/api/v1/bus/mute",   "/api/v1/bus/solo",
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
    if (std::strcmp(path, "/api/v1/bus/pan") == 0) return WebCommandKind::SetBusPan;
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
    {"/api/v1/builder/song/end", WebCommandKind::BuilderSongEnd},
    {"/api/v1/builder/track/add", WebCommandKind::BuilderTrackAdd},
    {"/api/v1/builder/track/remove", WebCommandKind::BuilderTrackRemove},
    {"/api/v1/builder/track/move", WebCommandKind::BuilderTrackMove},
    {"/api/v1/builder/track/update", WebCommandKind::BuilderTrackUpdate},
    {"/api/v1/builder/track/import-wav/begin", WebCommandKind::BuilderTrackImportWavBegin},
    {"/api/v1/builder/track/import-wav/dialog", WebCommandKind::BuilderTrackImportWavDialog},
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
    {"/api/v1/builder/cycle/update", WebCommandKind::BuilderCycleUpdate},
    {"/api/v1/lighting/config", WebCommandKind::SetLightingConfig},
    {"/api/v1/lighting/fixture/add", WebCommandKind::LightFixtureAdd},
    {"/api/v1/lighting/fixture/duplicate", WebCommandKind::LightFixtureDuplicate},
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
    {"/api/v1/settings/audio-driver", WebCommandKind::SetAudioDeviceType},
    {"/api/v1/settings/audio-control-panel", WebCommandKind::ShowAudioControlPanel},
    {"/api/v1/settings/sample-rate", WebCommandKind::SetSampleRate},
    {"/api/v1/settings/buffer-size", WebCommandKind::SetBufferSize},
    {"/api/v1/settings/midi-output", WebCommandKind::SetMidiOutput},
    {"/api/v1/settings/midi-input", WebCommandKind::SetMidiInput},
    {"/api/v1/settings/midi-virtual-port", WebCommandKind::SetMidiVirtualPort},
    {"/api/v1/settings/ui-render-engine", WebCommandKind::SetUiRenderEngine},
    {"/api/v1/settings/theme", WebCommandKind::SetTheme},
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
    {"/api/v1/action", WebCommandKind::PerformAction},
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
    uint8_t buf[LWS_PRE + 2048];
    uint8_t* start = &buf[LWS_PRE];
    uint8_t* p = start;
    uint8_t* end = &buf[sizeof(buf) - 1];

    if (lws_add_http_common_headers(wsi, static_cast<unsigned int>(status), contentType,
                                    bodyLen, &p, end))
        return 1;

    static const char kCsp[] =
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss: http: https:; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; "
        "style-src 'self' 'unsafe-inline' https:; "
        "worker-src 'self' blob:; "
        "connect-src 'self' ws: wss: http: https:; "
        "img-src 'self' data: blob: https:; "
        "font-src 'self' data: https:;";
    if (lws_add_http_header_by_name(wsi,
                                    reinterpret_cast<const unsigned char*>("content-security-policy"),
                                    reinterpret_cast<const unsigned char*>(kCsp),
                                    static_cast<int>(std::strlen(kCsp)), &p, end))
        return 1;

    // CORS for LAN tablets / other origins (local network only use-case).
    if (lws_add_http_header_by_name(wsi,
                                    reinterpret_cast<const unsigned char*>("access-control-allow-origin"),
                                    reinterpret_cast<const unsigned char*>("*"), 1, &p, end))
        return 1;

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
            server->noteViewOpened(WebServer::ViewSlot::Player);
            pss->periodUs = kTelemetryPeriodUs;
            pss->requestedPeriodUs = 0;
            pss->reportedPeriodUs = 0;
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
            // Clients may send transport shortcuts or {"view":"mixer"} to
            // scope the outbound telemetry to the active SPA tab.
            if (server == nullptr || in == nullptr || len == 0)
                return 0;
            const std::string msg(static_cast<const char*>(in), len);
            std::string viewRaw;
            if (findJsonField(msg, "\"view\"", viewRaw)
                && viewRaw.size() >= 2 && viewRaw.front() == '"' && viewRaw.back() == '"') {
                const std::string viewName = viewRaw.substr(1, viewRaw.size() - 2);
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
            std::string hzRaw;
            if (findJsonField(msg, "\"telemetryHz\"", hzRaw)) {
                // The SPA sends this whenever its frame budget changes. Clamped
                // to the server's own range: a client cannot ask to be served
                // faster than the target, nor slow itself below the floor that
                // keeps the transport readable.
                const int hz = std::atoi(hzRaw.c_str());
                if (pss != nullptr && hz > 0) {
                    const int clamped =
                        std::clamp(hz, WebServer::kTelemetryMinHz, WebServer::kTelemetryHz);
                    pss->requestedPeriodUs = 1'000'000 / clamped;
                    if (server != nullptr)
                        server->setTargetTelemetryHz(clamped);
                }
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
    auto binary = std::make_shared<const std::vector<uint8_t>>(buildBinaryTelemetryFrame(next));

    // High-speed UDP telemetry for embedded (Electron) mode: send binary telemetry frame
    // over loopback to 127.0.0.1:kUdpTelemetryPort. Decimated to match targetTelemetryHz_.
    const int targetHz = targetTelemetryHz_.load(std::memory_order_relaxed);
    const double targetPeriodSec = 1.0 / (targetHz > 0 ? targetHz : 60);
    const double nowSec = juce::Time::getMillisecondCounterHiRes() * 0.001;

    if (nowSec - lastUdpSendTimeSec_ >= targetPeriodSec - 0.002) {
        lastUdpSendTimeSec_ = nowSec;
        if (udpSocket_ != nullptr && binary != nullptr && !binary->empty()) {
            udpSocket_->write("127.0.0.1", kUdpTelemetryPort, binary->data(), static_cast<int>(binary->size()));
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
    const WebCommandKind kind = cmd.kind;
    commands.try_enqueue(std::move(cmd));
    // Transport / setlist: wake the message thread immediately.
    if (kind == WebCommandKind::Play ||
        kind == WebCommandKind::Stop ||
        kind == WebCommandKind::StopToStart ||
        kind == WebCommandKind::Next ||
        kind == WebCommandKind::Prev ||
        kind == WebCommandKind::SelectSong ||
        kind == WebCommandKind::Seek) {
        if (urgentCommandHook)
            urgentCommandHook();
    }
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
    const bool isLight = all || std::strcmp(view, "light") == 0;

    // Songs: player + editor (timeline/hotkeys). Editor needs full detail.
    // Light also needs songs -- the rig editor resolves the active song's bpm
    // and light cues for its preview (see ProjectLightingPanel.tsx).
    const bool wantSongs = all || isPlayer || isEditor || isMixer || isLight;
    const bool wantSongsFull = all || isEditor; // events, full region fades, clickSends
    const bool wantMeters = all || isPlayer || isMixer;
    const bool wantTracks = all || isPlayer || isMixer || isEditor;
    const bool wantBusses = all || isPlayer || isMixer || isEditor;
    const bool wantClick = all || isPlayer || isMixer;
    const bool wantHealth = all || isPlayer || isSettings;
    const bool wantHealthProcs = all || isSettings;
    const bool wantSettingsFull = true;
    // Explicit-request only, never part of "all": the diagram is a modal the
    // user opens on purpose, and the graph has no business riding along in
    // every 30 Hz frame or in a plain /api/v1/state call.
    const bool wantMixGraph =
        view != nullptr && std::strcmp(view, "mixgraph") == 0;
    (void)isSettings; // still used for midiBindings detail below

    WEngineTelemetryPayload wire;

    wire.projectName = snap.projectName;
    wire.songName = snap.songName;
    wire.playheadSeconds = finiteOrZero(snap.playheadSeconds);
    wire.globalPlayheadSeconds = finiteOrZero(snap.globalPlayheadSeconds);
    wire.globalBeatsElapsed = finiteOrZero(snap.globalBeatsElapsed);
    wire.sampleRate = finiteOrZero(snap.sampleRate);
    wire.drift = finiteOrZero(snap.driftFactor);
    wire.bpm = finiteOrZero(snap.bpm);
    wire.playing = snap.playing;
    wire.hardwareAlarm = snap.hardwareAlarm;
    wire.songIndex = snap.songIndex;
    wire.songCount = snap.songCount;
    wire.statusMessage = snap.statusMessage;
    wire.busy = snap.busy;
    wire.quitConfirmPending = snap.quitConfirmPending;
    wire.openConfirmPending = snap.openConfirmPending;
    wire.saveAsPending = snap.saveAsPending;
    wire.uiTab = snap.uiTab;
    wire.uiTabSeq = static_cast<uint32_t>(snap.uiTabSeq);
    wire.canUndo = snap.canUndo;
    wire.canRedo = snap.canRedo;
    wire.undoLabel = snap.undoLabel;
    wire.redoLabel = snap.redoLabel;
    wire.lastAction = snap.lastAction;
    wire.lastActionNonce = static_cast<uint64_t>(std::max(0, snap.lastActionNonce));
    wire.telemetryHz = effectiveTelemetryHz();

    if (wantClick) {
        WClickTelemetry wc;
        wc.enabled = snap.click;
        wc.name = snap.clickName.empty() ? "Click" : snap.clickName;
        wc.gainDb = finiteOrZero(snap.clickGainDb);
        wc.pan = finiteOrZero(snap.clickPan);
        wc.channels = snap.clickMono ? 1 : 2;
        wc.solo = snap.clickSolo;
        wc.soloGroup = snap.clickSoloGroup;
        wc.soloActiveInGroup = snap.clickSoloActiveInGroup;
        // Mirrors the on-disk SourceOutput exactly, including ext-out and
        // bus destinations -- the click is routed like any other source.
        wc.output.type = snap.clickOutputType;
        if (!snap.clickOutputTarget.empty())
            wc.output.target = snap.clickOutputTarget;
        wc.output.sends.reserve(snap.clickSends.size());
        for (const auto& cs : snap.clickSends) {
            WSendConfig wS;
            wS.bus = cs.busId;
            wS.level = finiteOrZero(cs.level);
            wS.enabled = cs.enabled;
            wc.output.sends.push_back(std::move(wS));
        }
        wire.click = std::move(wc);
        wire.clickPeakDb = finiteOrDbFloor(snap.clickPeakDb);
        wire.clickPeakDbL = finiteOrDbFloor(snap.clickPeakDbL);
        wire.clickPeakDbR = finiteOrDbFloor(snap.clickPeakDbR);
        wire.clickIntervalPeakDbL = finiteOrDbFloor(snap.clickIntervalPeakDbL);
        wire.clickIntervalPeakDbR = finiteOrDbFloor(snap.clickIntervalPeakDbR);
        wire.streamBufferMinSec = finiteOrZero(snap.streamBufferMinSec);
        wire.streamBufferAvgSec = finiteOrZero(snap.streamBufferAvgSec);
        wire.streamResidentTracks = snap.streamResidentTracks;
        wire.streamStreamingTracks = snap.streamStreamingTracks;
        wire.streamBufferUrgent = snap.streamBufferUrgent;
        wire.streamResidentMiB = finiteOrZero(snap.streamResidentMiB);
        wire.streamRingFraction = finiteOrZero(snap.streamRingFraction);
        wire.streamIoPressure = snap.streamIoPressure;
    }

    if (wantSongs) {
        std::vector<WSongTelemetry> songVec;
        songVec.reserve(snap.songs.size());
        for (const auto& song : snap.songs) {
            WSongTelemetry wSong;
            wSong.name = song.name;
            wSong.bpm = finiteOrZero(song.bpm);
            wSong.mode = song.autoplay ? "auto" : "wait";
            wSong.tsNum = song.tsNum;
            wSong.tsDen = song.tsDen;
            wSong.endSeconds = finiteOrZero(song.endSeconds);
            wSong.click = song.click;
            wSong.clickBusId = song.clickBusId;
            wSong.clickGainDb = finiteOrZero(song.clickGainDb);

            if (wantSongsFull) {
                wSong.clickSends.reserve(song.clickSends.size());
                for (const auto& cs : song.clickSends) {
                    WClickSendTelemetry wcs;
                    wcs.busId = cs.busId;
                    wcs.level = finiteOrZero(cs.level);
                    wcs.enabled = cs.enabled;
                    wSong.clickSends.push_back(std::move(wcs));
                }
            }

            wSong.regions.reserve(song.regions.size());
            for (const auto& r : song.regions) {
                WRegionTelemetry wReg;
                wReg.id = r.id;
                wReg.trackId = r.trackId;
                wReg.startSeconds = finiteOrZero(r.startSeconds);
                wReg.durationSeconds = finiteOrZero(r.durationSeconds);
                wReg.gainDb = finiteOrZero(r.gainDb);
                wReg.source.file = r.source.file;
                wReg.source.offsetSeconds = finiteOrZero(r.source.offsetSeconds);

                if (wantSongsFull || isPlayer) {
                    WRegionFade wFade;
                    wFade.inSeconds = finiteOrZero(r.fade.inSeconds);
                    wFade.outSeconds = finiteOrZero(r.fade.outSeconds);
                    wFade.inCurve = finiteOrZero(r.fade.inCurve);
                    wFade.outCurve = finiteOrZero(r.fade.outCurve);
                    wReg.fade = wFade;
                    WRegionLoop wLoop;
                    wLoop.enabled = r.loop.enabled;
                    wLoop.lengthSeconds = finiteOrZero(r.loop.lengthSeconds);
                    wReg.loop = wLoop;
                    WRegionPlaybackWire wPlay;
                    wPlay.speed = r.playback.speed;
                    wPlay.semitones = finiteOrZero(r.playback.semitones);
                    wPlay.reverse = r.playback.reverse;
                    wReg.playback = wPlay;
                }
                wSong.regions.push_back(std::move(wReg));
            }

            if (wantSongsFull) {
                wSong.events.reserve(song.events.size());
                for (const auto& e : song.events) {
                    WEventTelemetry wEv;
                    wEv.id = e.id;
                    wEv.type = e.type;
                    wEv.timeSeconds = finiteOrZero(e.timeSeconds);
                    wEv.triggerOnLoad = e.triggerOnLoad;
                    wEv.latencyMs = finiteOrZero(e.latencyMs);
                    wEv.midiChannel = e.midiChannel;
                    wEv.midiProgram = e.midiProgram;
                    wEv.midiCC = e.midiCC;
                    wEv.midiCCValue = e.midiCCValue;
                    wEv.midiNote = e.midiNote;
                    wEv.midiVelocity = e.midiVelocity;
                    wEv.httpUrl = e.httpUrl;
                    wSong.events.push_back(std::move(wEv));
                }
            }

            wSong.sections.reserve(song.sections.size());
            for (const auto& sec : song.sections) {
                WSectionTelemetry wSec;
                wSec.id = sec.id;
                wSec.name = sec.name;
                wSec.startSeconds = finiteOrZero(sec.startSeconds);
                wSec.colorIndex = sec.colorIndex;
                wSong.sections.push_back(std::move(wSec));
            }

            wSong.lightCues.reserve(song.lightCues.size());
            for (const auto& lc : song.lightCues) {
                WLightCueTelemetry wLc;
                wLc.id = lc.id;
                wLc.trackId = lc.trackId;
                wLc.startSeconds = finiteOrZero(lc.startSeconds);
                wLc.durationSeconds = finiteOrZero(lc.durationSeconds);
                wLc.color.r = static_cast<uint8_t>(lc.color.r);
                wLc.color.g = static_cast<uint8_t>(lc.color.g);
                wLc.color.b = static_cast<uint8_t>(lc.color.b);
                wLc.intensity = finiteOrZero(lc.intensity);
                wLc.fade.inSeconds = finiteOrZero(lc.fade.inSeconds);
                wLc.fade.outSeconds = finiteOrZero(lc.fade.outSeconds);
                wLc.label = lc.label;
                wLc.effect.type = lc.effect.type;
                wLc.effect.sourceType = lc.effect.sourceType;
                wLc.effect.sourceId = lc.effect.sourceId;
                wLc.effect.intensity = finiteOrZero(lc.effect.intensity);
                wLc.effect.tempoSync = lc.effect.tempoSync;
                wLc.effect.tempoSubdivision = lc.effect.tempoSubdivision;
                wLc.effect.rateHz = finiteOrZero(lc.effect.rateHz);
                wLc.gradient.preset = lc.gradient.preset;
                wLc.gradient.colors = lc.gradient.colors;
                wLc.blendMode = lc.blendMode;
                wSong.lightCues.push_back(std::move(wLc));
            }

            songVec.push_back(std::move(wSong));
        }
        wire.songs = std::move(songVec);

        WCycleTelemetry cyc;
        cyc.active = snap.cycle.active;
        cyc.skip = snap.cycle.skip;
        cyc.startSeconds = finiteOrZero(snap.cycle.startSeconds);
        cyc.endSeconds = finiteOrZero(snap.cycle.endSeconds);
        cyc.songIndex = snap.cycle.songIndex;
        wire.cycle = cyc;
    }

    if (wantMeters) {
        std::vector<WMeterTelemetry> meterVec;
        meterVec.reserve(snap.meters.size());
        for (const auto& m : snap.meters) {
            WMeterTelemetry wM;
            wM.id = m.id;
            wM.peakDb = finiteOrDbFloor(m.peakDb);
            wM.intervalPeakDbL = finiteOrDbFloor(m.intervalPeakDbL);
            wM.intervalPeakDbR = finiteOrDbFloor(m.intervalPeakDbR);
            wM.peakDbL = finiteOrDbFloor(m.peakDbL);
            wM.peakDbR = finiteOrDbFloor(m.peakDbR);
            wM.shortTermLufs = finiteOrZero(m.shortTermLufs);
            meterVec.push_back(std::move(wM));
        }
        wire.meters = std::move(meterVec);
    }

    if (wantTracks) {
        std::vector<WTrackTelemetry> trkVec;
        trkVec.reserve(snap.tracks.size());
        for (const auto& t : snap.tracks) {
            WTrackTelemetry wT;
            wT.id = t.id;
            wT.name = t.name;
            wT.channels = t.channels;
            wT.gainDb = finiteOrZero(t.gainDb);
            wT.pan = finiteOrZero(t.pan);
            wT.mute = t.mute;
            wT.solo = t.solo;
            wT.soloGroup = t.soloGroup;
            wT.soloActiveInGroup = t.soloActiveInGroup;
            wT.output.type = t.output.type;
            wT.output.target = t.output.target;
            wT.output.sends.reserve(t.output.sends.size());
            for (const auto& s : t.output.sends) {
                WSendConfig wS;
                wS.bus = s.bus;
                wS.level = s.level;
                wS.preFader = s.preFader;
                wS.enabled = s.enabled;
                wT.output.sends.push_back(std::move(wS));
            }
            wT.peakDb = finiteOrDbFloor(t.peakDb);
            wT.peakDbL = finiteOrDbFloor(t.peakDbL);
            wT.peakDbR = finiteOrDbFloor(t.peakDbR);
            trkVec.push_back(std::move(wT));
        }
        wire.tracks = std::move(trkVec);
    }

    if (wantBusses) {
        std::vector<WBusTelemetry> busVec;
        busVec.reserve(snap.busses.size());
        for (const auto& b : snap.busses) {
            WBusTelemetry wB;
            wB.id = b.id;
            wB.name = b.name;
            wB.gainDb = finiteOrZero(b.gainDb);
            wB.pan = finiteOrZero(b.pan);
            wB.mute = b.mute;
            wB.solo = b.solo;
            wB.soloGroup = b.soloGroup;
            wB.soloActiveInGroup = b.soloActiveInGroup;
            wB.isDirectOut = b.isDirectOut;
            wB.unavailable = b.unavailable;
            wB.isAux = b.isAux;
            wB.startChannel = b.startChannel;
            wB.channels = b.channels;
            wB.peakDb = finiteOrDbFloor(b.peakDb);
            wB.peakDbL = finiteOrDbFloor(b.peakDbL);
            wB.peakDbR = finiteOrDbFloor(b.peakDbR);
            busVec.push_back(std::move(wB));
        }
        wire.busses = std::move(busVec);
    }

    const auto& li = snap.lighting;
    wire.lighting.enabled = li.enabled;
    wire.lighting.kind = li.kind;
    wire.lighting.resolight.columns = li.resolight.columns;
    wire.lighting.resolight.rows = li.resolight.rows;
    wire.lighting.idle.behavior = li.idle.behavior;
    wire.lighting.idle.color.r = static_cast<uint8_t>(li.idle.color.r);
    wire.lighting.idle.color.g = static_cast<uint8_t>(li.idle.color.g);
    wire.lighting.idle.color.b = static_cast<uint8_t>(li.idle.color.b);
    wire.lighting.idle.intensity = finiteOrZero(li.idle.intensity);
    wire.lighting.idle.effect.type = li.idle.effect.type;
    wire.lighting.idle.effect.rateHz = finiteOrZero(li.idle.effect.rateHz);
    wire.lighting.idle.gradient.preset = li.idle.gradient.preset;
    wire.lighting.idle.gradient.colors = li.idle.gradient.colors;
    wire.lighting.defaultRefreshRateHz = finiteOrZero(li.defaultRefreshRateHz);
    if (!li.artNetTargetHost.empty())
        wire.lighting.artNetTargetHost = li.artNetTargetHost;

    wire.lighting.fixtures.reserve(li.fixtures.size());
    for (const auto& f : li.fixtures) {
        WFixtureTelemetry wF;
        wF.id = f.id;
        wF.name = f.name;
        wF.kind = f.kind;
        wF.grid.column = f.grid.column;
        wF.grid.row = f.grid.row;
        wF.ledCount = f.ledCount;
        wF.addressable = f.addressable;
        wF.position.x = finiteOrZero(f.position.x);
        wF.position.y = finiteOrZero(f.position.y);
        wF.position.z = finiteOrZero(f.position.z);
        wF.rotation.y = finiteOrZero(f.rotation.y);
        wF.mountedHorizontally = f.mountedHorizontally;
        wF.dmx.universe = f.dmx.universe;
        wF.dmx.startChannel = f.dmx.startChannel;
        wF.dmx.channelCount = f.dmx.channelCount;
        wF.shape = f.shape;
        wF.matrixColumns = f.matrixColumns;
        wF.channelProfile = f.channelProfile;
        wF.tiltDegrees = finiteOrZero(f.tiltDegrees);
        wF.refreshRateHz = finiteOrZero(f.refreshRateHz);
        wF.networkHost = f.networkHost;
        wF.hwConfigured = f.hwConfigured;
        wF.hwConnected = f.hwConnected;
        wF.hwRssiDbm = f.hwRssiDbm;
        wF.hwChipType = f.hwChipType;
        wire.lighting.fixtures.push_back(std::move(wF));
    }

    wire.lighting.discoveredBoards.reserve(li.discoveredBoards.size());
    for (const auto& b : li.discoveredBoards) {
        WDiscoveredBoardTelemetry wB;
        wB.mac = b.mac;
        wB.ip = b.ip;
        wB.name = b.name;
        wB.chipType = b.chipType;
        wB.lastSeenSecondsAgo = finiteOrZero(b.lastSeenSecondsAgo);
        wire.lighting.discoveredBoards.push_back(std::move(wB));
    }

    wire.lighting.tracks.reserve(li.tracks.size());
    for (const auto& lt : li.tracks) {
        WLightTrackTelemetry wLt;
        wLt.id = lt.id;
        wLt.name = lt.name;
        wLt.fixtureIds = lt.fixtureIds;
        wire.lighting.tracks.push_back(std::move(wLt));
    }

    if (wantMixGraph) {
        WMixGraphTelemetry wG;
        wG.strips.reserve(snap.mixGraph.strips.size());
        for (const auto& st : snap.mixGraph.strips) {
            WMixStripTelemetry wS;
            wS.id = st.id;
            wS.name = st.name;
            wS.kind = st.kind;
            wS.soloGroup = st.soloGroup;
            wS.channels = st.channels;
            wS.gainDb = finiteOrZero(st.gainDb);
            wS.pan = finiteOrZero(st.pan);
            wS.mute = st.mute;
            wS.solo = st.solo;
            wS.audible = st.audible;
            wS.physicalChannel = st.physicalChannel;
            wS.peakDb = finiteOrDbFloor(st.peakDb);
            wG.strips.push_back(std::move(wS));
        }
        wG.edges.reserve(snap.mixGraph.edges.size());
        for (const auto& e : snap.mixGraph.edges) {
            WMixEdgeTelemetry wE;
            wE.from = e.from;
            wE.to = e.to;
            wE.level = finiteOrZero(e.level);
            wE.preFader = e.preFader;
            wE.active = e.active;
            wE.sourceChannel = e.sourceChannel;
            wG.edges.push_back(std::move(wE));
        }
        wire.mixGraph = std::move(wG);
    }

    if (wantHealth) {
        WHealthTelemetry wH;
        wH.cpuPercent = finiteOrZero(snap.cpuPercent);
        wH.rssBytes = snap.rssBytes;
        wH.freeBytes = snap.freeBytes;
        wH.systemTotalBytes = snap.systemTotalBytes;
        wH.cpuCoreCount = snap.cpuCoreCount;
        wH.underrunCount = snap.underrunCount;
        wH.audioCallbackCount = snap.audioCallbackCount;
        wH.silentBlockCount = snap.silentBlockCount;
        wH.pitchBlockCount = snap.pitchBlockCount;
        wH.streamStarveCount = snap.streamStarveCount;
        wH.callbackWorstRatio = finiteOrZero(snap.callbackWorstRatio);
        wH.callbackWorstMs = finiteOrZero(snap.callbackWorstMs);
        wH.callbackWorstCpuShare = finiteOrZero(snap.callbackWorstCpuShare);
        wH.callbackComputeStalls = snap.callbackComputeStalls;
        wH.callbackPreemptedStalls = snap.callbackPreemptedStalls;
        wH.callbackOverruns = snap.callbackOverruns;
        wH.outputLatencySamples = snap.outputLatencySamples;
        wH.outputLatencyMs = finiteOrZero(snap.outputLatencyMs);
        wH.hostTimeSkewMs = finiteOrZero(snap.hostTimeSkewMs);
        wH.thermalState = snap.thermalState;
        wH.diskReadBytesPerSec = finiteOrZero(snap.diskReadBytesPerSec);
        wH.diskWriteBytesPerSec = finiteOrZero(snap.diskWriteBytesPerSec);
        wH.webClientCount = static_cast<uint32_t>(std::max(0, snap.webClientCount));
        if (wantHealthProcs) {
            wH.processes.reserve(snap.processes.size());
            for (const auto& p : snap.processes) {
                WProcessTelemetry wP;
                wP.pid = p.pid;
                wP.name = p.name;
                wP.rssBytes = p.rssBytes;
                wP.cpuPercent = finiteOrZero(p.cpuPercent);
                wH.processes.push_back(std::move(wP));
            }
        }
        wire.health = std::move(wH);
    }

    const auto& s = snap.settings;
    if (wantSettingsFull) {
        wire.settings.currentOutputDevice = s.currentOutputDevice;
        wire.settings.outputDevices = s.outputDevices;
        wire.settings.audioDrivers = s.audioDrivers;
        wire.settings.currentAudioDriver = s.currentAudioDriver;
        wire.settings.hasControlPanel = s.hasControlPanel;
        wire.settings.sampleRate = finiteOrZero(s.sampleRate);

        std::vector<double> srVec;
        srVec.reserve(s.availableSampleRates.size());
        for (double sr : s.availableSampleRates)
            srVec.push_back(finiteOrZero(sr));
        wire.settings.availableSampleRates = std::move(srVec);

        wire.settings.bufferSize = s.bufferSize;
        wire.settings.availableBufferSizes = s.availableBufferSizes;
        wire.settings.outputChannelNames = s.outputChannelNames;

        std::vector<bool> chVec;
        chVec.reserve(s.activeOutputChannels.size());
        for (bool active : s.activeOutputChannels)
            chVec.push_back(active);
        wire.settings.activeOutputChannels = std::move(chVec);

        wire.settings.midiOutputs = s.midiOutputs;
        wire.settings.midiInputs = s.midiInputs;
        wire.settings.virtualMidiPortEnabled = s.virtualMidiPortEnabled;
        wire.settings.uiRenderEngine = s.uiRenderEngine;
        wire.settings.theme = s.theme;
    }

    wire.settings.keybindings.reserve(s.keybindings.size());
    for (const auto& kb : s.keybindings) {
        WKeybindingTelemetry wKb;
        wKb.action = kb.action;
        wKb.key = kb.key;
        wire.settings.keybindings.push_back(std::move(wKb));
    }

    wire.settings.recentProjects.reserve(s.recentProjects.size());
    for (const auto& rp : s.recentProjects) {
        WRecentProjectTelemetry wRp;
        wRp.path = rp.path;
        wRp.displayName = rp.displayName;
        wRp.lastOpenedIso = rp.lastOpenedIso;
        wire.settings.recentProjects.push_back(std::move(wRp));
    }

    if (isSettings || all) {
        wire.settings.midiBindings.reserve(s.midiBindings.size());
        for (const auto& mb : s.midiBindings) {
            WMidiBindingTelemetry wMb;
            wMb.action = mb.action;
            wMb.trigger = mb.trigger;
            wMb.channel = mb.channel;
            wMb.number = mb.number;
            wire.settings.midiBindings.push_back(std::move(wMb));
        }
    }

    wire.settings.midiLearnAction = s.midiLearnAction;

    std::string json;
    (void)glz::write_json(wire, json);
    return json;
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
    } else if (std::strcmp(path, "/api/v1/project/open-decision") == 0) {
        const int choice = parseSelectIndex(body, bodyLen);
        if (choice < 0) {
            writeHttpResponse(wsi, HTTP_STATUS_BAD_REQUEST, "application/json",
                              "{\"error\":\"missing index\"}", 28);
            return true;
        }
        cmd = {WebCommandKind::OpenDecision, choice};
    } else if (std::strcmp(path, "/api/v1/settings/ui-render-engine") == 0) {
        const std::string s(body, bodyLen);
        cmd = {WebCommandKind::SetUiRenderEngine, 0, 0.0, s};
        writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", "{\"ok\":true}", 11);
        return true;
    } else if (std::strcmp(path, "/api/v1/settings/telemetry-hz") == 0) {
        const std::string s(body, bodyLen);
        std::string hzRaw;
        if (findJsonField(s, "\"telemetryHz\"", hzRaw)) {
            const int hz = std::atoi(hzRaw.c_str());
            if (hz > 0)
                setTargetTelemetryHz(hz);
        }
        writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", "{\"ok\":true}", 11);
        return true;
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
    } else if (std::strcmp(path, "/api/v1/remote/discovery") == 0) {
        bool enabled = true;
        const std::string bodyStr(body, bodyLen);
        if (bodyStr.find("false") != std::string::npos) {
            enabled = false;
        }
        if (discoveryToggleHandler) {
            discoveryToggleHandler(enabled);
        }
        const std::string json = "{\"enabled\":" + std::string(enabled ? "true" : "false") + "}";
        writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.c_str(), json.size());
        return true;
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
    // Serve the SPA from disk (bundle Contents/Resources/web, or ui/dist in
    // dev), reading the packaged folder instead of a generated header. "/"
    // resolves to index.html; unknown paths fall back to index.html too so a
    // refresh on a deep link still lands in the SPA.
    std::string_view p(path != nullptr && path[0] != '\0' ? path : "/");

    // Strip query parameters (?...) or URL fragments (#...) so filesystem
    // reads for "assets/index.css?v=1" target "assets/index.css".
    const auto qpos = p.find_first_of("?#");
    if (qpos != std::string_view::npos)
        p = p.substr(0, qpos);

    if (p.empty() || p == "/")
        p = "index.html";
    if (p.front() == '/')
        p.remove_prefix(1);

    // Refuse anything that tries to escape the web root.
    if (p.find("..") != std::string_view::npos)
        return writeHttpResponse(wsi, HTTP_STATUS_NOT_FOUND, "text/plain", "not found", 9);

    const auto tryServe = [&](const std::string& root) -> int {
        std::string filePath = root;
        if (!filePath.empty() && filePath.back() != '/')
            filePath += '/';
        filePath += std::string(p);
        std::ifstream in(filePath, std::ios::binary);
        if (!in)
            return 0;
        std::ostringstream data;
        data << in.rdbuf();
        const std::string body = data.str();
        const std::string mime = mimeTypeForPath(filePath);
        return writeHttpResponse(wsi, HTTP_STATUS_OK, mime.c_str(), body.c_str(), body.size());
    };

    for (const auto& root : webRoots_) {
        const int r = tryServe(root);
        if (r != 0)
            return r;
    }

    // SPA deep-link fallback: serve index.html for page navigation requests, but
    // NEVER serve index.html (text/html) for missing static assets (.css, .js, .png, etc.),
    // which causes the browser to reject stylesheets ("Refused to apply style...").
    const auto dotPos = p.rfind('.');
    const bool isAssetRequest = (dotPos != std::string_view::npos) && (p.find('/', dotPos) == std::string_view::npos);
    const std::string ext = isAssetRequest ? std::string(p.substr(dotPos + 1)) : "";
    const bool isPageNavigation = !isAssetRequest || ext == "html" || ext == "htm";

    if (isPageNavigation && p != "index.html") {
        const auto tryIndex = [&](const std::string& root) -> int {
            std::string filePath = root;
            if (!filePath.empty() && filePath.back() != '/')
                filePath += '/';
            filePath += "index.html";
            std::ifstream in(filePath, std::ios::binary);
            if (!in)
                return 0;
            std::ostringstream data;
            data << in.rdbuf();
            const std::string body = data.str();
            return writeHttpResponse(wsi, HTTP_STATUS_OK, "text/html", body.c_str(), body.size());
        };
        for (const auto& root : webRoots_) {
            const int r = tryIndex(root);
            if (r != 0)
                return r;
        }
    }
    return writeHttpResponse(wsi, HTTP_STATUS_NOT_FOUND, "text/plain", "not found", 9);
}

void WebServer::addWebRoot(const std::string& root) {
    if (root.empty())
        return;
    std::error_code ec;
    if (std::filesystem::exists(root, ec) && std::filesystem::is_directory(root, ec)) {
        if (std::find(webRoots_.begin(), webRoots_.end(), root) == webRoots_.end()) {
            webRoots_.push_back(root);
        }
    }
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

// MenuModel → JSON for the Electron shell (electron/main.mts builds the real
// NSMenu). Not drawn by Core. Keybindings + recent projects ride along for
// dynamic accelerators and File > Open Recent.
std::string WebServer::buildMenuModelJson() const {
    WMenuModelPayload wire;
    const auto& menus = menuModel();
    wire.menus.reserve(menus.size());

    for (const auto& menu : menus) {
        WMenu wMenu;
        wMenu.title = menu.title;
        wMenu.items.reserve(menu.items.size());

        for (const auto& item : menu.items) {
            WMenuItem wItem;
            switch (item.kind) {
            case MenuItemModel::Kind::Separator:
                wItem.separator = true;
                break;
            case MenuItemModel::Kind::OpenRecent:
                wItem.kind = "open-recent";
                wItem.title = item.title;
                break;
            case MenuItemModel::Kind::Item:
                wItem.title = item.title;
                if (!item.role.empty()) {
                    wItem.role = item.role;
                } else {
                    wItem.actionId = item.actionId;
                    if (item.dynamicKey)
                        wItem.dynamicKey = true;
                    else if (!item.key.empty())
                        wItem.key = item.key;
                }
                break;
            }
            wMenu.items.push_back(std::move(wItem));
        }
        wire.menus.push_back(std::move(wMenu));
    }

    const auto& tabs = touchBarTabs();
    wire.touchbar.reserve(tabs.size());
    for (const auto& tab : tabs) {
        WTouchBarTab wTab;
        wTab.id = tab.id;
        wTab.label = tab.label;
        wire.touchbar.push_back(std::move(wTab));
    }

    WebUiState snap;
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        snap = state;
    }

    for (const auto& kb : snap.settings.keybindings) {
        wire.keybindings[kb.action] = kb.key;
    }

    wire.recentProjects.reserve(snap.settings.recentProjects.size());
    for (const auto& rp : snap.settings.recentProjects) {
        WRecentProjectTelemetry wRp;
        wRp.path = rp.path;
        wRp.displayName = rp.displayName;
        wRp.lastOpenedIso = rp.lastOpenedIso;
        wire.recentProjects.push_back(std::move(wRp));
    }

    std::string json;
    (void)glz::write_json(wire, json);
    return json;
}

int WebServer::serveUiMenu(struct lws* wsi) {
    const std::string json = buildMenuModelJson();
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.c_str(), json.size());
}

int WebServer::serveDiscoveredDevices(struct lws* wsi) {
    juce::var arr;
    if (discoveredDevicesProvider) {
        const auto list = discoveredDevicesProvider();
        for (const auto& dev : list) {
            juce::var item(new juce::DynamicObject());
            item.getDynamicObject()->setProperty("name", juce::String(dev.name));
            item.getDynamicObject()->setProperty("platform", juce::String(dev.platform));
            item.getDynamicObject()->setProperty("ip", juce::String(dev.ip));
            item.getDynamicObject()->setProperty("port", static_cast<int>(dev.port));
            item.getDynamicObject()->setProperty("protocolVersion", juce::String(dev.protocolVersion));
            item.getDynamicObject()->setProperty("discoveryEnabled", dev.discoveryEnabled);
            arr.append(item);
        }
    }
    const juce::String json = juce::JSON::toString(arr, true);
    auto raw = json.toRawUTF8();
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", raw, std::strlen(raw));
}

int WebServer::serveDiscoveryStatus(struct lws* wsi) {
    bool enabled = true;
    if (discoveryStatusProvider) {
        enabled = discoveryStatusProvider();
    }
    const std::string json = "{\"enabled\":" + std::string(enabled ? "true" : "false") + "}";
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

    WWaveformRawPayload wire;
    wire.sampleRate = sr;
    wire.startSec = static_cast<double>(startFrame) / sr;
    wire.samples.reserve(static_cast<size_t>(gotFrames));
    for (int64_t i = 0; i < gotFrames; ++i) {
        float mixed = 0.0f;
        for (int c = 0; c < numChannels; ++c)
            mixed += planar[static_cast<size_t>(c)][static_cast<size_t>(i)];
        mixed /= static_cast<float>(numChannels);
        wire.samples.push_back(mixed);
    }
    std::string json;
    (void)glz::write_json(wire, json);
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
    WExportStatusPayload wire;
    wire.ready = ready;
    wire.fileName = std::move(name);
    std::string json;
    (void)glz::write_json(wire, json);
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
