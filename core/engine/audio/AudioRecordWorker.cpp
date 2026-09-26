#include "audio/AudioRecordWorker.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <filesystem>

namespace resostage {

AudioRecordWorker::AudioRecordWorker() {
    planarBufferL.resize(4096, 0.0f);
    planarBufferR.resize(4096, 0.0f);
    encodedBuffer.resize(4096 * 2 * 3, 0); // 4096 frames * 2 channels * 3 bytes
}

AudioRecordWorker::~AudioRecordWorker() {
    if (running.load(std::memory_order_relaxed)) {
        stopAndFinalize();
    }
}

bool AudioRecordWorker::prepareRecording(const std::string& outputDirectory,
                                         const std::vector<TrackAudioRecordSession>& requestedSessions,
                                         double sampleRate,
                                         int64_t startSample,
                                         std::string& error) {
    if (running.load(std::memory_order_relaxed)) {
        error = "Recording worker is already running";
        return false;
    }

    std::error_code ec;
    std::filesystem::create_directories(outputDirectory, ec);
    if (ec) {
        error = "Failed to create output audio directory: " + ec.message();
        return false;
    }

    sessions.clear();
    sessions.reserve(requestedSessions.size());

    // 8 seconds of buffer capacity per armed track (e.g. 384k frames @ 48kHz)
    const int64_t ringCapacity = static_cast<int64_t>(sampleRate * 8.0);

    for (const auto& req : requestedSessions) {
        auto sess = std::make_unique<TrackAudioRecordSession>();
        sess->recordingId = req.recordingId.empty() ? ("rec_" + req.trackId) : req.recordingId;
        sess->trackId = req.trackId;
        sess->filename = req.filename;
        sess->fullPath = (std::filesystem::path(outputDirectory) / req.filename).string();
        sess->inputChannel0 = req.inputChannel0;
        sess->inputChannel1 = req.inputChannel1;
        sess->channels = (req.channels == 1) ? 1 : 2;
        sess->bitDepth = 24;
        sess->sampleRate = sampleRate;
        sess->startSample = startSample;
        sess->recordedFrames = 0;
        sess->dataBytes = 0;
        sess->currentBucketMin = 1.0f;
        sess->currentBucketMax = -1.0f;
        sess->sampleAccumCount = 0;
        sess->peakAccumulator.reset();
        if (!sess->peakPyramid) sess->peakPyramid = std::make_unique<LivePeakPyramid>();
        sess->peakPyramid->clear();
        sess->liveCapturedFrames.store(0, std::memory_order_relaxed);
        sess->liveState.store(LiveRecordingState::Capturing, std::memory_order_relaxed);

        sess->file = std::fopen(sess->fullPath.c_str(), "wb");
        if (sess->file == nullptr) {
            error = "Failed to open WAV file for writing: " + sess->fullPath;
            sessions.clear();
            return false;
        }

        // Reserve 44-byte standard RIFF header
        uint8_t emptyHeader[44]{};
        if (std::fwrite(emptyHeader, 1, 44, sess->file) != 44) {
            error = "Failed to write WAV header prefix to " + sess->fullPath;
            std::fclose(sess->file);
            sess->file = nullptr;
            sessions.clear();
            return false;
        }

        sess->ringBuffer = std::make_unique<AudioRingBuffer>();
        sess->ringBuffer->prepare(sess->channels, ringCapacity);
        sessions.push_back(std::move(sess));
    }

    running.store(true, std::memory_order_release);
    workerThread = std::thread(&AudioRecordWorker::workerLoop, this);
    return true;
}

void AudioRecordWorker::pushFrames(size_t sessionIndex, const float* const* channelPointers, int64_t numFrames) noexcept {
    if (!running.load(std::memory_order_relaxed))
        return;
    if (sessionIndex >= sessions.size())
        return;
    auto* ring = sessions[sessionIndex]->ringBuffer.get();
    if (ring != nullptr && channelPointers != nullptr && numFrames > 0) {
        ring->push(channelPointers, numFrames);
    }
}

void AudioRecordWorker::workerLoop() {
    while (running.load(std::memory_order_acquire)) {
        for (auto& session : sessions) {
            if (session != nullptr && session->ringBuffer != nullptr) {
                while (session->ringBuffer->framesAvailable() >= 256) {
                    writeSessionChunk(*session, 2048);
                }
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
}

void AudioRecordWorker::writeSessionChunk(TrackAudioRecordSession& session, int64_t maxFrames) {
    if (session.file == nullptr || session.ringBuffer == nullptr)
        return;

    const int64_t avail = session.ringBuffer->framesAvailable();
    if (avail <= 0)
        return;

    const int64_t toRead = std::min<int64_t>({avail, maxFrames, static_cast<int64_t>(planarBufferL.size())});
    float* outPtrs[2] = {planarBufferL.data(), session.channels > 1 ? planarBufferR.data() : planarBufferL.data()};
    const int64_t read = session.ringBuffer->pop(outPtrs, toRead);
    if (read <= 0)
        return;

    // Accumulate live peaks for waveform preview
    for (int64_t i = 0; i < read; ++i) {
        const float vL = planarBufferL[static_cast<size_t>(i)];
        const float vR = (session.channels > 1) ? planarBufferR[static_cast<size_t>(i)] : vL;
        const float sampleMin = std::min(vL, vR);
        const float sampleMax = std::max(vL, vR);

        session.currentBucketMin = std::min(session.currentBucketMin, sampleMin);
        session.currentBucketMax = std::max(session.currentBucketMax, sampleMax);
        session.sampleAccumCount++;

        if (session.sampleAccumCount >= kBaseSamplesPerPeak) {
            const int16_t pMin = static_cast<int16_t>(std::clamp<long>(std::lrint(session.currentBucketMin * 32767.0f), -32767L, 32767L));
            const int16_t pMax = static_cast<int16_t>(std::clamp<long>(std::lrint(session.currentBucketMax * 32767.0f), -32767L, 32767L));
            const PeakPair16 pair{pMin, pMax};

            session.peakAccumulator.pushLevel0(pair, [&](size_t lvl, PeakPair16 p) {
                if (session.peakPyramid) session.peakPyramid->addPeak(lvl, p);
            });

            session.currentBucketMin = 1.0f;
            session.currentBucketMax = -1.0f;
            session.sampleAccumCount = 0;
        }
    }

    // Encode to 24-bit signed integer PCM
    const size_t bytesPerSample = 3;
    const size_t bytesTotal = static_cast<size_t>(read * session.channels * bytesPerSample);
    if (encodedBuffer.size() < bytesTotal)
        encodedBuffer.resize(bytesTotal);

    uint8_t* p = encodedBuffer.data();
    for (int64_t i = 0; i < read; ++i) {
        const float v0 = std::clamp(planarBufferL[static_cast<size_t>(i)], -1.0f, 1.0f);
        const int32_t s0 = static_cast<int32_t>(std::lrint(v0 * 8388607.0f));
        *p++ = static_cast<uint8_t>(s0 & 0xFF);
        *p++ = static_cast<uint8_t>((s0 >> 8) & 0xFF);
        *p++ = static_cast<uint8_t>((s0 >> 16) & 0xFF);

        if (session.channels > 1) {
            const float v1 = std::clamp(planarBufferR[static_cast<size_t>(i)], -1.0f, 1.0f);
            const int32_t s1 = static_cast<int32_t>(std::lrint(v1 * 8388607.0f));
            *p++ = static_cast<uint8_t>(s1 & 0xFF);
            *p++ = static_cast<uint8_t>((s1 >> 8) & 0xFF);
            *p++ = static_cast<uint8_t>((s1 >> 16) & 0xFF);
        }
    }

    const size_t written = std::fwrite(encodedBuffer.data(), 1, bytesTotal, session.file);
    session.dataBytes += written;
    session.recordedFrames += read;
    session.liveCapturedFrames.store(session.recordedFrames, std::memory_order_release);
}

bool AudioRecordWorker::writeWavHeader(FILE* file, uint32_t sampleRate, uint16_t channels, uint16_t bitDepth, uint64_t dataBytes) {
    if (file == nullptr)
        return false;

    const uint16_t format = 1; // 1 = Linear PCM
    const uint32_t bytesPerSec = sampleRate * channels * (bitDepth / 8);
    const uint16_t blockAlign = channels * (bitDepth / 8);
    const uint32_t riffSize = static_cast<uint32_t>(36 + dataBytes);
    const uint32_t dataSize = static_cast<uint32_t>(dataBytes);

    if (std::fseek(file, 0, SEEK_SET) != 0)
        return false;

    std::fwrite("RIFF", 1, 4, file);
    std::fwrite(&riffSize, 4, 1, file);
    std::fwrite("WAVEfmt ", 1, 8, file);
    const uint32_t fmtSize = 16;
    std::fwrite(&fmtSize, 4, 1, file);
    std::fwrite(&format, 2, 1, file);
    std::fwrite(&channels, 2, 1, file);
    std::fwrite(&sampleRate, 4, 1, file);
    std::fwrite(&bytesPerSec, 4, 1, file);
    std::fwrite(&blockAlign, 2, 1, file);
    const uint16_t bits = bitDepth;
    std::fwrite(&bits, 2, 1, file);
    std::fwrite("data", 1, 4, file);
    std::fwrite(&dataSize, 4, 1, file);

    return std::fflush(file) == 0 && std::ferror(file) == 0;
}

std::vector<LiveRecordingRegionInfo> AudioRecordWorker::getLiveRegions() const {
    std::vector<LiveRecordingRegionInfo> infos;
    infos.reserve(sessions.size());
    for (const auto& s : sessions) {
        if (s == nullptr) continue;
        LiveRecordingRegionInfo info;
        info.recordingId = s->recordingId;
        info.trackId = s->trackId;
        info.timelineStartSample = s->startSample;
        info.capturedFrames = s->liveCapturedFrames.load(std::memory_order_relaxed);
        info.channelCount = static_cast<uint32_t>(s->channels);
        info.state = s->liveState.load(std::memory_order_relaxed);
        infos.push_back(info);
    }
    return infos;
}

std::vector<PeakPair16> AudioRecordWorker::getPeakChunk(const std::string& trackId, size_t level, size_t first, size_t count) const {
    for (const auto& s : sessions) {
        if (s == nullptr) continue;
        if (s->trackId == trackId || s->recordingId == trackId) {
            return s->peakPyramid ? s->peakPyramid->getPeaks(level, first, count) : std::vector<PeakPair16>{};
        }
    }
    return {};
}

int64_t AudioRecordWorker::getCapturedFrames(const std::string& trackId) const {
    for (const auto& s : sessions) {
        if (s == nullptr) continue;
        if (s->trackId == trackId || s->recordingId == trackId) {
            return s->liveCapturedFrames.load(std::memory_order_relaxed);
        }
    }
    return 0;
}

std::vector<RecordedAudioTrackResult> AudioRecordWorker::stopAndFinalize() {
    running.store(false, std::memory_order_release);
    if (workerThread.joinable()) {
        workerThread.join();
    }

    std::vector<RecordedAudioTrackResult> results;
    results.reserve(sessions.size());

    for (auto& session : sessions) {
        if (session == nullptr)
            continue;

        session->liveState.store(LiveRecordingState::Finalizing, std::memory_order_relaxed);

        // Drain any remaining frames left in the ring
        if (session->ringBuffer != nullptr) {
            while (session->ringBuffer->framesAvailable() > 0) {
                writeSessionChunk(*session, 4096);
            }
        }

        // Emit final partial bucket if present
        if (session->sampleAccumCount > 0) {
            const int16_t pMin = static_cast<int16_t>(std::clamp<long>(std::lrint(session->currentBucketMin * 32767.0f), -32767L, 32767L));
            const int16_t pMax = static_cast<int16_t>(std::clamp<long>(std::lrint(session->currentBucketMax * 32767.0f), -32767L, 32767L));
            const PeakPair16 pair{pMin, pMax};
            session->peakAccumulator.pushLevel0(pair, [&](size_t lvl, PeakPair16 p) {
                if (session->peakPyramid) session->peakPyramid->addPeak(lvl, p);
            });
            session->sampleAccumCount = 0;
        }

        if (session->file != nullptr) {
            writeWavHeader(session->file,
                           static_cast<uint32_t>(session->sampleRate),
                           static_cast<uint16_t>(session->channels),
                           static_cast<uint16_t>(session->bitDepth),
                           session->dataBytes);
            std::fclose(session->file);
            session->file = nullptr;
        }

        session->liveState.store(LiveRecordingState::Committed, std::memory_order_relaxed);

        RecordedAudioTrackResult res;
        res.trackId = session->trackId;
        res.filename = session->filename;
        res.fullPath = session->fullPath;
        res.startSample = session->startSample;
        res.recordedFrames = session->recordedFrames;
        res.sampleRate = session->sampleRate;
        res.channels = session->channels;
        results.push_back(std::move(res));
    }

    sessions.clear();
    return results;
}

} // namespace resostage
