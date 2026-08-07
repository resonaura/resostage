// Public peak-overview / waveform-cache API for AudioEngine.
// Included only from AudioEngine.h inside `class AudioEngine { public: ... }`.
// Implementation: AudioEnginePeaks.cpp.

    // Peak overview for timeline waveform (empty if not yet built / failed).
    const PeakOverview* trackPeaksAt(size_t index) const;

    void rebuildTrackPeaks();

    // Peak overview for ANY track file in the project, not just the
    // currently-staged song -- powers the web UI's continuous multi-song
    // timeline (see MainComponent::buildAllPeaksJson()). Reads straight from
    // the same session/on-disk cache trackPeaksAt() draws from; returns
    // nullptr if that file hasn't been built yet (call
    // ensureAllSongPeaksBuilt() to kick that off, then poll again).
    const PeakOverview* cachedPeaksForFile(const std::string& file) const;

    // Background-builds (or loads from the archive's Peaks/*.rsnrapeak cache)
    // peak overviews for every track in every song, not just the staged one.
    // Safe to call repeatedly/every tick -- it's a no-op once every file is
    // already cached, and only ever adds to the cache, so calling it again
    // after a Builder edit that adds a track is exactly how new files get
    // picked up.
    void ensureAllSongPeaksBuilt();

    // >0 while a rebuildTrackPeaks / ensureAllSongPeaksBuilt worker is still
    // decoding. Used by maybePublishPeaks() to decide when empty track slots
    // mean "still building" vs. "lane has no audio".
    int activePeakBuildCount() const {
        return activePeakBuilds.load(std::memory_order_acquire);
    }
