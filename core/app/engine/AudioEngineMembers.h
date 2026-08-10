// Private members and private methods for AudioEngine.
// Included only from AudioEngine.h inside `class AudioEngine { private: ... }`.
// Not a standalone header — no includes, no namespace, no class wrapper.

#ifndef RESOSTAGE_INSIDE_AUDIOENGINE_CLASS
// Opened on its own (an editor, a grep-and-jump, clangd indexing a header):
// this file is a fragment of AudioEngine's class body, not a translation unit,
// so parsing it from line 1 is meaningless. Pull in the real header instead --
// it defines the guard below and re-includes this file in its proper place, so
// the editor still gets a full, correct AST for everything written here.
#include "AudioEngine.h"
#else

    juce::AudioDeviceManager deviceManagerInstance;

    ProjectLoader loader;
    ProjectHistory projectHistory;
    MasterClock clock;
    RoutingEngine routing;
    StreamingEngine streaming;
    CoreMidiDispatcher midiDispatcher;
    EventDispatcher eventDispatcher;
    LightHardwareServer lightHardwareServer; // ESP32/ESP8266 WS-binary transport (see LightHardwareServer.h)
    LightEngine lightEngine; // near-realtime dedicated DMX output thread
    TransportTelemetry transportTelemetry;
    SystemHealth systemHealth;

    // Previous callback host time for underrun detection (audio thread only).
    uint64_t lastCallbackHostNanos = 0;

    // Runs the published MixGraph on the audio thread. Owns no routing state
    // of its own -- see engine/audio/MixRenderer.h.
    MixRenderer mixRenderer;

    // The metronome's strip in the graph. kNoStrip until a graph exists.
    uint32_t clickStripIndex = MixGraph::kNoStrip;
    // Message-thread copy of the most recently published graph, so telemetry
    // can answer "which solo group is this row in, and is anything soloed in
    // it" from the same structure the audio thread renders -- rather than a
    // second, drifting implementation of the grouping rule.
    std::shared_ptr<const MixGraph> publishedGraph;

    std::vector<LoadedBus> busses; // global, built once per loadProject()
    std::unordered_map<std::string, size_t> busIndexById;

    // Rebuilt per selectSong(); index matches the track's strip index in the
    // MixGraph, which lays project tracks out first and in project order.
    std::vector<std::string> trackIdByIndex;
    std::vector<std::unique_ptr<SeqLock<MeterFrame>>> busMeters;
    std::vector<LoudnessMeter> busLoudnessMeters;
    // Per-bus interval peak (linear), parallel to busMeters. Audio thread
    // CAS-maxes; message thread exchanges in consumeBusMeterInterval().
    // Not a vector<atomic> (atomics are not CopyConstructible).
    std::unique_ptr<std::atomic<float>[]> busPeakIntervalMaxL;
    std::unique_ptr<std::atomic<float>[]> busPeakIntervalMaxR;
    size_t busPeakIntervalCount = 0;
    // Message-thread only: one-frame echo of the previous interval (same
    // rationale as clickPeakDeliveryL/R).
    std::vector<float> busPeakDeliveryL;
    std::vector<float> busPeakDeliveryR;
    std::vector<std::unique_ptr<SeqLock<MeterFrame>>> trackMeters;
    // Per-track band-energy (GEQ/Blurz) analysis, kept in lockstep with
    // trackMeters so frame.bandLevel carries real per-band levels for the
    // light engine instead of the peak-only default.
    std::vector<BandEnergyMeter> trackBandMeters;
    std::vector<bool> busMuted; // mirror of project bus mute for quick UI reads
    std::vector<PeakOverview> trackPeaks;
    // Session-lifetime cache keyed by archive path (TrackDef::file), so
    // switching songs back and forth (Prev/Next, reselecting) doesn't
    // redecode the whole file every time just to redraw the same waveform --
    // only the on-disk PeakCache (Peaks/*.rsnrapeak, written on save) survived
    // across sessions before; this covers the common "haven't saved yet"
    // case within one run. Cleared on project load/import (file identity
    // may have changed).
    std::unordered_map<std::string, PeakOverview> peakOverviewSessionCache;
    mutable std::mutex peakCacheMutex; // guards peakOverviewSessionCache against background peak-build threads

    // file -> full-file duration, published by atomic shared_ptr swap (same
    // mechanism and rationale as RoutingEngine -- see its header).
    //
    // This exists ONLY so the audio thread can answer "how long is this file"
    // without touching peakCacheMutex. It used to reach through
    // regionEffectiveDurationSeconds() -> cachedPeaksForFile(), which locks
    // that mutex once per region per block -- while background peak builders
    // hold the very same mutex to copy whole PeakOverview objects into the
    // cache, and ensureAllSongPeaksBuilt() holds it across a scan of every
    // song's every region. A render callback that can be made to wait on a
    // non-real-time thread's memcpy is a dropout waiting for the worst
    // possible moment, and the worst moment here is right after a project
    // load, when every region still has durationSeconds == 0 (= "full file")
    // and the builders are at their busiest.
    //
    // Only ever grows, and durations never change for a given file, so a
    // reader that races one insert simply behaves as it did one block
    // earlier. Maintained exclusively by cachePeakOverview() /
    // clearPeakOverviewCache() -- an insert that bypasses those is invisible
    // to playback.
    std::shared_ptr<const std::unordered_map<std::string, double>> peakDurationsByFile;

    // Inserts into peakOverviewSessionCache and republishes
    // peakDurationsByFile. Callable from any non-real-time thread.
    void cachePeakOverview(const std::string& file, PeakOverview overview);
    void clearPeakOverviewCache();
    std::atomic<bool> allPeaksBuildInFlight{false}; // one ensureAllSongPeaksBuilt() sweep at a time

    // Bounded worker pool shared by rebuildTrackPeaks() and
    // ensureAllSongPeaksBuilt() for the per-file decode fan-out. Replaces
    // spawning one raw std::thread per file -- for a project with many
    // uncached stems that could oversubscribe the machine by dozens to
    // hundreds of threads (see PeakBuildThreadPool.h). Sized once at
    // construction, shared across every call for this engine's lifetime.
    PeakBuildThreadPool peakBuildPool{std::clamp(std::thread::hardware_concurrency(), 2u, 8u)};

    size_t currentSong = 0;
    int64_t currentSongLengthFrames = 0; // 0 = unknown/no tracks

    /**
     * How long the staged song runs, in device frames.
     *
     * `contentFrames` is the longest stream the song has staged. An authored
     * end (SongDef::endSeconds, the timeline's draggable marker) overrides it
     * outright, in both directions: a song can run past its audio -- silence
     * the operator has deliberately left room for, and the only way an EMPTY
     * song has a length at all -- or stop before it, cutting a tail without
     * touching the file. 0 keeps the old behaviour of deriving from content.
     *
     * This is what arms the end-of-song fade and the stop/advance decision in
     * the render callback, so the marker means the same thing to the transport
     * as it does on screen.
     */
    static int64_t songLengthFrames(double endSeconds,
                                    int64_t contentFrames,
                                    double sampleRate);

    // Region::durationSeconds == 0 means "full file", not zero seconds -- for
    // that case the real length comes from peakDurationsByFile (the lock-free
    // mirror of the peak cache; see its comment above), not from raw region
    // metadata. Returns 0.0 if that file hasn't been peak-built yet (global
    // timeline readout catches up once it is).
    //
    // Real-time safe: called once per region per block from the render
    // callback, so it must never lock.
    double regionEffectiveDurationSeconds(const Region& r) const;
    // A song's authored length = the furthest region end across its tracks.
    double songAuthoredDurationSeconds(const SongDef& song) const;

    /**
     * Largest block the render callback is prepared for without allocating.
     *
     * CoreAudio tops out at 4096 in this app's own device list; double it so
     * an aggregate device, a driver quirk or a future larger setting still
     * lands inside pre-allocated memory. The cost is a few hundred KB of
     * scratch, which is nothing next to one dropout.
     */
    static constexpr int kMaxSupportedBlockSize = 8192;
    /** Physical output lanes the stop-declick keeps a tail sample for. */
    static constexpr size_t kMaxSupportedOutputChannels = 64;

    // Underrun micro-fade (spec: 128-sample fade-out on dropout, fade-in on recovery).
    static constexpr int kUnderrunFadeSamples = 128;
    int underrunFadeOutRemaining = 0;
    // Length the current fade-out was armed with -- gain is remaining/length,
    // so underrun (128) and song-end (512) ramps both reach true zero instead
    // of sharing a hard-coded divisor that made underrun start at ~0.25.
    int underrunFadeOutLength = 0;
    int recoveryFadeInRemaining = 0;
    int recoveryFadeInLength = 0;
    bool lastCallbackWasUnderrun = false;
    // After a song-end (or underrun) fade-out reaches 0, hold the physical
    // outputs at silence until the next song's fade-in is armed. Without this
    // the per-sample fade loop falls back to g=1.0 for the rest of the block
    // (and every subsequent block until playhead hits the true end) -- which
    // is the loud crack heard on AutoplayNext song boundaries whenever the
    // buffer size is not a clean multiple of the fade length.
    bool outputHeldSilent = false;

    // Song-end fade-out: armed kSongEndFadeSamples *before* the real end of
    // the current song (not once already past it) -- StreamingTrackBuffer's
    // ring can run dry mid-block, producing an unramped hard cutoff to
    // silence within a single block if we only react after the fact. Starting
    // the ramp early guarantees gain has already decayed to ~0 by the time
    // that real cutoff sample arrives. The actual transition (gapless advance
    // / stop) is deferred until both the ramp has fully applied AND the
    // playhead has genuinely reached the end -- see the arm/commit split in
    // audioDeviceIOCallbackWithContext(). Audio-thread-owned only, like the
    // underrun fade counters above.
    enum class SongEndAction : uint8_t { None, GaplessAdvance, StopTransport };
    // ~43ms @ 48kHz. Longer than a typical device block (256–1024) so the
    // song-end ramp cannot finish mid-block and leave residual full-gain
    // samples, and the gapless fade-in is long enough to hide a cold ring
    // fill or a non-zero-crossing attack at the top of the next song.
    static constexpr int kSongEndFadeSamples = 2048;
    SongEndAction pendingSongEndAction = SongEndAction::None;
    size_t pendingSongEndTargetSong = static_cast<size_t>(-1);

    // Declick tail for a user-initiated Stop/Pause (AudioEngine::stop(), not
    // the natural-song-end path above): stop()/pause sets `playing` false
    // synchronously from the message thread with no foreknowledge of when
    // that'll land in the audio thread, unlike song-end's pre-armed fade --
    // so instead of ramping the upcoming (already-silent) block, this ramps
    // the *last actual output sample* on each physical channel down to zero
    // over a short window the first time the render callback observes
    // `!playing` right after observing it true, avoiding the hard,
    // audible cut a bare `if (!playing) return;` would otherwise produce.
    // ~5.8ms @ 48kHz -- long enough to be a fade, short enough nobody
    // perceives Stop as sluggish. Audio-thread-owned only.
    static constexpr int kStopDeclickSamples = 256;
    std::vector<float> lastOutputSample; // one per physical channel, resized on demand
    int stopDeclickRemaining = 0;
    bool wasPlayingLastCallback = false;

    // Message-thread-owned. Discriminates "the project's MIDI clock has
    // never been started" from song-local playhead position, so play() can
    // tell a genuine transport start (send MIDI Start/0xFA) apart from a
    // resume-from-pause or seek-to-song-start (send MIDI Continue/0xFB
    // instead) -- see AudioEngine::play()'s doc comment. Reset on every
    // loadProject()/newProject().
    bool midiClockEverStarted = false;

    // Audio-thread-only: the render callback returns immediately while
    // !playing, which otherwise means trackMeters/busMeters just keep
    // reporting whatever they last read while playing forever (the Mixer/web
    // meters visibly "freeze" instead of falling to silence on Stop). Set
    // once the first stopped callback has pushed a silent frame so we don't
    // redo that write every callback for as long as playback stays stopped.
    bool metersSilencedSinceStop = false;

    // Built-in click generator. Sample-locked to the song playhead so strong
    // (bar 1) / weak beats follow the current song's BPM + time signature.
    // Song hops retarget the grid (bpm/tsNum/tsDen); playhead 0 = downbeat.
    // Its LEVEL, pan, mono fold, mute, routing and meter are not here: the
    // metronome is an ordinary strip in the MixGraph (see clickStripIndex),
    // so it shares one implementation of all of those with every track.
    ClickGenerator clickGenerator;
    std::vector<float> clickScratch;
    // Dedicated click strip meter (pre-bus mix); never shares the destination bus meter.
    SeqLock<MeterFrame> clickMeterFrame;
    /** Meter needle release: see holdMeterPeak / beginMeterPoll. */
    static float holdMeterPeak(float intervalPeak, float& held, double dtSeconds);
    std::chrono::steady_clock::time_point lastMeterPollAt{};
    double lastMeterPollDelta = 0.0;

    // Max sample peak (linear) since last consumeClickMeterInterval() — see
    // that method's doc. Updated on the audio thread, exchanged on the message
    // thread (atomic max via CAS).
    std::atomic<float> clickPeakIntervalMaxL{0.0f};
    std::atomic<float> clickPeakIntervalMaxR{0.0f};
    // Message-thread only: previous interval's peak, re-published once so the
    // next telemetry frame still carries a tick the WS client may have missed.
    float clickPeakDeliveryL = 0.0f;
    float clickPeakDeliveryR = 0.0f;
    std::vector<uint8_t> eventFiredFlags; // parallel to current song's events; reset per selectSong()/play()
    std::atomic<bool> autoAdvancePending{false};
    std::atomic<int> pendingGaplessSong{-1}; // >=0 => message thread should gapless-switch
    std::atomic<int> pendingGaplessUiNotify{-1}; // audio-thread promote done; UI only
    // Per-song cycle locators mirrored for the *currently staged* song so the
    // realtime path can loop/skip without reading SongDef under mutation, and
    // without relying on any SPA client to issue transport.seek.
    std::atomic<bool> cycleActive{false};
    std::atomic<bool> cycleSkip{false};
    std::atomic<double> cycleLeftSec{0.0};
    std::atomic<double> cycleRightSec{4.0};
    // >= 0 => message thread should seekToSeconds(this value). -1 = none.
    // Audio thread only sets when previously -1 (coalesce) to avoid seek spam.
    std::atomic<double> pendingCycleSeekSec{-1.0};
    // Bumped on every cycle sync so stale callAsync seeks from a previous
    // zone (before disable/replace) never land after the new state is live.
    std::atomic<uint64_t> cycleEpoch{0};
    std::vector<ProjectLoader::ExtraFile> pendingPeakCacheExtras;

    std::atomic<bool> playing{false};
    std::atomic<int64_t> hwSamplePosition{0};
    std::atomic<double> simulatedStallMs{0.0};
    // Set for the brief window of a gapless promote (or any mid-playback
    // restage) between "new streams are active" and "playhead has been
    // reset to 0 / seek target". While true the audio callback emits silence
    // and does NOT touch stream rings -- otherwise it would read the new
    // song at the OLD playhead (end of previous song), queue a massive skip,
    // and the next song would audibly start mid-file.
    std::atomic<bool> streamHandoff{false};

    // Audio-thread gapless promote when precache is warm (no message-thread wait).
    bool tryGaplessPromoteOnAudioThread(size_t nextSongIndex);
    void resetMetersSilent();

    double currentSampleRate = 48000.0;
    int currentBlockSize = 512;
    bool projectLoaded = false;
    // Captures "was transport live" in audioDeviceStopped(), just before it
    // clears `playing` -- any setAudioDeviceSetup-triggered restart (rate
    // change, output device change, buffer size change) or a hot-unplug
    // fail-safe recovery goes through this same stop/restart pair, so a
    // single mechanism here covers resuming playback after all of them.
    // Read-and-cleared (exchange) by the next audioDeviceAboutToStart.
    std::atomic<bool> resumeAfterDeviceRestart{false};
    bool usingDraftArchive = false; // see isDraftProject()
    std::atomic<bool> unsavedChanges{false};
    std::atomic<bool> busyImporting{false}; // see isBusy()
    std::atomic<bool> busySaving{false};    // see saveProjectAsync / isBusy()
    std::atomic<bool> autosaveDeferred{false};
    std::thread importThread; // joined before starting a new import, and in ~AudioEngine()
    std::thread saveThread;   // joined in ~AudioEngine / before a new save

    // After a play-through save, the previous package directory is still
    // referenced by open stem FILE* inodes. Delete only when streams are
    // restaged / stopped (see purgeStaleSavePackages).
    std::vector<std::string> staleSavePackages;
    void purgeStaleSavePackages();


    // Waveform-peak decoding is read-only UI feed, not playback-critical, so
    // it runs off the message thread on detached background threads
    // (rebuildTrackPeaks() used to decode every stem synchronously, which is
    // what made selecting/loading a song feel slow). Not reflected in
    // isBusy()/busyImporting on purpose -- unlike imports, a peak build must
    // never freeze transport controls or meters, including when rapidly
    // switching songs (a plain join-the-previous-thread here would still
    // block the message thread for however long that thread's in-flight
    // decode takes -- generation only causes it to *abandon*, at the next
    // per-track checkpoint, not to stop instantly).
    //
    // activePeakBuilds counts builds still touching `loader` (decremented as
    // soon as each thread is done reading, before it posts results back).
    // Anything that mutates `loader` directly outside of streaming's own I/O
    // thread (loadProject/newProject/saveProject/import/~AudioEngine) must
    // wait for this to hit zero first via joinPendingPeakBuilds().
    std::atomic<uint64_t> peakBuildGeneration{0};
    std::atomic<int> activePeakBuilds{0};
    void joinPendingPeakBuilds();

    // Reused every callback; resized only from non-real-time call sites
    // (audioDeviceAboutToStart, selectSong) -- never on the audio thread.
    juce::AudioBuffer<float> busScratch;
    // Per-track decode scratch (up to 2 channels), indexed like trackIdByIndex.
    std::vector<juce::AudioBuffer<float>> trackScratch;
    // Scratch for the SECOND and subsequent regions overlapping one track in
    // one block -- i.e. a crossfade. One buffer, not one per region: the
    // overlapping regions are rendered one at a time and summed into the
    // track's own scratch as each finishes, so they never need to coexist.
    juce::AudioBuffer<float> regionMixScratch;

    // ── Transposition ───────────────────────────────────────────────────
    //
    // A phase vocoder per pitched region. Pooled rather than one-per-region:
    // each carries FFT state measured in tens of kilobytes, and a project can
    // hold hundreds of regions of which a handful are ever transposed at once.
    //
    // Everything that allocates -- configure(), and reset() the first time --
    // happens in ensureScratchSizes on the message thread. The audio callback
    // only claims a slot, sets the transpose and pushes samples through.
    struct PitchSlot {
        // Region this slot is currently following, empty when free.
        std::string regionId;
        // Where its input cursor is, so a jump can be told from continuous
        // playback: a phase vocoder is sequential and has no concept of seek.
        int64_t nextInputSample = 0;
        double semitones = 0.0;
        bool everUsed = false;
        signalsmith::stretch::SignalsmithStretch<float> stretch;
    };
    // Eight: more transposed regions than that sounding at once is not a mix,
    // and the cap is what keeps this allocation-free on the audio thread.
    static constexpr size_t kPitchSlots = 8;
    std::vector<PitchSlot> pitchSlots;
    // Pre-pitch input and post-pitch output for one block.
    juce::AudioBuffer<float> pitchInScratch;
    juce::AudioBuffer<float> pitchOutScratch;

    mutable std::recursive_mutex routingMutex;


    void ensureScratchSizes();
    // Derives the mixer's flat bus rail from a freshly built graph. Pure --
    // runs outside routingMutex on purpose (see publishRoutingSnapshot).
    std::vector<LoadedBus> buildBusRows(const MixGraph& graph) const;
    // Swaps a prebuilt rail in. Caller MUST hold routingMutex.
    void installBusRows(std::vector<LoadedBus> rows);

    // Re-invokes updateRegionWindow() for every region of the currently
    // staged/active song -- called after undoTimelineEdit()/redoTimelineEdit()
    // wholesale-replaces the Project, since that bypasses the per-region
    // updateRegionWindow() call builderRegionUpdate() normally makes.
    void resyncStreamingWindowsForCurrentSong();

    // Cascades a live device sample-rate change (detected in
    // audioDeviceAboutToStart) through everything that caches the old rate:
    // re-preps the click grid, re-arms MasterClock at the new rate while
    // preserving the current timeline position, and re-stages the current
    // song so every StreamingTrackBuffer reopens and recomputes its
    // resample ratio against the new device rate (StreamingEngine already
    // drops/reopens its file pool on a rate mismatch -- this just re-invokes
    // that path, which nothing did before). Deferred via callAsync from
    // audioDeviceAboutToStart since that callback isn't guaranteed to fire on
    // the message thread for a driver-initiated (not Settings-triggered)
    // rate change, and Project/StreamingEngine state must stay
    // message-thread-only like everywhere else in this file. `wasPlaying`
    // is the transport state captured in audioDeviceStopped() just before it
    // cleared `playing` -- NOT a fresh read of `playing` here, which would
    // always observe false by the time this runs.
    void handleSampleRateChanged(double newSampleRate, double previousPlayheadSeconds, bool wasPlaying);

    void publishRoutingSnapshot(); // message-thread: build RoutingSnapshot from Project
    void ensureTrackMeters(size_t count);
    bool selectSongInternal(size_t songIndex, std::string& error, bool fireOnLoadEvents, bool gaplessKeepPlaying);

    // Message-thread completion shared by importWavForTrackAsync() and
    // importSongFromFolderAsync(): closes the old archive handle, replaces
    // it with the background thread's freshly-written tempOut file, reopens
    // (which re-parses project.json -- picking up whatever the background
    // thread's private Project snapshot already had baked in), rebuilds
    // busses/routing, restarts streaming, and restages songToRestore. Always
    // clears busyImporting and calls onComplete exactly once.
    std::function<void()> pendingFinishImport;
    void finishAsyncImport(bool writeSucceeded, std::string writeError, const std::string& tempOut,
                           const std::string& archivePath, size_t songToRestore, bool wasPlaying,
                           const std::function<void(bool, std::string)>& onComplete);
    void dispatchEvent(const TimelineEvent& ev, uint64_t targetHostTimeNanos);
    void fireOnLoadEvents(const SongDef& song);
    void fireDueEvents(const SongDef& song, double blockStartSeconds, double blockEndSeconds, uint64_t hostTimeNanosAtBlockStart);

    // Hot-plug fail-safe: juce::AudioDeviceManager broadcasts a change
    // whenever the device list or the current device's state changes
    // (including a disconnect). checkForDeviceLoss() detects the current
    // device having vanished, raises TransportTelemetry::hardwareAlarm, and
    // falls back to the system default output -- while deliberately NOT
    // stopping MasterClock, so the timeline keeps advancing (per its
    // fail-safe design) and audio resumes in sync once a device is available
    // again. Not verified against an actual physical hot-unplug in this
    // environment; implements the documented JUCE/CoreAudio mechanism but
    // hasn't been hardware-tested.
    void changeListenerCallback(juce::ChangeBroadcaster*) override;
    void checkForDeviceLoss();
    std::atomic<bool> isChangingSetup{false};
    std::string lastKnownDeviceName;

#endif // RESOSTAGE_INSIDE_AUDIOENGINE_CLASS
