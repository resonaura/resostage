// Public transport / song-staging / timeline-history API for AudioEngine.
// Included only from AudioEngine.h inside `class AudioEngine { public: ... }`.
// Implementation: AudioEngineTransport.cpp (plus timeline helpers in AudioEngine.cpp).

#ifndef RESOSTAGE_INSIDE_AUDIOENGINE_CLASS
// Opened on its own (an editor, a grep-and-jump, clangd indexing a header):
// this file is a fragment of AudioEngine's class body, not a translation unit,
// so parsing it from line 1 is meaningless. Pull in the real header instead --
// it defines the guard below and re-includes this file in its proper place, so
// the editor still gets a full, correct AST for everything written here.
#include "AudioEngine.h"
#else

    // Stages the given song's tracks for streaming and publishes its
    // routing. If already PLAYING, the new song starts immediately from 0
    // (transport stays live — setlist hop while playing). If stopped, only
    // stages. Fires the song's triggerOnLoad events when fireOnLoadEvents is
    // true (disabled for seek restages so gear isn't re-programmed on every
    // scrub). Precaches next song.
    bool selectSong(size_t songIndex, std::string& error, bool fireOnLoadEvents = true);

    // Gapless AutoplayNext handoff: promotes the precached next song without
    // going through Stop, restarts the timeline at 0, keeps PLAYING. Message
    // thread only (also invoked via callAsync right after an audio-thread
    // promote fails / for UI refresh after audio-thread promote succeeds).
    bool switchToSongGapless(size_t songIndex, std::string& error);

    // Background-open current±1 into the warm LRU so the next hop / AutoplayNext
    // boundary can audio-thread promote (no streamHandoff silence).
    void warmNeighbourSongs();

    void play();

    void stop();

    // "Stop" transport button (distinct from stop() above, which is really
    // Pause -- freezes in place so a following play() resumes, used by the
    // Play/Pause toggle). First call halts playback and rewinds the current
    // song to its own start; a second call while already sitting at that
    // start instead rewinds all the way to the very beginning of the whole
    // project (song 0, position 0) -- same two-stage convention as most DAW
    // transports' Stop button. Message-thread only.
    void stopToStart();

    bool isPlaying() const { return playing.load(std::memory_order_acquire); }

    // Seeks to `seconds` (clamped to [0, target song length]) within
    // `songIndex` -- defaults to the current song, but may target any other
    // song, enabling cross-song scrub/seek. Same-song seeks hard-seek the
    // active streams in place (no Stop/restage), so scrubbing no longer
    // clicks through a stop→play glitch. Cross-song still restages.
    // Message-thread only.
    bool seekToSeconds(double seconds, std::string& error, size_t songIndex = static_cast<size_t>(-1));

    // Message-thread-only: true when the audio thread finished a song in
    // AutoplayNext mode. Prefer consumeGaplessAdvance + switchToSongGapless.
    bool consumeAutoAdvancePending() { return autoAdvancePending.exchange(false, std::memory_order_acq_rel); }

    bool consumeGaplessAdvance(size_t& outSongIndex);

    // UI-only: song index that the audio thread already gapless-promoted
    // (streams+clock already at 0). Message thread should refresh panels
    // without calling switchToSongGapless again.
    bool consumeGaplessUiNotify(size_t& outSongIndex);

    // Mirror SongDef::cycle of the currently staged song onto audio-thread
    // atomics. Call after cycle edits, song select, project load, undo/redo.
    // Message-thread only.
    void syncTransportCycleFromProject();

    // True when the audio thread wants a same-song cycle/skip seek; clears
    // the pending request. Message-thread only (timerCallback / callAsync).
    bool consumeCycleSeek(double& outSeconds);

    // Timeline undo/redo (regions + sections). Wrap a single mutation like:
    //   engine.projectHistoryBeginEdit(gestureId, "Move region");
    //   ... mutate engine.project() in place ...
    //   engine.projectHistoryCommitEdit();
    // `gestureId` (optional, empty = always a new step) lets several
    // begin/commit pairs collapse into one undo step for a single user
    // gesture composed of multiple mutator calls (split/duplicate/paste/
    // multi-delete). See ProjectHistory's doc comment for the full design.
    void projectHistoryBeginEdit(const std::string& gestureId, const std::string& label) {
        projectHistory.beginEdit(loader.project(), gestureId, label);
    }

    void projectHistoryCommitEdit() { projectHistory.commitEdit(loader.project()); }
    /** Close an edit opened with this id; see ProjectHistory::commitOpenEdit. */
    bool projectHistoryCommitOpenEdit(const std::string& gestureId) {
        return projectHistory.commitOpenEdit(gestureId, loader.project());
    }

    bool canUndoTimeline() const { return projectHistory.canUndo(); }

    bool canRedoTimeline() const { return projectHistory.canRedo(); }

    std::string undoTimelineLabel() const { return projectHistory.undoLabel(); }

    std::string redoTimelineLabel() const { return projectHistory.redoLabel(); }

    // Applies the popped undo/redo step wholesale and re-syncs the
    // currently active song's StreamingEngine region windows (mirrors what
    // builderRegionUpdate already does per-region -- a no-op for regions
    // belonging to a non-active song). Returns false ("nothing to undo/
    // redo") without touching any state.
    bool undoTimelineEdit(std::string& appliedLabel);

    bool redoTimelineEdit(std::string& appliedLabel);

    double currentSongLengthSeconds() const;

    // Cumulative "whole project" position: sums every prior song's authored
    // duration (regardless of whether it's ever been staged/played this
    // session) plus the current song's elapsed position. Freezes on
    // pause/stop exactly like clock.currentSeconds() does, since it's built
    // directly on top of it. Message-thread-only (not audio-thread safe --
    // walks proj.songs and touches the peak cache mutex).
    double globalPlayheadSeconds() const;

    // Same cumulative position expressed in quarter-note beats, applying each
    // song's own bpm over its own span. Feeds both the UI's absolute
    // bar|beat readout and CoreMidiDispatcher's Song Position Pointer.
    double globalBeatsElapsed() const;

    // Stream buffer / RAM-resident health for UI (not real-time critical).
    StreamingEngine::BufferHealth streamBufferHealth() const {
        return streaming.activeBufferHealth(currentSampleRate);
    }

#endif // RESOSTAGE_INSIDE_AUDIOENGINE_CLASS
