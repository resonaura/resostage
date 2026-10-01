/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "WebServer.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>
#include <utility>
#include <vector>

namespace resostage {

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

void WebServer::beginAudioRender() {
    std::lock_guard<std::mutex> lock(audioRenderMutex);
    audioRenderStartedAt = std::chrono::steady_clock::now();
    audioRenderStatus = {};
    audioRenderStatus.state = "rendering";
    audioRenderStatus.phase = "preparing";
    audioRenderStatus.jobId = std::to_string(++audioRenderJobSequence);
}

void WebServer::updateAudioRenderProgress(double progress, int64_t processedFrames,
                                          int64_t estimatedTotalFrames, int sampleRate,
                                          std::string phase) {
    std::lock_guard<std::mutex> lock(audioRenderMutex);
    if (audioRenderStatus.state == "rendering") {
        audioRenderStatus.progress = std::clamp(progress, 0.0, 1.0);
        audioRenderStatus.phase = std::move(phase);
        audioRenderStatus.processedFrames = processedFrames;
        audioRenderStatus.estimatedTotalFrames = estimatedTotalFrames;
        audioRenderStatus.elapsedSeconds = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - audioRenderStartedAt).count();
        if (audioRenderStatus.elapsedSeconds > 0.0 && audioRenderStatus.progress > 0.0) {
            const double estimatedTotalTime = audioRenderStatus.elapsedSeconds
                / audioRenderStatus.progress;
            audioRenderStatus.estimatedRemainingSeconds = std::max(
                0.0, estimatedTotalTime - audioRenderStatus.elapsedSeconds);
            const double renderedAudioSeconds = sampleRate > 0
                ? static_cast<double>(processedFrames) / sampleRate : 0.0;
            audioRenderStatus.processingSpeedMultiplier = renderedAudioSeconds
                / audioRenderStatus.elapsedSeconds;
        }
    }
}

void WebServer::completeAudioRender(std::vector<std::string> outputPaths,
                                    std::vector<std::string> warnings) {
    std::lock_guard<std::mutex> lock(audioRenderMutex);
    std::string first = outputPaths.empty() ? std::string{} : outputPaths.front();
    audioRenderStatus.state = "complete";
    audioRenderStatus.phase = "completed";
    audioRenderStatus.progress = 1.0;
    audioRenderStatus.outputPath = std::move(first);
    audioRenderStatus.outputPaths = std::move(outputPaths);
    audioRenderStatus.warnings = std::move(warnings);
}

void WebServer::failAudioRender(std::string error) {
    std::lock_guard<std::mutex> lock(audioRenderMutex);
    const bool cancelled = error == "Render cancelled";
    audioRenderStatus.state = cancelled ? "cancelled" : "failed";
    audioRenderStatus.phase = audioRenderStatus.state;
    audioRenderStatus.error = std::move(error);
}

bool WebServer::beginTrackImport(int songIndex, int trackIndex, std::string fileName, double startSeconds,
                                const std::string& requestId) {
    if (songIndex < 0 || trackIndex < 0 || fileName.size() > 256 || requestId.size() > 64)
        return false;
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    std::lock_guard<std::mutex> lock(importMutex);
    for (auto it = pendingTrackImports.begin(); it != pendingTrackImports.end();) {
        if (it->second.expiresAtMilliseconds <= now) it = pendingTrackImports.erase(it);
        else ++it;
    }
    if (pendingTrackImports.size() >= 64 || pendingTrackImports.contains(requestId)) return false;
    for (auto it = trackImportResults.begin(); it != trackImportResults.end();) {
        if (it->second.expiresAtMilliseconds <= now) it = trackImportResults.erase(it);
        else ++it;
    }
    if (!requestId.empty()) {
        if (trackImportResults.contains(requestId)) return false;
        if (trackImportResults.size() >= 64) {
            auto oldest = trackImportResults.end();
            for (auto it = trackImportResults.begin(); it != trackImportResults.end(); ++it)
                if (it->second.finished && (oldest == trackImportResults.end()
                    || it->second.expiresAtMilliseconds < oldest->second.expiresAtMilliseconds)) oldest = it;
            if (oldest == trackImportResults.end()) return false;
            trackImportResults.erase(oldest);
        }
        trackImportResults.emplace(requestId, TrackImportResult{false, false, {}, now + 15 * 60 * 1000});
    }
    pendingTrackImports.emplace(requestId, PendingTrackImport{
        songIndex, trackIndex, std::move(fileName),
        std::isfinite(startSeconds) ? std::max(0.0, startSeconds) : 0.0,
        now + 15 * 60 * 1000,
    });
    return true;
}

bool WebServer::takeTrackImportTarget(int& songIndex, int& trackIndex, std::string& fileName, double& startSeconds,
                                     const std::string& requestId) {
    std::lock_guard<std::mutex> lock(importMutex);
    const auto it = pendingTrackImports.find(requestId);
    if (it == pendingTrackImports.end()) return false;
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    if (it->second.expiresAtMilliseconds <= now) {
        pendingTrackImports.erase(it);
        return false;
    }
    songIndex = it->second.songIndex;
    trackIndex = it->second.trackIndex;
    fileName = std::move(it->second.fileName);
    startSeconds = it->second.startSeconds;
    pendingTrackImports.erase(it);
    if (auto result = trackImportResults.find(requestId); result != trackImportResults.end())
        result->second.expiresAtMilliseconds = now + 7LL * 60 * 60 * 1000;
    return true;
}

void WebServer::finishTrackImport(const std::string& requestId, bool success, std::string error) {
    if (requestId.empty()) return;
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    std::lock_guard<std::mutex> lock(importMutex);
    const auto it = trackImportResults.find(requestId);
    if (it == trackImportResults.end()) return;
    if (error.size() > 8192) error.resize(8192);
    it->second = TrackImportResult{true, success, std::move(error), now + 15 * 60 * 1000};
}


} // namespace resostage
