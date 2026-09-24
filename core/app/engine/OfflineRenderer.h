#pragma once

#include "audio/MixRenderer.h"
#include "project/ProjectSchema.h"

#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace resostage {

/** What signal is written by an offline render. */
enum class RenderTargetKind { Master, Bus, Track, Click };

/** One post-strip tap written during the shared offline graph pass. */
struct OfflineRenderTarget {
    RenderTargetKind kind = RenderTargetKind::Master;
    /** Track or bus id. Ignored for Master/Click. */
    std::string id;
    std::string outputPath;
};

enum class RenderTailPolicy { Cut, Leave, Wrap };
enum class RenderDither { None, Tpdf };
enum class RenderNormalization { Off, OverloadProtection, Peak };

struct OfflineRenderProgress {
    double progress = 0.0;
    int64_t processedFrames = 0;
    int64_t estimatedTotalFrames = 0;
    /** preparing | rendering | tail | finalizing */
    std::string phase = "rendering";
};

struct OfflineRenderRequest {
    /** -1 renders every song in set-list order into one continuous file. */
    int songIndex = -1;
    RenderTargetKind targetKind = RenderTargetKind::Master;
    /** Track or bus id. Ignored for Master/Click. */
    std::string targetId;
    std::string outputPath;
    /**
     * Outputs captured from one graph sweep. Empty keeps the legacy single
     * target fields above working for tests and older API clients.
     */
    std::vector<OfflineRenderTarget> targets;
    int sampleRate = 48000;
    /** 16/24 = integer PCM, 32 = IEEE float. */
    int bitDepth = 24;
    RenderDither dither = RenderDither::None;
    RenderNormalization normalization = RenderNormalization::Off;
    /** Remove the common PDC startup delay while preserving aligned taps. */
    bool trimOutputLatency = true;
    /** Linear full-scale target expressed in dBFS; normally -0.1 or 0.0. */
    double normalizationCeilingDb = -0.1;
    RenderTailPolicy tailPolicy = RenderTailPolicy::Cut;
    /** Leave stops after this many continuously quiet seconds. */
    double tailQuietSeconds = 0.5;
    /** Hard bound for Leave, even when a future processor never decays. */
    double maxTailSeconds = 30.0;
    double tailThresholdDb = -96.0;
    /** Optional song-local range. End <= start means the whole song. */
    double rangeStartSeconds = 0.0;
    double rangeEndSeconds = 0.0;
    /** Legacy fixed silence. Retained for older callers; new UI does not use it. */
    double tailSeconds = 0.0;
};

struct OfflineRenderResult {
    bool ok = false;
    std::string outputPath;
    std::vector<std::string> outputPaths;
    std::vector<std::string> warnings;
    std::string error;
    int64_t framesWritten = 0;
};

/** Song-local transport supplied to a private offline processor bank. */
struct OfflineProcessorTransport {
    int64_t sample = 0;
    double sampleRate = 48000.0;
    double bpm = 120.0;
    int numerator = 4;
    int denominator = 4;
    bool playing = true;
    bool looping = false;
    int64_t loopStartSample = 0;
    int64_t loopEndSample = 0;
};

/**
 * JUCE-free boundary between the renderer and application-owned DSP.
 * A session belongs to one render/song and must never share state with live
 * playback. Its processor view is pre-bound and stable for the session.
 */
class OfflineProcessorSession {
public:
    virtual ~OfflineProcessorSession() = default;
    virtual MixProcessorView processorView() const noexcept = 0;
    virtual void publishTransport(
        const OfflineProcessorTransport& transport) noexcept = 0;
    /** Conservative serial-path tail used as a Leave minimum, in seconds. */
    virtual double declaredTailSeconds() const noexcept { return 0.0; }
    virtual std::vector<std::string> warnings() const { return {}; }
};

/**
 * Offline audio export driven by the production MixGraph/MixRenderer.
 *
 * The caller passes an immutable Project snapshot and archive path, so this
 * class never touches the live AudioEngine or its lock-free streaming state.
 * It is intended for a background thread; progress callbacks run on that same
 * thread. Source WAVs are decoded through small seekable caches rather than
 * loaded wholesale, keeping a multi-gigabyte set render bounded in memory.
 */
class OfflineRenderer {
public:
    using Progress = std::function<void(const OfflineRenderProgress&)>;
    using ProcessorFactory = std::function<std::unique_ptr<OfflineProcessorSession>(
        const Project&, const MixGraph&, double sampleRate, int maximumBlockSize,
        std::string& error)>;

    OfflineRenderResult render(const Project& project,
                               const std::string& projectPath,
                               const OfflineRenderRequest& request,
                               const Progress& onProgress = {},
                               const std::atomic<bool>* cancel = nullptr,
                               const ProcessorFactory& processorFactory = {}) const;
};

} // namespace resostage
