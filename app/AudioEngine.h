#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_events/juce_events.h>

#include "audio/ClickGenerator.h"
#include "audio/Metering.h"
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
    const std::string& projectPath() const { return loader.archivePath(); }

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
    // thread only. Gap is bounded by the caller's poll interval (~1 frame at
    // 30–60 Hz when the next song was already precached).
    bool switchToSongGapless(size_t songIndex, std::string& error);

    void play();
    void stop();
    bool isPlaying() const { return playing.load(std::memory_order_acquire); }

    // Seeks the current song to `seconds` (clamped to [0, song length]).
    // Restages streams so both forward and backward seeks are correct, then
    // resumes playback if it was running. Message-thread only.
    bool seekToSeconds(double seconds, std::string& error);

    // Message-thread-only: true when the audio thread finished a song in
    // AutoplayNext mode. Prefer consumeGaplessAdvance + switchToSongGapless.
    bool consumeAutoAdvancePending() { return autoAdvancePending.exchange(false, std::memory_order_acq_rel); }
    bool consumeGaplessAdvance(size_t& outSongIndex);

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
    void setTrackBusId(size_t songIndex, size_t trackIndex, const std::string& busId);
    void setBusGainDb(size_t busIndex, double gainDb);
    void setBusMute(size_t busIndex, bool mute);
    void setBusSolo(size_t busIndex, bool solo);
    void setBusOutputChannel(size_t busIndex, int startChannel);
    // Full rebuild of routing from the current Project state (after Builder edits).
    void republishRouting();
    void refreshClickState();
    // Rebuild global bus list after Builder adds/removes busses (message thread).
    void rebuildBussesFromProject();
    double currentSongLengthSeconds() const;

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

    // Creates a new song from every .wav file directly inside `folderPath`
    // (one track per file, filename minus extension/tempo-suffix as the
    // track name, routed to the project's first bus), imports all the audio
    // into the archive in a single combined rewrite, and appends the song to
    // the project. Requires the project to already be saved at least once
    // (same requirement as importWavForTrackAsync -- there must be an
    // archive to write audio into). Restages whatever song was playing
    // before, if any. Same background-thread/isBusy() contract as
    // importWavForTrackAsync above (reading N large WAV files and rewriting
    // the archive is even slower than a single-track import).
    void importSongFromFolderAsync(const std::string& folderPath, const std::string& songName, double bpm,
                                   int tsNumerator, int tsDenominator,
                                   std::function<void(bool success, std::string error)> onComplete);

    // True from the moment an async import starts until its onComplete
    // fires. UI should disable further project-editing actions and show a
    // busy/spinner indicator while this is true.
    bool isBusy() const { return busyImporting.load(std::memory_order_acquire); }

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

    size_t currentSong = 0;
    int64_t currentSongLengthFrames = 0; // 0 = unknown/no tracks

    // Underrun micro-fade (spec: 128-sample fade-out on dropout, fade-in on recovery).
    static constexpr int kUnderrunFadeSamples = 128;
    int underrunFadeOutRemaining = 0;
    int recoveryFadeInRemaining = 0;
    bool lastCallbackWasUnderrun = false;

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
    bool isClickEnabled = false;
    // Additional send destinations for the click (monitor mixes). Resolved
    // from song.builtInClickSends in refreshClickState(); parallel arrays.
    std::vector<int> clickSendBusIndices;
    std::vector<float> clickSendGainLinears;
    std::vector<float> clickScratch;
    std::vector<uint8_t> eventFiredFlags; // parallel to current song's events; reset per selectSong()/play()
    std::atomic<bool> autoAdvancePending{false};
    std::atomic<int> pendingGaplessSong{-1}; // >=0 => message thread should gapless-switch
    std::vector<ProjectLoader::ExtraFile> pendingPeakCacheExtras;

    std::atomic<bool> playing{false};
    std::atomic<int64_t> hwSamplePosition{0};
    std::atomic<double> simulatedStallMs{0.0};

    double currentSampleRate = 48000.0;
    int currentBlockSize = 512;
    bool projectLoaded = false;
    bool usingDraftArchive = false; // see isDraftProject()
    std::atomic<bool> busyImporting{false}; // see isBusy()
    std::thread importThread; // joined before starting a new import, and in ~AudioEngine()

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
