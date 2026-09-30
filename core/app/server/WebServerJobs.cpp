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

void WebServer::beginTrackImport(int songIndex, int trackIndex, std::string fileName, double startSeconds) {
    std::lock_guard<std::mutex> lock(importMutex);
    pendingImportSongIndex = songIndex;
    pendingImportTrackIndex = trackIndex;
    pendingImportFileName = std::move(fileName);
    pendingImportStartSeconds = std::isfinite(startSeconds) ? std::max(0.0, startSeconds) : 0.0;
}

void WebServer::takeTrackImportTarget(int& songIndex, int& trackIndex, std::string& fileName, double& startSeconds) {
    std::lock_guard<std::mutex> lock(importMutex);
    songIndex = pendingImportSongIndex;
    trackIndex = pendingImportTrackIndex;
    fileName = pendingImportFileName;
    startSeconds = pendingImportStartSeconds;
    pendingImportSongIndex = -1;
    pendingImportTrackIndex = -1;
    pendingImportFileName.clear();
    pendingImportStartSeconds = 0.0;
}


} // namespace resostage
