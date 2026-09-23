#pragma once

#include "project/ProjectSchema.h"

#include <atomic>
#include <functional>
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

enum class RenderTailPolicy { Cut, Leave };

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
    std::string error;
    int64_t framesWritten = 0;
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
    using Progress = std::function<void(double)>;

    OfflineRenderResult render(const Project& project,
                               const std::string& projectPath,
                               const OfflineRenderRequest& request,
                               const Progress& onProgress = {},
                               const std::atomic<bool>* cancel = nullptr) const;
};

} // namespace resostage
