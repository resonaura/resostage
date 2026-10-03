/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "audio/streaming/AudioRingBuffer.h"
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#include <mutex>
#include <algorithm>
#include <cmath>

namespace resostage {

struct PeakPair16 {
    int16_t min = 0;
    int16_t max = 0;
};

// Sixteen geometric levels cover long show overviews in one bounded HTTP
// chunk, including high sample rates. The extra levels above L5 add less than
// 1.6% to existing peak emissions/storage; only the record worker builds them.
static constexpr size_t kMaxPeakLevels = 16;
static constexpr int64_t kBaseSamplesPerPeak = 128; // L0: 128 samples / peak

/**
 * Iterative multi-level peak accumulator for live waveform rendering.
 * Level N covers 128 * 2^N frames (L0 = 128, L15 = 4,194,304).
 * Merge depth is bounded by kMaxPeakLevels; no work moves onto the callback.
 */
struct PeakMipAccumulator {
    PeakPair16 pending[kMaxPeakLevels]{};
    bool occupied[kMaxPeakLevels]{false};

    template <typename EmitFn>
    void pushLevel0(PeakPair16 p, EmitFn&& emit) noexcept {
        pushAtLevel(0, p, emit);
    }

    template <typename EmitFn>
    void pushAtLevel(size_t level, PeakPair16 p, EmitFn&& emit) noexcept {
        emit(level, p);
        if (level + 1 >= kMaxPeakLevels)
            return;
        if (!occupied[level]) {
            pending[level] = p;
            occupied[level] = true;
            return;
        }
        PeakPair16 merged {
            static_cast<int16_t>(std::min(pending[level].min, p.min)),
            static_cast<int16_t>(std::max(pending[level].max, p.max))
        };
        occupied[level] = false;
        pushAtLevel(level + 1, merged, emit);
    }

    void reset() noexcept {
        for (size_t i = 0; i < kMaxPeakLevels; ++i) {
            pending[i] = PeakPair16{};
            occupied[i] = false;
        }
    }
};

/**
 * Thread-safe pyramid storage for live waveform streaming during capture.
 */
struct LivePeakPyramid {
    mutable std::mutex mutex;
    std::vector<PeakPair16> levels[kMaxPeakLevels];
    std::atomic<uint32_t> countLevel0{0};

    void addPeak(size_t level, PeakPair16 p) {
        std::lock_guard<std::mutex> lock(mutex);
        if (level < kMaxPeakLevels) {
            levels[level].push_back(p);
            if (level == 0) {
                countLevel0.store(static_cast<uint32_t>(levels[0].size()), std::memory_order_release);
            }
        }
    }

    std::vector<PeakPair16> getPeaks(size_t level, size_t first, size_t count) const {
        std::lock_guard<std::mutex> lock(mutex);
        if (level >= kMaxPeakLevels) return {};
        const auto& vec = levels[level];
        if (first >= vec.size()) return {};
        const size_t end = first + std::min(count, vec.size() - first);
        return std::vector<PeakPair16>(vec.begin() + static_cast<std::ptrdiff_t>(first),
                                       vec.begin() + static_cast<std::ptrdiff_t>(end));
    }

    size_t size(size_t level) const {
        std::lock_guard<std::mutex> lock(mutex);
        return level < kMaxPeakLevels ? levels[level].size() : 0;
    }

    void clear() {
        std::lock_guard<std::mutex> lock(mutex);
        for (auto& lvl : levels)
            lvl.clear();
        countLevel0.store(0, std::memory_order_release);
    }
};

enum class LiveRecordingState : uint8_t {
    Pending = 0,
    Capturing = 1,
    Finalizing = 2,
    Committed = 3,
    Failed = 4
};

enum class LiveRecordingKind : uint8_t {
    Audio = 0,
    Midi = 1
};

struct LiveRecordingMidiNoteInfo {
    uint64_t id = 0;
    uint8_t pitch = 60;
    double startBeats = 0.0;
    double durationBeats = 0.0;
    float velocity = 0.8f;
    bool active = false;
};

struct LiveRecordingMidiControllerInfo {
    uint64_t id = 0;
    uint8_t controller = 64;
    uint8_t channel = 0;
    uint8_t value = 0;
    double beat = 0.0;
};

struct LiveRecordingRegionInfo {
    std::string recordingId;
    std::string trackId;
    int64_t timelineStartSample = 0;
    int64_t capturedFrames = 0;
    uint32_t channelCount = 2;
    LiveRecordingState state = LiveRecordingState::Pending;
    LiveRecordingKind kind = LiveRecordingKind::Audio;
    std::vector<LiveRecordingMidiNoteInfo> midiNotes;
    std::vector<LiveRecordingMidiControllerInfo> midiControllers;
};

struct TrackAudioRecordSession {
    std::string recordingId;
    std::string trackId;
    std::string filename;
    std::string fullPath;
    int inputChannel0 = 0; // 0-based hardware input channel
    int inputChannel1 = -1; // -1 = mono
    int channels = 2; // channels in destination WAV (1 or 2)
    int bitDepth = 24; // 24-bit PCM
    double sampleRate = 48000.0;
    int64_t startSample = 0;
    int64_t recordedFrames = 0;
    uint64_t dataBytes = 0;
    FILE* file = nullptr;
    std::unique_ptr<AudioRingBuffer> ringBuffer;

    // Peak accumulator state
    PeakMipAccumulator peakAccumulator;
    std::unique_ptr<LivePeakPyramid> peakPyramid = std::make_unique<LivePeakPyramid>();
    float currentBucketMin = 1.0f;
    float currentBucketMax = -1.0f;
    int sampleAccumCount = 0;

    std::atomic<int64_t> liveCapturedFrames{0};
    std::atomic<LiveRecordingState> liveState{LiveRecordingState::Pending};

    TrackAudioRecordSession() = default;
    TrackAudioRecordSession(TrackAudioRecordSession&& o) noexcept
        : recordingId(std::move(o.recordingId)),
          trackId(std::move(o.trackId)),
          filename(std::move(o.filename)),
          fullPath(std::move(o.fullPath)),
          inputChannel0(o.inputChannel0),
          inputChannel1(o.inputChannel1),
          channels(o.channels),
          bitDepth(o.bitDepth),
          sampleRate(o.sampleRate),
          startSample(o.startSample),
          recordedFrames(o.recordedFrames),
          dataBytes(o.dataBytes),
          file(o.file),
          ringBuffer(std::move(o.ringBuffer)),
          peakAccumulator(o.peakAccumulator),
          peakPyramid(std::move(o.peakPyramid)),
          currentBucketMin(o.currentBucketMin),
          currentBucketMax(o.currentBucketMax),
          sampleAccumCount(o.sampleAccumCount),
          liveCapturedFrames(o.liveCapturedFrames.load(std::memory_order_relaxed)),
          liveState(o.liveState.load(std::memory_order_relaxed))
    {
        o.file = nullptr;
    }

    TrackAudioRecordSession& operator=(TrackAudioRecordSession&& o) noexcept {
        if (this != &o) {
            recordingId = std::move(o.recordingId);
            trackId = std::move(o.trackId);
            filename = std::move(o.filename);
            fullPath = std::move(o.fullPath);
            inputChannel0 = o.inputChannel0;
            inputChannel1 = o.inputChannel1;
            channels = o.channels;
            bitDepth = o.bitDepth;
            sampleRate = o.sampleRate;
            startSample = o.startSample;
            recordedFrames = o.recordedFrames;
            dataBytes = o.dataBytes;
            file = o.file;
            o.file = nullptr;
            ringBuffer = std::move(o.ringBuffer);
            peakAccumulator = o.peakAccumulator;
            peakPyramid = std::move(o.peakPyramid);
            currentBucketMin = o.currentBucketMin;
            currentBucketMax = o.currentBucketMax;
            sampleAccumCount = o.sampleAccumCount;
            liveCapturedFrames.store(o.liveCapturedFrames.load(std::memory_order_relaxed), std::memory_order_relaxed);
            liveState.store(o.liveState.load(std::memory_order_relaxed), std::memory_order_relaxed);
        }
        return *this;
    }
};

struct RecordedAudioTrackResult {
    std::string trackId;
    std::string filename;
    std::string fullPath;
    int64_t startSample = 0;
    int64_t recordedFrames = 0;
    double sampleRate = 48000.0;
    int channels = 2;
};

/**
 * Decoupled, lock-free audio recording coordinator.
 * Producer: Real-time audio callback pushes input frames into planar SPSC AudioRingBuffers.
 * Consumer: Background worker thread pops frames, calculates live peak mipmaps, and writes standard WAV files to disk.
 */
class AudioRecordWorker {
public:
    AudioRecordWorker();
    ~AudioRecordWorker();

    AudioRecordWorker(const AudioRecordWorker&) = delete;
    AudioRecordWorker& operator=(const AudioRecordWorker&) = delete;

    // Called on message thread before transport recording begins.
    bool prepareRecording(const std::string& outputDirectory,
                          const std::vector<TrackAudioRecordSession>& requestedSessions,
                          double sampleRate,
                          int64_t startSample,
                          std::string& error);

    // Audio-thread fast accessor for active sessions.
    const std::vector<std::unique_ptr<TrackAudioRecordSession>>& activeSessions() const noexcept {
        return sessions;
    }

    // Audio-thread producer hook: pushes planar audio frames (zero-allocation, non-blocking).
    void pushFrames(size_t sessionIndex, const float* const* channelPointers, int64_t numFrames) noexcept;

    // Message-thread call to stop recording, drain remaining frames, write WAV headers, and return results.
    std::vector<RecordedAudioTrackResult> stopAndFinalize();

    bool isRecording() const noexcept {
        return running.load(std::memory_order_acquire);
    }

    // Live telemetry & waveform query APIs
    std::vector<LiveRecordingRegionInfo> getLiveRegions() const;
    std::vector<PeakPair16> getPeakChunk(const std::string& trackId, size_t level, size_t first, size_t count) const;
    int64_t getCapturedFrames(const std::string& trackId) const;

private:
    void workerLoop();
    void writeSessionChunk(TrackAudioRecordSession& session, int64_t maxFrames);
    static bool writeWAVHeader(FILE* file, uint32_t sampleRate, uint16_t channels, uint16_t bitDepth, uint64_t dataBytes);

    std::atomic<bool> running{false};
    std::thread workerThread;
    std::vector<std::unique_ptr<TrackAudioRecordSession>> sessions;

    std::vector<float> planarBufferL;
    std::vector<float> planarBufferR;
    std::vector<uint8_t> encodedBuffer;
};

} // namespace resostage
