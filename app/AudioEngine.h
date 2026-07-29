#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_events/juce_events.h>

#include "audio/ClickGenerator.h"
#include "audio/Metering.h"
#include "audio/PeakBuildThreadPool.h"
#include "audio/PeakOverview.h"
#include "audio/RoutingEngine.h"
#include "audio/StreamingEngine.h"
#include "events/EventDispatcher.h"
#include "midi/CoreMidiDispatcher.h"
#include "project/ProjectLoader.h"
#include "project/ProjectSchema.h"
#include "telemetry/SeqLock.h"
#include "telemetry/SystemHealth.h"
#include "telemetry/Telemetry.h"
#include "timing/MasterClock.h"

#include <algorithm>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace resoset {

struct LoadedBus {
    std::string id;
    int channelCount = 2;
};

// The only piece of the engine that touches JUCE audio APIs. Owns the
// CoreAudio device connection, and on every real-time callback: advances
// MasterClock, pulls the current block's audio from StreamingEngine (disk-
// backed SPSC ring buffers, not a full-song RAM preload -- see StreamingEngine
// and StreamingTrackBuffer for the streaming/catch-up design), walks the
// active RoutingEngine snapshot to mix tracks -> busses -> physical outputs,
// updates per-bus metering, fires any TimelineEvents whose time has arrived
// (MIDI/HTTP/DMX, dispatched off-thread via CoreMidiDispatcher/EventDispatcher),
// and detects song end to apply the song's playback mode (auto-advance or
// wait-for-trigger).
class AudioEngine final : public juce::AudioIODeviceCallback, private juce::ChangeListener {
public:
    AudioEngine();
    ~AudioEngine() override;

    juce::AudioDeviceManager& deviceManager() { return deviceManagerInstance; }
    CoreMidiDispatcher& midi() { return midiDispatcher; }
    EventDispatcher& events() { return eventDispatcher; }

    // Loads a .rsnraset and its global bus list, and (re)starts the
    // background streaming I/O thread against it. Does not stage any song's
    // tracks yet -- call selectSong() next. Returns false + fills `error` on failure.
    bool loadProject(const std::string& path, std::string& error);

    // Resets to a fresh, empty, unsaved Project (one default "Main" stereo
    // bus, no songs) so the app is immediately editable via the Builder.
    // Immediately backed by an auto-created draft archive in Application
    // Support (see isDraftProject()) so WAV/song-folder imports work right
    // away without forcing a manual Save As first -- only falls back to
    // "no archive at all" if the draft couldn't be created (e.g. disk full).
    void newProject(const std::string& name = "New Project");

    // Saves the live Project (and existing Audio/* stems) into a .rsnraset.
    // Stops playback/streaming, writes the archive, reopens it, and restages
    // the previously selected song when possible. If currently on a draft
    // archive and saving to a different path, PROMOTES the draft (moves the
    // archive to the new location, same as a normal "Save As" would expect --
    // subsequent edits go to the real file, not the invisible draft) rather
    // than leaving the draft as the active archive.
    bool saveProject(const std::string& path, std::string& error);
    // Non-blocking save: heavy archive write runs off the message thread so
    // the UI stays responsive. onComplete(success, error) is always invoked
    // on the message thread. isBusy() is true while a save is in flight.
    // Callers should set a "Saving…" status before calling this.
    void saveProjectAsync(const std::string& path,
                          std::function<void(bool success, std::string error)> onComplete);
    const std::string& projectPath() const { return loader.archivePath(); }

    bool hasAutosave(std::string& outTimestamp) const { return loader.hasAutosave(outTimestamp); }
    bool loadAutosave(std::string& error) { return loader.loadAutosave(error); }
    void clearAutosave() { loader.clearAutosave(); }

    // True until the user does a real Save As: the project is currently

    // backed by an auto-created draft archive in Application Support rather
    // than a location the user chose themselves. UI should treat this as
    // "unsaved" for prompting purposes even though projectPath() is non-empty.
    bool isDraftProject() const { return usingDraftArchive; }

    // Stages the given song's tracks for streaming and publishes its
    // routing. Stops playback first if currently playing. Fires the song's
    // triggerOnLoad events when fireOnLoadEvents is true (disabled for seek
    // restages so gear isn't re-programmed on every scrub). Precaches next song.
    bool selectSong(size_t songIndex, std::string& error, bool fireOnLoadEvents = true);

    // Gapless AutoplayNext handoff: promotes the precached next song without
    // going through Stop, restarts the timeline at 0, keeps PLAYING. Message
    // thread only (also invoked via callAsync right after an audio-thread
    // promote fails / for UI refresh after audio-thread promote succeeds).
    bool switchToSongGapless(size_t songIndex, std::string& error);

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

    // Aux-send matrix API (message thread). Takes an explicit songIndex --
    // NOT tied to whichever song happens to be staged/playing -- so editing
    // a song in the Builder can never corrupt a *different*, currently
    // staged song's live mix, and never silently no-ops just because the
    // edited song isn't the one currently playing. Only pushes a live
    // routing update (audible immediately) when songIndex == currentSongIndex();
    // otherwise it's a pure Project-data edit that takes effect next time
    // that song is staged.
    void setTrackSend(size_t songIndex, size_t trackIndex, size_t sendIndex, const TrackSendDef& send);
    void addTrackSend(size_t songIndex, size_t trackIndex, const TrackSendDef& send);
    void removeTrackSend(size_t songIndex, size_t trackIndex, size_t sendIndex);

    const Project& project() const { return loader.project(); }
    Project& project() { return loader.project(); }
    bool isProjectLoaded() const { return projectLoaded; }
    size_t currentSongIndex() const { return currentSong; }
    size_t busCount() const { return busses.size(); }
    const std::string& busIdAt(size_t index) const { return busses[index].id; }
    const std::string& busNameAt(size_t index) const;

    // Current STAGED song's track accessors (message thread). Empty if no
    // song staged. Index is relative to the staged song's track list --
    // for read-only display of the live/playing song (Mixer, web state),
    // NOT for editing arbitrary songs (use trackDefInSong() for that).
    size_t trackCount() const { return trackIdByIndex.size(); }
    const std::string& trackIdAt(size_t index) const { return trackIdByIndex[index]; }
    const TrackDef* trackDefAt(size_t index) const;
    TrackDef* trackDefAt(size_t index);

    // Project-data lookup for a specific song, independent of what's
    // currently staged/playing. Use this from the Builder, which edits
    // arbitrary songs regardless of playback state.
    const TrackDef* trackDefInSong(size_t songIndex, size_t trackIndex) const;
    TrackDef* trackDefInSong(size_t songIndex, size_t trackIndex);

    // Live mix controls: mutate Project fields for the given song and, only
    // if that song is the one currently staged, atomically republish a
    // routing snapshot so the change is audible immediately. Safe to call
    // for any song at any time -- editing a non-staged song only updates
    // Project data (see setTrackSend() doc above for the full rationale).
    void setTrackGainDb(size_t songIndex, size_t trackIndex, double gainDb);
    void setTrackPan(size_t songIndex, size_t trackIndex, double pan);
    void setTrackMute(size_t songIndex, size_t trackIndex, bool mute);
    void setTrackSolo(size_t songIndex, size_t trackIndex, bool solo);
    void setTrackMono(size_t songIndex, size_t trackIndex, bool mono);
    void setTrackBusId(size_t songIndex, size_t trackIndex, const std::string& busId);
    void setBusGainDb(size_t busIndex, double gainDb);
    void setBusMute(size_t busIndex, bool mute);
    void setBusSolo(size_t busIndex, bool solo);
    // Soloing the metronome joins the same solo group as track solo -- every
    // regular track goes silent exactly as if one of them had solo engaged
    // (see publishRoutingSnapshot()'s anyTrackSolo). Project-global, like
    // click gain/pan.
    void setClickSolo(bool solo);
    void setBusOutputChannel(size_t busIndex, int startChannel);
    // Full rebuild of routing from the current Project state (after Builder edits).
    void republishRouting();
    void refreshClickState();
    // Rebuild global bus list after Builder adds/removes busses (message thread).
    void rebuildBussesFromProject();
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

    // Imports a filesystem WAV into the open .rsnraset as Audio/<name>, points
    // the given song's track at it, rewrites the archive, reopens, restages
    // whatever song was playing before (independent of songIndex).
    //
    // Reads the source file and rewrites the archive (both slow disk I/O --
    // real stems run tens to hundreds of MB) on a background thread so the
    // message thread, and with it the whole UI, never blocks on an import.
    // onComplete fires on the message thread. Between calling this and
    // onComplete firing, isBusy() is true and the caller MUST NOT let any
    // other code touch this AudioEngine's project/loader state (BuilderPanel
    // disables further edits and shows a spinner) -- see
    // ProjectLoader::saveAsWithExtras's projectOverride parameter doc for why.
    void importWavForTrackAsync(size_t songIndex, size_t trackIndex, const std::string& filesystemPath,
                                std::function<void(bool success, std::string error)> onComplete);

    // Imports multiple stem WAV files at once in a single background pass into the container package.
    struct BatchItem {
        size_t trackIndex;
        std::string filesystemPath;
    };
    void importSongStemsBatchAsync(size_t songIndex, const std::vector<BatchItem>& items,
                                   std::function<void(bool success, std::string error)> onComplete);

    // Non-recursive scan of `folderPath` for .wav files (sorted by name, for
    // deterministic track order). Also attempts to detect a shared tempo for
    // the folder: first by looking for an embedded cue-point "Tempo: N"
    // label in each WAV (first match wins), falling back to a "120BPM"-style
    // token parsed from the folder name. `outDetectedBpm` stays 0.0 if
    // neither source found anything -- caller should offer a sane default.
    // Read-only: does not touch the project or archive. Fast (only reads
    // WAV headers/small metadata chunks, never full file bodies) -- safe to
    // call synchronously from the message thread, unlike the imports below.
    bool scanFolderForImport(const std::string& folderPath, std::vector<std::string>& outWavPaths,
                             double& outDetectedBpm, std::string& error) const;

    void importSongFromFolderAsync(const std::string& folderPath, const std::string& songName, double bpm,
                                   int tsNumerator, int tsDenominator,
                                   std::function<void(bool success, std::string error)> onComplete);

    // Unsaved changes / dirty state tracking for Logic Pro quit dialog & autosave
    bool hasUnsavedChanges() const { return unsavedChanges.load(std::memory_order_acquire); }
    void markDirty() {
        unsavedChanges.store(true, std::memory_order_release);
        if (projectLoaded) {
            std::string err;
            loader.saveAutosave(err);
        }
    }
    void clearDirty() { unsavedChanges.store(false, std::memory_order_release); }

    // True from the moment an async import starts until its onComplete

    // fires. UI should disable further project-editing actions and show a
    // busy/spinner indicator while this is true.
    bool isBusy() const {
        return busyImporting.load(std::memory_order_acquire)
               || busySaving.load(std::memory_order_acquire);
    }

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

    // Background-builds (or loads from the archive's Peaks/*.rpk cache)
    // peak overviews for every track in every song, not just the staged one.
    // Safe to call repeatedly/every tick -- it's a no-op once every file is
    // already cached, and only ever adds to the cache, so calling it again
    // after a Builder edit that adds a track is exactly how new files get
    // picked up.
    void ensureAllSongPeaksBuilt();

    MasterClock& masterClock() { return clock; }

    // Debug-only: makes the NEXT audio callback sleep for `milliseconds`
    // before doing any work, simulating a driver stall/underrun so the
    // fail-safe playhead behavior can be verified manually on real hardware.
    // Deliberately violates real-time-thread rules -- that's the point, it's
    // a manual test trigger, never called in normal operation.
    void simulateUnderrun(double milliseconds) { simulatedStallMs.store(milliseconds, std::memory_order_release); }

    // Per-bus / per-track telemetry for the UI to poll.
    const SeqLock<MeterFrame>* busMeterAt(size_t index) const;
    const SeqLock<MeterFrame>* trackMeterAt(size_t index) const;
    /** Peak of the metronome only (not the bus it is routed into). */
    const SeqLock<MeterFrame>* clickMeter() const { return &clickMeterFrame; }
    // Consume max click peak since the previous call (linear → MeterFrame dB).
    // Message-thread UI poll: a single audio-block impulse would otherwise be
    // overwritten by silence before the next 30 Hz sample, so the audio thread
    // accumulates interval max and this clears it.
    //
    // Each non-zero interval peak is also echoed for one extra poll so a single
    // skipped WS frame (client timer vs publish phase, or writePending drop)
    // cannot erase an audible tick from the wire. Still the true rendered
    // peak — not a post-silence display hold beyond that one-frame delivery
    // redundancy.
    MeterFrame consumeClickMeterInterval();

    bool isBusMuted(size_t busIndex) const;
    bool isBusSoloed(size_t busIndex) const;
    double busGainDb(size_t busIndex) const;

    const TransportTelemetry& transport() const { return transportTelemetry; }
    SystemHealth& health() { return systemHealth; }
    const SystemHealth& health() const { return systemHealth; }

    // juce::AudioIODeviceCallback
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;

private:
    juce::AudioDeviceManager deviceManagerInstance;

    ProjectLoader loader;
    MasterClock clock;
    RoutingEngine routing;
    StreamingEngine streaming;
    CoreMidiDispatcher midiDispatcher;
    EventDispatcher eventDispatcher;
    TransportTelemetry transportTelemetry;
    SystemHealth systemHealth;

    // Previous callback host time for underrun detection (audio thread only).
    uint64_t lastCallbackHostNanos = 0;

    std::vector<LoadedBus> busses; // global, built once per loadProject()
    std::unordered_map<std::string, size_t> busIndexById;

    std::vector<std::string> trackIdByIndex; // rebuilt per selectSong(); index matches RoutingSnapshot::TrackRoute::trackIndex
    // Audio-thread only dezippers for pan/gain/mono so live knob moves don't
    // hard-jump coefficients (clicks). Indexed by trackIndex * kSmoothBusSlots + busIndex
    // so main vs aux routes (different send gains) don't fight one smoother.
    static constexpr size_t kSmoothBusSlots = 32;
    struct TrackGainSmooth {
        float gL = 1.0f;
        float gR = 1.0f;
        float monoMix = 0.0f; // 0 = stereo, 1 = mono sum
        bool inited = false;
    };
    std::vector<TrackGainSmooth> trackGainSmooth;
    std::vector<std::unique_ptr<SeqLock<MeterFrame>>> busMeters;
    std::vector<LoudnessMeter> busLoudnessMeters;
    std::vector<std::unique_ptr<SeqLock<MeterFrame>>> trackMeters;
    std::vector<bool> busMuted; // mirror of project bus mute for quick UI reads
    std::vector<PeakOverview> trackPeaks;
    // Session-lifetime cache keyed by archive path (TrackDef::file), so
    // switching songs back and forth (Prev/Next, reselecting) doesn't
    // redecode the whole file every time just to redraw the same waveform --
    // only the on-disk PeakCache (Peaks/*.rpk, written on save) survived
    // across sessions before; this covers the common "haven't saved yet"
    // case within one run. Cleared on project load/import (file identity
    // may have changed).
    std::unordered_map<std::string, PeakOverview> peakOverviewSessionCache;
    mutable std::mutex peakCacheMutex; // guards peakOverviewSessionCache against background peak-build threads
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

    // Region::durationSeconds == 0 means "full file", not zero seconds -- for
    // that case the real length comes from the peak cache (same one
    // cachedPeaksForFile()/ensureAllSongPeaksBuilt() maintain project-wide),
    // not from raw region metadata. Returns 0.0 if that file hasn't been
    // peak-built yet (global timeline readout catches up once it is).
    double regionEffectiveDurationSeconds(const Region& r) const;
    // A song's authored length = the furthest region end across its tracks.
    double songAuthoredDurationSeconds(const SongDef& song) const;

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

    // Built-in click generator routing for the current song; disabled (-1)
    // unless the song has builtInClickEnabled and a resolvable target bus.
    ClickGenerator clickGenerator;
    int clickTargetBusIndex = -1;
    float clickGainLinear = 1.0f;
    float clickPan = 0.0f; // -1..+1, project-global
    // Dezippered click strip gains (audio thread only).
    float clickSmoothGL = 1.0f;
    float clickSmoothGR = 1.0f;
    bool clickSmoothInited = false;
    bool isClickEnabled = false;
    // Additional send destinations for the click (monitor mixes). Resolved
    // from song.builtInClickSends in refreshClickState(); parallel arrays.
    std::vector<int> clickSendBusIndices;
    std::vector<float> clickSendGainLinears;
    // Dezippered click SEND gains (audio thread only) -- parallel to
    // clickSendBusIndices/clickSendGainLinears, indexed by the same `si`.
    // Without this, a click send-gain change (or the track-send-style
    // "turn a knob up from the floor" move) was an unramped hard per-block
    // jump, unlike every other gain path here (track gain/pan/sends, and the
    // click's own main-bus target) which already go through an exponential
    // dezipper.
    struct ClickSendSmooth {
        float gL = 1.0f;
        float gR = 1.0f;
        bool inited = false;
    };
    std::vector<ClickSendSmooth> clickSendSmooth;
    std::vector<float> clickScratch;
    // Dedicated click strip meter (pre-bus mix); never shares the destination bus meter.
    SeqLock<MeterFrame> clickMeterFrame;
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
    bool usingDraftArchive = false; // see isDraftProject()
    std::atomic<bool> unsavedChanges{false};
    std::atomic<bool> busyImporting{false}; // see isBusy()
    std::atomic<bool> busySaving{false};    // see saveProjectAsync / isBusy()
    std::thread importThread; // joined before starting a new import, and in ~AudioEngine()
    std::thread saveThread;   // joined in ~AudioEngine / before a new save


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

    mutable std::recursive_mutex routingMutex;


    void ensureScratchSizes();
    void buildBusListFromProject();

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
    std::string lastKnownDeviceName;
};

} // namespace resoset
