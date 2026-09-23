#pragma once

#include "project/ProjectSchema.h"

#include <atomic>
#include <functional>
#include <string>

namespace resostage {

/** What signal is written by an offline render. */
enum class RenderTargetKind { Master, Bus, Track, Click };

struct OfflineRenderRequest {
    /** -1 renders every song in set-list order into one continuous file. */
    int songIndex = -1;
    RenderTargetKind targetKind = RenderTargetKind::Master;
    /** Track or bus id. Ignored for Master/Click. */
    std::string targetId;
    std::string outputPath;
    int sampleRate = 48000;
    /** 16/24 = integer PCM, 32 = IEEE float. */
    int bitDepth = 24;
    /** Silence appended after each selected song. */
    double tailSeconds = 0.0;
};

struct OfflineRenderResult {
    bool ok = false;
    std::string outputPath;
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
