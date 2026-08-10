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
    SetBusPan,
    SetBusMute,
    SetBusSolo,
    // Metronome solo -- joins the same solo group as SetTrackSolo (see
    // AudioEngine::setClickSolo()). `value` is the boolean (0.0/1.0), `arg`
    // unused.
    SetClickSolo,
    // Ableton-style per-track send routing -- `json` carries
    // {trackIndex, busId, gainDb}. Mirrors MixerPanel.cpp's onSendChanged:
    // find the track's existing send row for busId and update its level
    // (gainDb is converted to the schema's 0-100 SendConfig::level), or
    // create a new one if this is the first time this bus was sent to
    // (turning a knob up from its floor implicitly creates the send). Always
    // targets engine.currentSongIndex(), same as the other mixer commands.
    SetTrackSend,
    // Actually erases a track's send row for a bus (as opposed to
    // SetTrackSend'ing its gain down to the UI's floor, which leaves the
    // send record in place) -- `json` carries {trackIndex, busId}. See
    // AudioEngine::removeTrackSend()/MainComponent::removeTrackSendFromJson().
    RemoveTrackSend,
    // Project lifecycle parity -- see app/server/WebServer.cpp's
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
    BuilderSongEnd,
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
    // Native "Open Audio File" picker (embedded webview only -- pencil-tool
    // import): `json` carries {songIndex, index} parsed message-thread-side;
    // MainComponent pops a JUCE FileChooser and imports the picked file
    // straight from disk (no upload step).
    BuilderTrackImportWavDialog,
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
    // Per-song Logic-style cycle locators (active/skip/left/right). Identity is
    // the song itself -- one cycle range per SongDef, persisted even when
    // inactive. See MainComponentBuilder.cpp's builderCycleUpdate().
    BuilderCycleUpdate,
    // Lighting parity -- see RESTORE_POINT.md Feature 6 and
    // MainComponentLighting.cpp (mirrors the Builder handlers above:
    // `json` carries the raw POST body, field parsing happens
    // message-thread-side). SetLightingConfig also auto-resizes
    // LightingConfig::fixtures to match a changed resolightColumns/Rows
    // (see MainComponentLighting.cpp's regenerateResoLightFixtures()) --
    // LightFixtureUpdate then edits an individual fixture's real position/
    // LED count/addressable flag from there (3D editor drag, settings-card
    // per-fixture fields). LightCue has no Move -- like Region/Section,
    // repositioning is just a startSeconds field in Update.
    SetLightingConfig,
    LightFixtureAdd,
    LightFixtureDuplicate,
    LightFixtureRemove,
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
    SetAudioDeviceType,
    SetSampleRate,
    SetBufferSize,
    SetMidiOutput,
    SetMidiInput,
    // Toggles CoreMidiDispatcher's virtual "ResoStage Sync" MIDI source on/
    // off (see its doc comment) -- `json` carries { "enabled": bool }.
    SetMidiVirtualPort,
    SetUiRenderEngine,
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
    // Generic native menu / hotkey dispatch (Electron shell menu bar, etc.).
    // `json` = {"action":"..."}; handled via MainComponent::performAction().
    PerformAction,
};

struct WebCommand {
    WebCommandKind kind = WebCommandKind::Stop;
    int arg = 0;        // SelectSong index, or track/bus index for mixer commands
    double value = 0.0; // gain (dB) / pan (-1..1) / bool (0.0 or 1.0) depending on kind
    std::string path = {};   // LoadProjectFromPath / BuilderTrackImportWavUpload: temp file path
    std::string json = {};   // Builder*: raw POST body, parsed message-thread-side
};

// Snapshot of everything the SPA needs, written by the message thread (~30 Hz)
// and read by the web server thread when serializing WebSocket frames / REST.
// Strings are plain std::string under a mutex -- this path is never on the
// audio callback.
struct WebUiState {
    std::string projectName;
    // Project-global metronome (same for every song).
    bool click = false;
    std::string clickName = "Click";
    // Flat route id (see engine/project/RouteId.h) plus the tagged form it
    // decodes to. Both are carried because the SPA renders the flat id in a
    // <select> but the wire contract mirrors the on-disk SourceOutput.
    std::string clickBusId;
    std::string clickOutputType = "main"; // "main" | "sends-only" | "ext-out" | "bus"
    std::string clickOutputTarget;        // empty unless type is ext-out or bus
    double clickGainDb = 0.0;
    // Project-global metronome pan (-1..+1).
    double clickPan = 0.0;
    // Force mono click (L=R, pan balance ignored).
    bool clickMono = false;
    // Metronome solo -- joins the same solo group as track solo (see
    // AudioEngine::setClickSolo()).
    bool clickSolo = false;
    // The metronome is in the tracks' solo group -- see BusRow's soloGroup.
    std::string clickSoloGroup = "sources";
    bool clickSoloActiveInGroup = false;
    struct ClickSendRow {
        std::string busId;
        // 0-100 LINEAR percent, exactly as SendConfig::level stores it. Not
        // dB: a round trip through dB and back can never land on exactly 0
        // or exactly 100, which is what the send presets need.
        double level = 100.0;
        bool enabled = true;
    };
    std::vector<ClickSendRow> clickSends;
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
    // the SPA blocking edits (state.busy).
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
        /** Authored song length, song-local seconds; 0 = derive from content.
         *  See SongDef::endSeconds. */
        double endSeconds = 0.0;
        bool click = false;
        std::string clickBusId;
        double clickGainDb = 0.0;
        // click sends: extra buses (aux monitor mixes) the metronome feeds.
        struct ClickSendRow { std::string busId; double level = 100.0; bool enabled = true; };
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
            double startSeconds = 0.0;
            double durationSeconds = 0.0;
            double gainDb = 0.0;
            struct Source {
                std::string file;
                double offsetSeconds = 0.0;
            } source;
            struct Fade {
                double inSeconds = 0.0;
                double outSeconds = 0.0;
                // Curvature [-1, +1]: 0 = linear, + ease-out, - ease-in.
                double inCurve = 0.0;
                double outCurve = 0.0;
            } fade;
            struct Loop {
                // Repeat source to fill durationSeconds; lengthSeconds==0 = rest.
                bool enabled = false;
                double lengthSeconds = 0.0;
            } loop;
            struct Playback {
                // See RegionPlayback in ProjectSchema.h.
                double speed = 1.0;
                double semitones = 0.0;
                bool reverse = false;
            } playback;
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
            struct Color {
                int r = 255;
                int g = 255;
                int b = 255;
            } color;
            double intensity = 1.0;
            struct Fade {
                double inSeconds = 0.0;
                double outSeconds = 0.0;
            } fade;
            std::string label;
            // Audio-reactive effect -- see LightCue's own field docs in
            // ProjectSchema.h. Read back here (not just write-only via the
            // cueUpdate command) so the effect panel reflects the real
            // stored value instead of resetting to defaults every time the
            // selection changes.
            struct Effect {
                std::string type;                    // "" = none
                std::string sourceType;              // "bus" | "track"
                std::string sourceId;                // "" = master mix
                double intensity = 0.8;
                bool tempoSync = false;
                std::string tempoSubdivision = "1/4";
                double rateHz = 2.0;
            } effect;
            struct Gradient {
                std::string preset = "solid";
                std::string colors; // CSV #RRGGBB stops; empty = preset/base color
            } gradient;
            // "normal" | "additive" | "multiply" | "difference" | "lighten"
            // | "subtractive" -- see engine/lighting/LightBlend.h. Only
            // meaningful when this cue's fixture is also driven by another
            // LightTrack active at the same instant.
            std::string blendMode;
        };
        std::vector<LightCueRow> lightCues;
    };
    std::vector<SongRow> songs;

    // Single project-wide cycle (song-local seconds on songIndex).
    struct CycleRow {
        bool active = false;
        bool skip = false;
        double startSeconds = 0.0;
        double endSeconds = 4.0;
        int songIndex = -1;
    };
    CycleRow cycle;

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
        int channels = 2; // 1 = mono (stereo regions summed L+R before pan/sends)
        double gainDb = 0.0;
        double pan = 0.0;
        bool mute = false;
        bool solo = false;
        // Solo group + whether anything in it is soloed -- see BusRow.
        std::string soloGroup = "sources";
        bool soloActiveInGroup = false;
        struct SendRow {
            std::string bus;
            double level = 100.0; // 0-100 LINEAR percent, 100 = unity/0 dB
            bool preFader = false;
            bool enabled = true;
        };
        struct Output {
            std::string type = "main"; // "main" | "sends-only" | "ext-out"
            std::string target;        // empty unless type == "ext-out"
            std::vector<SendRow> sends;
        } output;
        float peakDb = -144.0f;
        float peakDbL = -144.0f;
        float peakDbR = -144.0f;
    };
    std::vector<TrackRow> tracks;

    struct BusRow {
        std::string id;
        std::string name;
        double gainDb = 0.0;
        double pan = 0.0; // -1..+1 balance on physical outs
        bool mute = false;
        bool solo = false;
        // Which solo group this row belongs to ("sources" | "sends" | "main"
        // | "none") and whether anything in that group is currently soloed.
        // Together they tell the SPA which strips to draw as silenced without
        // it re-implementing the engine's grouping rule.
        std::string soloGroup = "none";
        bool soloActiveInGroup = false;
        bool isAux = false;
        int startChannel = 0;
        int channels = 2;
        // True when this is a fabricated global Direct Output bus (derived
        // from the device's active channels, not persisted in the project).
        bool isDirectOut = false;
        // True when this direct-out lane's physical output is currently
        // inactive (device dropped / missing channel). Its route is preserved
        // so the mapping survives; the lane just routes to silence and gets a
        // warning icon in the UI until the output returns. Never set on
        // project buses.
        bool unavailable = false;
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
        std::string kind; // "resolight::bar" | "dmx::generic"
        struct Grid {
            int column = 0;
            int row = 0;
        } grid;
        int ledCount = 120;
        bool addressable = true;
        struct Position {
            double x = 0.0;
            double y = 0.0;
            double z = 0.0;
        } position;
        struct Rotation {
            double y = 0.0; // yaw around the vertical axis
        } rotation;
        bool mountedHorizontally = false;
        struct Dmx {
            int universe = 0;
            int startChannel = 1;
            int channelCount = 3;
        } dmx;
        // Cosmetic/informational only -- see ProjectSchema.h's LightFixture
        // doc comment. Neither field affects real DMX output.
        std::string shape = "bar";
        int matrixColumns = 0;
        std::string channelProfile = "rgb";
        double tiltDegrees = 0.0;
        // 0 = inherit LightingRow::defaultRefreshRateHz. See
        // ProjectSchema.h's LightFixture::refreshRateHz doc comment -- this
        // one DOES reach real DMX output, unlike the cosmetic fields above.
        double refreshRateHz = 0.0;
        // Real-hardware transport (ResoLightBar only). Empty = preview-only.
        // See ProjectSchema.h's LightFixture::networkHost. Port is protocol-
        // fixed (never on the wire).
        std::string networkHost;
        // Live link status from LightHardwareServer (not persisted).
        bool hwConfigured = false;
        bool hwConnected = false;
        int hwRssiDbm = 0;
        std::string hwChipType;
    };
    struct DiscoveredBoardRow {
        std::string mac;
        std::string ip;
        std::string name;
        std::string chipType;
        double lastSeenSecondsAgo = 0.0;
    };
    struct LightingRow {
        bool enabled = false;
        std::string kind = "none"; // "none" | "resolight" | "dmx::generic"
        struct ResoLight {
            int columns = 2;
            int rows = 1;
        } resolight;
        // See engine/project/ProjectSchema.h's LightingConfig::idle.
        struct Idle {
            std::string behavior = "hold"; // "hold" | "blackout" | "static" | "effect"
            struct Color {
                int r = 0;
                int g = 0;
                int b = 0;
            } color;
            double intensity = 1.0;
            // See LightingConfig's idle effect -- used only when behavior == "effect".
            struct Effect {
                std::string type = "none";
                double rateHz = 2.0;
            } effect;
            // Gradient palette for idle effect mode (Fire/Fireworks/etc).
            // "solid" = use color; named presets = built-in palettes.
            struct Gradient {
                std::string preset = "solid";
                std::string colors;
            } gradient;
        } idle;
        double defaultRefreshRateHz = 44.0;
        // Art-Net unicast target; empty / "255.255.255.255" = broadcast.
        std::string artNetTargetHost;
        std::vector<LightFixtureRow> fixtures;
        // Authoring roster (Light timeline rows). Nested here, not a stray
        // top-level list, exactly like LightingConfig::tracks on disk.
        struct LightTrackRow {
            std::string id;
            std::string name;
            std::vector<std::string> fixtureIds;
        };
        std::vector<LightTrackRow> tracks;
        // ESP boards heard on the LAN discovery beacon (last ~30s). Not
        // project data -- live from LightHardwareServer.
        std::vector<DiscoveredBoardRow> discoveredBoards;
    };
    LightingRow lighting;

    /**
     * The signal flow the audio thread is ACTUALLY rendering, copied straight
     * out of the published MixGraph -- not a second derivation of the routing
     * rules. The Settings > Audio diagram draws this, so what it shows and
     * what you hear cannot disagree.
     *
     * Only populated for the "mixgraph" view, since it is static between
     * routing edits and has no business in every 30 Hz frame.
     */
    struct MixGraphRow {
        struct StripRow {
            std::string id;
            std::string name;
            std::string kind;      // "track" | "click" | "send" | "main" | "output"
            std::string soloGroup; // "sources" | "sends" | "main" | "none"
            int channels = 2;
            double gainDb = 0.0;
            double pan = 0.0;
            bool mute = false;
            bool solo = false;
            // Resolved: false when muted OR silenced by someone else's solo.
            bool audible = true;
            // Output lanes only: 0-based device channel, -1 = shadow lane
            // (referenced by the project, absent from the device right now).
            int physicalChannel = -1;
            float peakDb = -144.0f;
        };
        struct EdgeRow {
            std::string from;
            std::string to;
            double level = 100.0; // 0-100 percent, 100 = unity
            bool preFader = false;
            bool active = true;
            // -1 = sum L+R into a mono destination, 0 = left, 1 = right.
            int sourceChannel = -1;
        };
        std::vector<StripRow> strips;
        std::vector<EdgeRow> edges;
    };
    MixGraphRow mixGraph;

    // Backend-authoritative resolved lamp state, one row per fixture
    // currently driven by an active cue -- computed by the exact same
    // engine/lighting/LightOutputResolver.h call LightEngine's real-time DMX
    // thread uses, at the ~30Hz WebUiState publish rate. The live preview
    // (Settings' 3D editor, Timeline's Light mode) renders THIS, not its own
    // re-simulation, so it can never show something the real hardware isn't
    // also doing (see RESTORE_POINT.md Feature 6's sync fix).
    struct LedColorRow {
        int r = 0;
        int g = 0;
        int b = 0;
    };
    struct LightOutputRow {
        std::string fixtureId;
        // Index of this fixture in the project's lighting.fixtures array --
        // the wire key the frontend maps back to a fixture. -1 when the
        // fixture is no longer in the project (row skipped upstream).
        int fixtureIdx = -1;
        // Final per-LED wire colors (intensity already baked in) -- one entry
        // per LED for addressable fixtures, a single uniform entry for
        // non-addressable ones, produced by resolveLedWireColors(). Empty
        // when the fixture can't be found.
        std::vector<LedColorRow> ledColors;
    };
    std::vector<LightOutputRow> lightOutput;

    // Health -- combined totals across all app-related processes.
    double cpuPercent = 0.0;
    uint64_t rssBytes = 0;
    uint64_t freeBytes = 0;
    uint64_t systemTotalBytes = 0;
    uint32_t cpuCoreCount = 1;
    uint64_t underrunCount = 0;
    uint64_t audioCallbackCount = 0;
    uint64_t silentBlockCount = 0;
    uint64_t pitchBlockCount = 0;
    uint64_t streamStarveCount = 0;
    /** App-caused disk throughput; see SystemHealthSnapshot. */
    double diskReadBytesPerSec = 0.0;
    double diskWriteBytesPerSec = 0.0;
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
        std::vector<std::string> audioDrivers;
        std::string currentAudioDriver;
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
        std::string uiRenderEngine = "wkwebview";
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
// - Serves the SPA from disk: each root added via addWebRoot() (usually the
//   packaged bundle's Contents/Resources/web folder, plus ui/dist in dev) is
//   tried in order -- no Node, no generated header with baked-in assets.
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

    // Message-thread: add a directory to serve the SPA from (checked in order
    // on the lws thread for each static request). Roots are read-only after
    // start(), so this is only meant to be called before start().
    void addWebRoot(const std::string& root);

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

    // Per-view connected-client census, maintained by the WS sessions. Used by
    // publishState() to serialise ONLY the views somebody is actually looking
    // at -- it used to build all five plus the REST snapshot on every tick
    // regardless, which for one client on one tab is six payloads of wasted
    // work per frame on the message thread.
    enum class ViewSlot { Player = 0, Mixer, Editor, Settings, Light, Count };
    void noteViewOpened(ViewSlot slot);
    void noteViewClosed(ViewSlot slot);

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
    // Bumped only when a rebuilt frame's bytes actually differ from the cached
    // one, so a client that already holds this generation has nothing to gain
    // from another write. See publishState().
    uint64_t frameGeneration() const;

    void enqueueCommand(WebCommand cmd);
    bool handleHttpApi(struct lws* wsi, const char* path, const char* method, const char* body, size_t bodyLen);
    int serveStatic(struct lws* wsi, const char* path);
    int serveExportStatus(struct lws* wsi);
    int serveExportDownload(struct lws* wsi);
    int servePeaks(struct lws* wsi);
    int serveAllPeaks(struct lws* wsi);
    int serveWaveformRaw(struct lws* wsi, const char* queryArgs);
    // GET /api/v1/ui/menu -- serializes platform/MenuModel.h/.cpp (the same
    // single source the AppKit menu bar is built from) + current keybindings
    // + recent projects, for the Electron shell's native menu/Touch Bar.
    int serveUiMenu(struct lws* wsi);
    std::string buildMenuModelJson() const;

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
        std::shared_ptr<const std::string> light;
        // No `all` slot: GET /api/v1/state builds that live (see
        // cachedFrameForView) so the periodic publish never serialises a
        // whole-project snapshot nobody is streaming.
        std::shared_ptr<const std::vector<uint8_t>> binary; // High-frequency telemetry (binary)
        uint64_t generation = 0;
    };
    mutable std::mutex frameMutex;
    FrameCache frames;

    std::atomic<int> viewClients_[static_cast<size_t>(ViewSlot::Count)]{};

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

    // SPA web roots (bundle Contents/Resources/web, dev ui/dist, ...) tried
    // in order by serveStatic on the lws thread. Immutable after start().
    std::vector<std::string> webRoots_;

    // Per-session WS bookkeeping lives in the .cpp (opaque to callers).
    // The service thread owns a linked list of live WS sessions via user data.
};

} // namespace resostage
