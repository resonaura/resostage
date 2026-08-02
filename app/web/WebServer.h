#pragma once

#include <readerwriterqueue.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// Forward-declare libwebsockets types so the header stays lightweight.
struct lws_context;
struct lws;
struct lws_protocols;

namespace resostage {

// Remote-control actions enqueued by the web/HTTP thread and drained on the
// JUCE message thread (MainComponent timer). Never executed on the lws service
// thread itself -- that would race with AudioEngine/JUCE state.
enum class WebCommandKind : uint8_t {
    Play,
    // Pause -- freezes in place, resumed by Play (see AudioEngine::stop()'s
    // doc comment). Used by the Play/Pause toggle button + spacebar.
    Stop,
    // Dedicated "Stop" button -- see AudioEngine::stopToStart(): first press
    // rewinds the current song to its start, a second press (already there)
    // rewinds to the very start of the whole project.
    StopToStart,
    Next,
    Prev,
    SelectSong,
    // Mixer parity commands -- `arg` is the track/bus index (relative to the
    // currently-staged song for track commands), `value` is the new gain/pan
    // in dB/-1..1, or 0.0/1.0 for mute/solo booleans.
    SetTrackGain,
    SetTrackPan,
    SetTrackMute,
    SetTrackSolo,
    SetTrackMono,
    SetBusGain,
    SetBusMute,
    SetBusSolo,
    // Metronome solo -- joins the same solo group as SetTrackSolo (see
    // AudioEngine::setClickSolo()). `value` is the boolean (0.0/1.0), `arg`
    // unused.
    SetClickSolo,
    // Ableton-style per-track send routing -- `json` carries
    // {trackIndex, busId, gainDb}. Mirrors MixerPanel.cpp's onSendChanged:
    // find the track's existing TrackSendDef for busId and update its gain,
    // or create a new one if this is the first time this bus was sent to
    // (turning a knob up from its floor implicitly creates the send). Always
    // targets engine.currentSongIndex(), same as the other mixer commands.
    SetTrackSend,
    // Actually erases a track's TrackSendDef for a bus (as opposed to
    // SetTrackSend'ing its gain down to the UI's floor, which leaves the
    // send record in place) -- `json` carries {trackIndex, busId}. See
    // AudioEngine::removeTrackSend()/MainComponent::removeTrackSendFromJson().
    RemoveTrackSend,
    // Project lifecycle parity -- see app/web/WebServer.cpp's
    // isMixerCommandPath-style routing and MainComponent::drainWebCommands().
    // New/OpenLoadDialog/SaveProject/SaveProjectAs just call the exact same
    // methods the native top-bar buttons call (message-thread only, may pop
    // a native FileChooser/dialog in the same on-screen app window -- fine
    // when the request came from the embedded webview, since that's the same
    // window). LoadProjectFromPath and ExportProjectForDownload exist for
    // the "plain browser, no native dialog available" path instead: a
    // remote/tab client uploads bytes to a temp file (path carried in
    // WebCommand::path) or asks the app to write the current project to a
    // temp file it can then download over HTTP.
    NewProject,
    OpenLoadDialog,
    SaveProject,
    SaveProjectAs,
    LoadProjectFromPath,
    ExportProjectForDownload,
    // Open Recent parity -- `path` carries the absolute .rsnraset path from
    // AppSettings::recentProjects. Unlike LoadProjectFromPath (which deletes
    // its temp file on failure -- it only ever points at a throwaway browser
    // upload), a stale recent entry is a real user file the app never owns:
    // on failure it's just dropped from the recent list, never touched on
    // disk. See MainComponent::loadProjectFromPath()/rememberRecentProject().
    OpenRecentProject,
    ClearRecentProjects,
    // Renames the loaded project directly (`json` carries {name}) -- unlike
    // Save/SaveAs, this doesn't touch the file on disk, just Project::name.
    // Exists so the project's displayed name is never *only* an implicit
    // side effect of whichever file path a save dialog happened to produce
    // (which a plain-browser "download" Save As can't drive at all, since
    // JS never learns what filename the user picked in the OS's own save
    // sheet) -- the header's name field is directly editable instead. See
    // MainComponent::setProjectNameFromJson().
    SetProjectName,
    // Builder structural-edit parity -- one kind per BuilderPanel operation
    // (Songs/Tracks/Busses/Events x Add/Remove/Move/Update). `json` carries
    // the raw POST body verbatim; WebServer does no field parsing for these,
    // it's all done message-thread-side in MainComponentBuilder.cpp (mirrors
    // BuilderPanel.cpp's own addItem/removeItem/moveItem/apply*Settings
    // logic almost line for line, just JSON-driven instead of widget-driven).
    BuilderSongAdd,
    BuilderSongImportFolder,
    BuilderSongRemove,
    BuilderSongMove,
    BuilderSongUpdate,
    BuilderTrackAdd,
    BuilderTrackRemove,
    BuilderTrackMove,
    BuilderTrackUpdate,
    // Two-step WAV import (mirrors the ExportProjectForDownload handshake
    // rather than reusing LoadProjectFromPath's single-shot upload): Begin
    // stashes {songIndex, trackIndex} from a small JSON POST in WebServer
    // (see beginTrackImport()), then Upload's raw-byte POST is handled the
    // same way project upload is (streamed straight to a temp file, no size
    // cap) and just needs to recall which track it was for.
    BuilderTrackImportWavBegin,
    BuilderTrackImportWavUpload,
    BuilderRegionAdd,
    BuilderRegionRemove,
    BuilderRegionUpdate,
    BuilderBusAdd,
    BuilderBusRemove,
    BuilderBusMove,
    BuilderBusUpdate,
    BuilderEventAdd,
    BuilderEventRemove,
    BuilderEventMove,
    BuilderEventUpdate,
    // Song structural markers (Intro/Verse/Chorus/.../custom) -- identity is
    // by `sectionId` (like regions), not positional index (like events),
    // since repositioning is just a startSeconds update, not a swap. See
    // MainComponentBuilder.cpp's builderSection*().
    BuilderSectionAdd,
    BuilderSectionRemove,
    BuilderSectionUpdate,
    // Lighting parity -- see RESTORE_POINT.md Feature 6 and
    // MainComponentLighting.cpp (mirrors the Builder handlers above:
    // `json` carries the raw POST body, field parsing happens
    // message-thread-side). SetLightingConfig also auto-resizes
    // LightingConfig::fixtures to match a changed resoLightColumns/Rows
    // (see MainComponentLighting.cpp's regenerateResoLightFixtures()) --
    // LightFixtureUpdate then edits an individual fixture's real position/
    // LED count/addressable flag from there (3D editor drag, settings-card
    // per-fixture fields). LightCue has no Move -- like Region/Section,
    // repositioning is just a startSeconds field in Update.
    SetLightingConfig,
    LightFixtureUpdate,
    LightTrackAdd,
    LightTrackRemove,
    LightTrackMove,
    LightTrackUpdate,
    LightCueAdd,
    LightCueRemove,
    LightCueUpdate,
    // Timeline undo/redo (regions + sections of the currently loaded
    // project). No JSON body needed. See ProjectHistory / AudioEngine::
    // undoTimelineEdit()/redoTimelineEdit().
    TimelineUndo,
    TimelineRedo,
    // Settings parity -- audio device/sample-rate/buffer-size, MIDI I/O
    // device selection, keybindings. Same raw-JSON-passthrough routing as
    // the Builder commands above; handled in MainComponentSettings.cpp.
    SetAudioOutputDevice,
    SetSampleRate,
    SetBufferSize,
    SetMidiOutput,
    SetMidiInput,
    // Toggles CoreMidiDispatcher's virtual "ResoStage Sync" MIDI source on/
    // off (see its doc comment) -- `json` carries { "enabled": bool }.
    SetMidiVirtualPort,
    SetKeybinding,
    SetOutputChannels,
    // MIDI learn / clear for a named action (see Project::midiMappings).
    // Learn arms the next Note On / CC from the remote input; Clear drops
    // any existing mapping for that action. Both take JSON { "action": "..." }.
    MidiLearn,
    MidiLearnCancel,
    MidiClear,
    // Timeline parity -- `value` is the target position in seconds. Mirrors
    // TimelineView.cpp's click/drag-to-seek (see AudioEngine::seekToSeconds);
    // the frontend throttles drag updates itself, same reason TimelineView's
    // own doc comment gives (seek restages the song, so hammering it on
    // every mouse-move would be wasteful).
    Seek,
    // Answers the in-webview "Unsaved Changes" quit prompt (see
    // WebUiState::quitConfirmPending / MainComponent::confirmQuitIfUnsaved).
    // `arg`: 0 = Cancel, 1 = Save, 2 = Don't Save.
    QuitDecision,
    UiFocusState,
};

struct WebCommand {
    WebCommandKind kind = WebCommandKind::Stop;
    int arg = 0;        // SelectSong index, or track/bus index for mixer commands
    double value = 0.0; // gain (dB) / pan (-1..1) / bool (0.0 or 1.0) depending on kind
    std::string path;   // LoadProjectFromPath / BuilderTrackImportWavUpload: temp file path
    std::string json;   // Builder*: raw POST body, parsed message-thread-side
};

// Snapshot of everything the SPA needs, written by the message thread (~30 Hz)
// and read by the web server thread when serializing WebSocket frames / REST.
// Strings are plain std::string under a mutex -- this path is never on the
// audio callback.
struct WebUiState {
    std::string projectName;
    // Project-global metronome level (dB). Same for every song.
    double clickGainDb = -6.0;
    // Project-global metronome pan (-1..+1).
    double clickPan = 0.0;
    // Metronome solo -- joins the same solo group as track solo (see
    // AudioEngine::setClickSolo()).
    bool clickSolo = false;
    // Metronome-only peak (not the destination bus). Mono source → L=R.
    float clickPeakDb = -144.0f;
    float clickPeakDbL = -144.0f;
    float clickPeakDbR = -144.0f;
    // Stream feeder health (min ring / RAM-resident stems).
    double streamBufferMinSec = 0.0;
    double streamBufferAvgSec = 0.0;
    int streamResidentTracks = 0;
    int streamStreamingTracks = 0;
    bool streamBufferUrgent = false;
    double streamResidentMiB = 0.0;
    std::string songName;
    double playheadSeconds = 0.0;
    // Cumulative whole-project position (AudioEngine::globalPlayheadSeconds/
    // globalBeatsElapsed) -- unlike playheadSeconds above, this does not
    // reset at song boundaries. Freezes on pause/stop like playheadSeconds does.
    double globalPlayheadSeconds = 0.0;
    double globalBeatsElapsed = 0.0;
    double sampleRate = 48000.0;
    double driftFactor = 1.0;
    double bpm = 0.0;
    bool playing = false;
    bool hardwareAlarm = false;
    int songIndex = -1;
    int songCount = 0;
    // Mirrors MainComponent's bottom status bar text -- the web UI's only
    // window into the result of a fire-and-forget command (project loaded ok,
    // save failed, etc.) since REST POSTs here don't wait for the outcome.
    std::string statusMessage;
    // Bumped every time MainComponent::performAction() actually executes a
    // recognized action -- native hotkey, MIDI, and the macOS menu bar all
    // funnel through that one method, so this single pair covers all three
    // input paths. The web UI (settings indicator dots) compares lastAction
    // against each binding row to flash only the one that fired, using
    // lastActionNonce to detect repeats of the same action.
    std::string lastAction;
    int lastActionNonce = 0;

    // Mirrors AudioEngine::isBusy() -- true during an async WAV/folder
    // import. The web UI disables Builder edits while this is set, same as
    // the native BusyOverlay blocking all input.
    bool busy = false;
    // True while MainComponent::confirmQuitIfUnsaved() is waiting on the
    // user's Save/Don't Save/Cancel answer -- the web UI shows a ConfirmDialog
    // and replies with WebCommandKind::QuitDecision.
    bool quitConfirmPending = false;
    // Mode-switch request for the web UI tabs (player/mixer/editor/settings).
    // Set by performAction("mode_*") from keyboard or MIDI; uiTabSeq bumps on
    // every request so re-selecting the active tab still fires a React effect.
    std::string uiTab;
    uint64_t uiTabSeq = 0;
    // Timeline undo/redo availability + a human label for the step that
    // would be applied (e.g. "Move region") -- lets the web UI show
    // disabled/enabled undo/redo buttons with a tooltip. See
    // AudioEngine::canUndoTimeline()/undoTimelineLabel() etc.
    bool canUndo = false;
    bool canRedo = false;
    std::string undoLabel;
    std::string redoLabel;

    struct SongRow {
        std::string name;
        double bpm = 120.0;
        bool autoplay = false;

        // Full per-song structure for the Builder editor -- unlike `tracks`/
        // `busses` below (which mirror only the *currently-staged* song, for
        // Player/Mixer), this covers every song so Builder can edit any of
        // them without staging it first. Populated straight from
        // engine.project().songs[i], not through the staged-song-scoped
        // AudioEngine accessors.
        int tsNum = 4;
        int tsDen = 4;
        bool click = false;
        std::string clickBusId;
        double clickGainDb = -6.0;
        // click sends: extra buses (aux monitor mixes) the metronome feeds.
        struct ClickSendRow { std::string busId; double gainDb = 0.0; bool enabled = true; };
        std::vector<ClickSendRow> clickSends;

        struct TrackRow {
            std::string id;
            std::string name;
            std::string busId;
            std::string file;
            double gainDb = 0.0;
            double pan = 0.0;
            bool mute = false;
            bool solo = false;
            int sendsCount = 0;
        };
        std::vector<TrackRow> tracks;

        struct RegionRow {
            std::string id;
            std::string trackId;
            std::string file;
            double startSeconds = 0.0;
            double sourceOffsetSeconds = 0.0;
            double durationSeconds = 0.0;
            double gainDb = 0.0;
            double fadeInSeconds = 0.0;
            double fadeOutSeconds = 0.0;
            double fadeInCurve = 0.0;
            double fadeOutCurve = 0.0;
            bool loop = false;
            double loopLengthSeconds = 0.0;
        };
        std::vector<RegionRow> regions;

        struct EventRow {
            std::string id;
            std::string type; // "programChange" | "cc" | "noteOn" | "noteOff" | "http" | "dmx"
            double timeSeconds = 0.0;
            bool triggerOnLoad = false;
            double latencyMs = 0.0;
            int midiChannel = 1;
            int midiProgram = 0;
            int midiCC = 0;
            int midiCCValue = 0;
            int midiNote = 60;
            int midiVelocity = 100;
            std::string httpUrl;
        };
        std::vector<EventRow> events;

        // Structural markers (Intro/Verse/Chorus/Bridge/Outro/Solo/custom) --
        // mirrors the native TimelineView.cpp's section-marker ruler. Points,
        // not ranges: the region a marker covers is implicitly "from here to
        // the next marker (or song end)".
        struct SectionRow {
            std::string id;
            std::string name;
            double startSeconds = 0.0;
            int colorIndex = 0;
        };
        std::vector<SectionRow> sections;

        // Light cues placed on this song's Light timeline -- mirrors
        // SectionRow's relationship above (color/intensity JSON-friendly
        // as 0-255 ints, not the engine's uint8_t).
        struct LightCueRow {
            std::string id;
            std::string trackId;
            double startSeconds = 0.0;
            double durationSeconds = 1.0;
            int colorR = 255;
            int colorG = 255;
            int colorB = 255;
            double intensity = 1.0;
            double fadeInSeconds = 0.0;
            double fadeOutSeconds = 0.0;
            std::string label;
            // Audio-reactive effect -- see LightCue's own field docs in
            // ProjectSchema.h. Read back here (not just write-only via the
            // cueUpdate command) so the effect panel reflects the real
            // stored value instead of resetting to defaults every time the
            // selection changes.
            std::string effectType;
            std::string effectSourceType;
            std::string effectSourceId;
            double effectIntensity = 0.8;
            bool tempoSync = false;
            std::string tempoSubdiv;
            double effectRateHz = 2.0;
            std::string gradientPreset;
            std::string gradientColors;
            // "normal" | "additive" | "multiply" | "difference" | "lighten"
            // | "subtractive" -- see engine/lighting/LightBlend.h. Only
            // meaningful when this cue's fixture is also driven by another
            // LightTrack active at the same instant.
            std::string blendMode;
        };
        std::vector<LightCueRow> lightCues;
    };
    std::vector<SongRow> songs;

    struct MeterRow {
        std::string id;
        float peakDb = -144.0f;
        float peakDbL = -144.0f;
        float peakDbR = -144.0f;
        float shortTermLufs = -144.0f;
    };
    std::vector<MeterRow> meters;

    struct TrackRow {
        std::string id;
        std::string name;
        std::string busId;
        double gainDb = 0.0;
        double pan = 0.0;
        bool mute = false;
        bool solo = false;
        bool mono = false;
        struct SendRow {
            std::string busId;
            double gainDb = 0.0;
        };
        std::vector<SendRow> sends;
        float peakDb = -144.0f;
        float peakDbL = -144.0f;
        float peakDbR = -144.0f;
    };
    std::vector<TrackRow> tracks;

    struct BusRow {
        std::string id;
        std::string name;
        double gainDb = 0.0;
        bool mute = false;
        bool solo = false;
        bool isAux = false;
        int startChannel = 0;
        int channels = 2;
        float peakDb = -144.0f;
        float peakDbL = -144.0f;
        float peakDbR = -144.0f;
    };
    std::vector<BusRow> busses;

    // Lighting rig config + fixture roster -- see RESTORE_POINT.md Feature 6
    // and engine/project/ProjectSchema.h's LightingConfig/LightFixture.
    // Project-scoped (mirrors proj.lighting), unlike AppSettings' rig-wide
    // audio/MIDI fields in SettingsRow below.
    struct LightFixtureRow {
        std::string id;
        std::string name;
        std::string kind; // "resoLightBar" | "dmxGeneric"
        int gridColumn = 0;
        int gridRow = 0;
        int ledCount = 120;
        bool addressable = true;
        double posX = 0.0;
        double posY = 0.0;
        double posZ = 0.0;
        double rotationYDeg = 0.0;
        bool mountedHorizontally = false;
        int dmxUniverse = 0;
        int dmxStartChannel = 1;
        int dmxChannelCount = 3;
    };
    struct LightingRow {
        bool enabled = false;
        std::string kind = "none"; // "none" | "resoLight" | "dmxGeneric"
        int resoLightColumns = 2;
        int resoLightRows = 1;
        std::vector<LightFixtureRow> fixtures;
    };
    LightingRow lighting;

    struct LightTrackRow {
        std::string id;
        std::string name;
        std::vector<std::string> fixtureIds;
    };
    std::vector<LightTrackRow> lightTracks;

    // Backend-authoritative resolved lamp state, one row per fixture
    // currently driven by an active cue -- computed by the exact same
    // engine/lighting/LightOutputResolver.h call LightEngine's real-time DMX
    // thread uses, at the ~30Hz WebUiState publish rate. The live preview
    // (Settings' 3D editor, Timeline's Light mode) renders THIS, not its own
    // re-simulation, so it can never show something the real hardware isn't
    // also doing (see RESTORE_POINT.md Feature 6's sync fix).
    struct LightOutputRow {
        std::string fixtureId;
        int r = 0;
        int g = 0;
        int b = 0;
        double intensity = 0.0;
        double meterLevel01 = 0.0; // 0 unless the active cue's effect is Meter
        std::string gradientPreset; // "solid" | "greenYellowRed"
        // Effect identity + phase for addressable fixtures with a spatial
        // per-LED pattern (Converge, GradientFlow) -- "none"/0 otherwise.
        // The frontend ports the identical addressableEffectLedColor math
        // (see ui/src/lib/lightCueInterpolation.ts) so the preview's
        // per-LED rendering matches the real DMX output without shipping a
        // full per-LED color array over the wire every frame.
        std::string effectType = "none";
        double effectTSec = 0.0;
        double effectRateHz = 2.0;
    };
    std::vector<LightOutputRow> lightOutput;

    // Health -- combined totals across all app-related processes.
    double cpuPercent = 0.0;
    uint64_t rssBytes = 0;
    uint64_t freeBytes = 0;
    uint64_t underrunCount = 0;
    uint64_t audioCallbackCount = 0;
    int webClientCount = 0;
    // Per-process resource breakdown.
    struct ProcessEntry {
        int pid = 0;
        std::string name;
        uint64_t rssBytes = 0;
        double cpuPercent = 0.0;
    };
    std::vector<ProcessEntry> processes;

    // Settings parity -- mirrors SettingsPanel.cpp's AudioDeviceSelectorComponent
    // + MIDI I/O pickers + keybinding rows. Populated from juce::
    // AudioDeviceManager/CoreMidiDispatcher/CoreMidiInputListener/Project::
    // keybindings in MainComponent::publishWebState(), all message-thread-only
    // reads (JUCE device manager API isn't safe to touch from the lws thread).
    struct SettingsRow {
        std::string currentOutputDevice;
        std::vector<std::string> outputDevices;
        double sampleRate = 0.0;
        std::vector<double> availableSampleRates;
        int bufferSize = 0;
        std::vector<int> availableBufferSizes;
        // Per-physical-channel activation (interfaces with >2 outputs can
        // route different busses to different channel pairs) -- mirrors
        // AudioDeviceSelectorComponent's channel checkbox list.
        std::vector<std::string> outputChannelNames;
        std::vector<bool> activeOutputChannels;
        std::vector<std::string> midiOutputs;
        std::vector<std::string> midiInputs;
        // Whether CoreMidiDispatcher's "ResoStage Sync" virtual source (see
        // CoreMidiDispatcher::hasVirtualSource()) is currently enabled --
        // lets a DAW pick it as a MIDI In to test clock/transport sync
        // without any hardware or IAC bus setup.
        bool virtualMidiPortEnabled = false;
        struct Keybinding {
            std::string action;
            std::string key;
        };
        std::vector<Keybinding> keybindings;
        // Per-action MIDI remote bindings (Project::midiMappings, keyed by
        // action for the Settings UI). channel 0 = any channel.
        struct MidiBinding {
            std::string action;
            std::string trigger; // "note" | "cc"
            int channel = 0;
            int number = 0;
        };
        std::vector<MidiBinding> midiBindings;
        // Non-empty while the web UI has armed MIDI-learn for this action.
        std::string midiLearnAction;
        // Rig-wide MRU project list (AppSettings::recentProjects), most-recent-first.
        struct RecentProject {
            std::string path;
            std::string displayName;
            std::string lastOpenedIso;
        };
        std::vector<RecentProject> recentProjects;
    };
    SettingsRow settings;
};

// Embedded HTTP + WebSocket server (libwebsockets).
//
// - Serves the SPA from memory (EmbeddedAssets) -- no filesystem, no Node.
// - REST: POST /api/v1/transport/{play,stop,next,prev,select}
// - WS:   /ws  (text JSON telemetry ~30 FPS)
// - GET:  /api/v1/state  (one-shot JSON snapshot, same schema as WS)
//
// Threading: owns a dedicated service thread running lws_service(). HTTP/WS
// callbacks only enqueue WebCommands and read a mutex-protected WebUiState
// copy. Audio thread is never blocked by this server.
class WebServer {
public:
    WebServer();
    ~WebServer();

    WebServer(const WebServer&) = delete;
    WebServer& operator=(const WebServer&) = delete;

    // Binds 0.0.0.0:port so LAN tablets can connect. Returns false + error on failure.
    bool start(uint16_t port, std::string& error);
    void stop();

    bool isRunning() const { return running.load(std::memory_order_acquire); }
    uint16_t port() const { return boundPort.load(std::memory_order_relaxed); }
    int clientCount() const { return clients.load(std::memory_order_relaxed); }

    // Last SPA tab reported by a WS client via {"view":"mixer"} (player/mixer/
    // editor/settings). Used to keep the Touch Bar highlight in sync with the
    // embedded web UI. Empty if never set.
    std::string lastClientView() const;
    void noteClientView(const std::string& view);

    // Message-thread: publish the latest UI snapshot for remote clients.
    // Pre-serializes one JSON blob per SPA view so the WS thread only copies
    // a string at a fixed cadence (no rebuild/lock contention on send).
    void publishState(const WebUiState& state);

    // Target outbound WS telemetry rate (Hz) -- the ceiling clients start at
    // and recover back toward. Actual per-client rate is adaptive: see
    // resosetWsCallback's LWS_CALLBACK_TIMER handler in WebServer.cpp, which
    // backs a client off toward kTelemetryMinHz under sustained write
    // backpressure (frontend too slow to drain the socket, or the network/
    // backend can't keep up) and recovers only after a long clean streak, so
    // the rate doesn't oscillate ("float") under borderline conditions.
    //
    // 60 Hz halves the maximum telemetry lag vs. 30 Hz (17 ms vs. 33 ms),
    // which matters for peaks (click/track) and the live light preview.
    // The min floor stays at 6 Hz so backpressure recovery is unchanged.
    static constexpr int kTelemetryHz = 60;
    static constexpr int kTelemetryPeriodUs = 1'000'000 / kTelemetryHz;
    static constexpr int kTelemetryMinHz = 6;
    static constexpr int kTelemetryMinPeriodUs = 1'000'000 / kTelemetryMinHz;

    // Effective rate of the most recently (re)throttled client, in Hz --
    // embedded into the telemetry frame as "wsHz" so the UI can show the
    // real current update rate instead of just assuming the fixed target.
    int effectiveTelemetryHz() const { return effectiveTelemetryHz_.load(std::memory_order_relaxed); }
    void reportClientPeriodUs(int periodUs);

    // Message-thread: drain one remote command (if any). Returns false if empty.
    bool pollCommand(WebCommand& out);

    // Optional: fired from the HTTP/WS thread after enqueueing a latency-
    // sensitive command (SelectSong / Play / Stop / Next / Prev / Seek).
    // MainComponent uses this to callAsync(drain) so song hops don't wait
    // for the next 30 Hz timer tick (~0–33 ms of dead latency).
    void setUrgentCommandHook(std::function<void()> hook) { urgentCommandHook = std::move(hook); }

    // Message-thread: browser-download handshake for ExportProjectForDownload
    // (see WebCommandKind). beginExport() invalidates any previous export
    // before enqueueing the new one so a racing GET .../export-status can't
    // observe a stale "ready". complete/fail report the outcome once the
    // message thread has actually written the temp file.
    void beginExport();
    void completeExport(std::string filePath, std::string fileName);
    void failExport();

    // HTTP-thread: stash which track a following .../import-wav/upload POST
    // is for, plus the original filename (so the archive entry ends up
    // "Audio/kick.wav" instead of a generic temp name) -- see
    // WebCommandKind::BuilderTrackImportWavBegin/Upload.
    void beginTrackImport(int songIndex, int trackIndex, std::string fileName);
    void takeTrackImportTarget(int& songIndex, int& trackIndex, std::string& fileName);

    // Message-thread: publish the current song's per-track peak-overview
    // JSON (see MainComponent::buildPeaksJson()). Kept separate from the
    // ~30Hz WebUiState broadcast -- peak arrays are large (up to 4096 floats
    // per track) and only change when the staged song changes, so pushing
    // them through the WS stream on every frame would waste bandwidth for no
    // reason. Served on demand via GET /api/v1/player/peaks instead.
    void publishPeaks(std::string json);

    // Message-thread: same idea as publishPeaks(), but for the continuous
    // multi-song timeline's peak data (every song's tracks, not just the
    // currently-staged one -- see MainComponent::buildAllPeaksJson()). Kept
    // as its own endpoint/cache rather than folded into publishPeaks() since
    // it's a strictly larger payload and only the timeline screen needs it
    // (Player/Mixer only ever look at the current song). Served on demand
    // via GET /api/v1/player/peaks-all.
    void publishAllPeaks(std::string json);

    // Message-thread: keep the currently open project's archive path mirrored
    // here so the HTTP service thread can open its own independent
    // ProjectLoader for on-demand raw-sample fetches (see serveWaveformRaw())
    // without ever touching AudioEngine's loader -- same "separate reader on
    // the same file" pattern AudioEngine's background peak builds use.
    void publishArchivePath(std::string path);

private:
    friend int resosetHttpCallback(struct lws* wsi, int reason, void* user, void* in, size_t len);
    friend int resosetWsCallback(struct lws* wsi, int reason, void* user, void* in, size_t len);

    void serviceLoop();
    // `view` filters the snapshot to the SPA tab the client is showing
    // (player/mixer/editor/settings). Transport/time/status always included.
    // Empty / "all" → full snapshot (REST /api/v1/state).
    std::string buildStateJson(const char* view = nullptr) const;
    // lws thread: grab prebuilt frame for a view (empty if none yet).
    std::shared_ptr<const std::string> cachedFrameForView(const char* view) const;
    std::shared_ptr<const std::vector<uint8_t>> cachedBinaryFrame() const;
    void enqueueCommand(WebCommand cmd);
    bool handleHttpApi(struct lws* wsi, const char* path, const char* method, const char* body, size_t bodyLen);
    int serveStatic(struct lws* wsi, const char* path);
    int serveExportStatus(struct lws* wsi);
    int serveExportDownload(struct lws* wsi);
    int servePeaks(struct lws* wsi);
    int serveAllPeaks(struct lws* wsi);
    int serveWaveformRaw(struct lws* wsi, const char* queryArgs);

    // Called only from the lws service thread.
    void onClientOpened();
    void onClientClosed();
    void broadcastWritable();

    struct lws_context* context = nullptr;
    std::thread serviceThread;
    std::atomic<bool> running{false};
    std::atomic<bool> stopRequested{false};
    std::atomic<uint16_t> boundPort{0};
    std::atomic<int> clients{0};
    // See reportClientPeriodUs()/effectiveTelemetryHz() -- last-reported
    // per-client send period, mirrored here as Hz for the telemetry frame.
    std::atomic<int> effectiveTelemetryHz_{kTelemetryHz};
    std::function<void()> urgentCommandHook;

    mutable std::mutex stateMutex;
    WebUiState state;

    // Pre-serialized frames, rebuilt in publishState() on the message thread.
    // WS service thread only does shared_ptr copy + lws_write — no ostringstream.
    struct FrameCache {
        std::shared_ptr<const std::string> player;
        std::shared_ptr<const std::string> mixer;
        std::shared_ptr<const std::string> editor;
        std::shared_ptr<const std::string> settings;
        std::shared_ptr<const std::string> all; // REST full snapshot
        std::shared_ptr<const std::vector<uint8_t>> binary; // High-frequency telemetry (binary)
        uint64_t generation = 0;
    };
    mutable std::mutex frameMutex;
    FrameCache frames;

    // SPA tab last reported by embedded/remote clients (message-thread read).
    // Empty until the first {"view":...} — do not default to "player" or the
    // Touch Bar will keep fighting real tab switches.
    mutable std::mutex clientViewMutex;
    std::string clientView;

    moodycamel::ReaderWriterQueue<WebCommand> commands{64};

    mutable std::mutex exportMutex;
    bool exportReady = false;
    std::string exportFilePath;
    std::string exportFileName;

    mutable std::mutex importMutex;
    int pendingImportSongIndex = -1;
    int pendingImportTrackIndex = -1;
    std::string pendingImportFileName;

    mutable std::mutex peaksMutex;
    std::string peaksJson = "{\"tracks\":[]}";

    mutable std::mutex allPeaksMutex;
    std::string allPeaksJson = "{\"songs\":[]}";

    mutable std::mutex archivePathMutex;
    std::string archivePathForRaw;

    // Per-session WS bookkeeping lives in the .cpp (opaque to callers).
    // The service thread owns a linked list of live WS sessions via user data.
};

} // namespace resostage
