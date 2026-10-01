/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "WebServer.h"
#include "WebServerHttp.h"

#include "audio/streaming/WavStreamDecoder.h"
#include "network/UdpDiscovery.h"
#include "project/ProjectLoader.h"
#include "server/WireTypes.h"

#include <libwebsockets.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>
#include <string_view>
#include <utility>
#include <vector>

namespace resostage {
using namespace wire;
using webserver_http::queryParam;
using webserver_http::writeHttpResponse;
using webserver_http::writeJsonEnabled;
using webserver_http::writeJsonError;

namespace {

// Extension → MIME type for the on-disk SPA (index.html, assets/*.js,
// *.css, images/fonts). Served files always carry no-store so a freshly
// rebuilt bundle is never stale.
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

} // namespace

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

int WebServer::serveUiMenu(struct lws* wsi) {
    const std::string json = buildMenuModelJson();
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.c_str(), json.size());
}

int WebServer::serveDiscoveredDevices(struct lws* wsi) {
    std::vector<wire::WDiscoveredDevice> items;
    if (discoveredDevicesProvider) {
        const auto list = discoveredDevicesProvider();
        items.reserve(list.size());
        for (const auto& dev : list) {
            wire::WDiscoveredDevice d;
            d.name = dev.name;
            d.platform = dev.platform;
            d.ip = dev.ip;
            d.port = dev.port;
            d.protocolVersion = dev.protocolVersion;
            d.discoveryEnabled = dev.discoveryEnabled;
            items.push_back(std::move(d));
        }
    }
    std::string json;
    (void)glz::write_json(items, json);
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.data(), json.size());
}

int WebServer::serveDiscoveryStatus(struct lws* wsi) {
    bool enabled = true;
    if (discoveryStatusProvider) {
        enabled = discoveryStatusProvider();
    }
    return writeJsonEnabled(wsi, enabled);
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

    if (file.empty() || archivePath.empty() || !(endSec > startSec))
        return writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "bad request");

    ProjectLoader rawLoader;
    std::string error;
    if (!rawLoader.open(archivePath, error))
        return writeJsonError(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, "archive open failed");

    ProjectLoader::StreamCursor cursor = rawLoader.openStream(file, error);
    if (!cursor.isValid())
        return writeJsonError(wsi, HTTP_STATUS_NOT_FOUND, "file not found");

    auto readFn = [&](void* buf, size_t n) -> size_t { return cursor.read(buf, n); };
    WavStreamDecoder decoder;
    if (!decoder.parseHeader(readFn, error) || decoder.numChannels() <= 0 || decoder.sampleRate() <= 0.0)
        return writeJsonError(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, "bad wav header");

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
    if (framesWanted <= 0) {
        wire::WWaveformRawPayload emptyPayload{0.0, 0.0, {}};
        std::string json;
        (void)glz::write_json(emptyPayload, json);
        return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.data(), json.size());
    }

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

int WebServer::serveAudioRenderStatus(struct lws* wsi) {
    RenderStatus status;
    {
        std::lock_guard<std::mutex> lock(audioRenderMutex);
        status = audioRenderStatus;
    }
    WAudioRenderStatusPayload wire;
    wire.state = std::move(status.state);
    wire.jobId = std::move(status.jobId);
    wire.phase = std::move(status.phase);
    wire.progress = status.progress;
    wire.elapsedSeconds = status.elapsedSeconds;
    wire.estimatedRemainingSeconds = status.estimatedRemainingSeconds;
    wire.processingSpeedMultiplier = status.processingSpeedMultiplier;
    wire.processedFrames = status.processedFrames;
    wire.estimatedTotalFrames = status.estimatedTotalFrames;
    wire.outputPath = std::move(status.outputPath);
    wire.outputPaths = std::move(status.outputPaths);
    wire.warnings = std::move(status.warnings);
    wire.error = std::move(status.error);
    std::string json;
    (void)glz::write_json(wire, json);
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.c_str(), json.size());
}

int WebServer::serveTrackImportStatus(struct lws* wsi, const std::string& requestId) {
    WTrackImportStatusPayload result;
    {
        std::lock_guard<std::mutex> lock(importMutex);
        const auto it = trackImportResults.find(requestId);
        if (it == trackImportResults.end())
            return writeJsonError(wsi, HTTP_STATUS_NOT_FOUND, "Media import job is unavailable");
        result.finished = it->second.finished;
        result.success = it->second.success;
        result.error = it->second.error;
    }
    std::string json;
    (void)glz::write_json(result, json);
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.data(), json.size());
}

int WebServer::servePluginCatalog(struct lws* wsi) {
    const std::string json = pluginCatalogProvider
        ? pluginCatalogProvider()
        : "{\"scan\":{\"state\":\"unavailable\",\"progress\":0,\"format\":\"\",\"currentPlugin\":\"\",\"error\":\"Plug-in catalog is unavailable\"},\"catalog\":{\"plugins\":[],\"blacklist\":[]}}";
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.c_str(), json.size());
}

int WebServer::servePluginParameters(struct lws* wsi, const char* queryArgs) {
    const std::string slotId = queryParam(queryArgs, "slotId");
    if (slotId.empty() || slotId.size() > 128)
        return writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "invalid slotId");
    const std::string json = pluginParametersProvider
        ? pluginParametersProvider(slotId)
        : "{\"slotId\":\"\",\"parameters\":[]}";
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json",
                             json.c_str(), json.size());
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

int WebServer::serveLiveRecordingPeaks(struct lws* wsi, const char* uri, const char* queryArgs) {
    std::string path(uri);
    constexpr const char* prefix = "/api/v1/recording/";
    auto p1 = path.find(prefix);
    if (p1 == std::string::npos)
        return writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "invalid uri");
    p1 += std::strlen(prefix);
    auto p2 = path.rfind("/peaks");
    if (p2 == std::string::npos || p2 <= p1)
        return writeJsonError(wsi, HTTP_STATUS_BAD_REQUEST, "invalid uri");

    const std::string trackId = path.substr(p1, p2 - p1);

    const std::string levelStr = queryParam(queryArgs, "level");
    const std::string firstStr = queryParam(queryArgs, "first");
    const std::string countStr = queryParam(queryArgs, "count");

    size_t level = levelStr.empty() ? 0 : static_cast<size_t>(std::max(0, std::stoi(levelStr)));
    size_t first = firstStr.empty() ? 0 : static_cast<size_t>(std::max(0, std::stoi(firstStr)));
    size_t count = countStr.empty() ? 512 : static_cast<size_t>(std::clamp(std::stoi(countStr), 1, 4096));

    std::vector<PeakPair16> rawPeaks;
    if (livePeaksProvider) {
        rawPeaks = livePeaksProvider(trackId, level, first, count);
    }

    wire::WLivePeakChunkResponse resp;
    resp.trackId = trackId;
    resp.level = level;
    resp.first = first;
    resp.count = rawPeaks.size();
    resp.peaks.reserve(rawPeaks.size());
    for (const auto& p : rawPeaks) {
        resp.peaks.push_back(wire::WPeakPair{p.min, p.max});
    }

    std::string json;
    (void)glz::write_json(resp, json);
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", json.data(), json.size());
}

} // namespace resostage
