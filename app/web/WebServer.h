#pragma once

#include <readerwriterqueue.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// Forward-declare libwebsockets types so the header stays lightweight.
struct lws_context;
struct lws;
struct lws_protocols;

namespace resoset {

// Remote-control actions enqueued by the web/HTTP thread and drained on the
// JUCE message thread (MainComponent timer). Never executed on the lws service
// thread itself -- that would race with AudioEngine/JUCE state.
enum class WebCommandKind : uint8_t {
    Play,
    Stop,
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
    SetBusGain,
    SetBusMute,
    SetBusSolo,
    // Ableton-style per-track send routing -- `json` carries
    // {trackIndex, busId, gainDb}. Mirrors MixerPanel.cpp's onSendChanged:
    // find the track's existing TrackSendDef for busId and update its gain,
    // or create a new one if this is the first time this bus was sent to
    // (turning a knob up from its floor implicitly creates the send). Always
    // targets engine.currentSongIndex(), same as the other mixer commands.
    SetTrackSend,
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
    BuilderBusAdd,
    BuilderBusRemove,
    BuilderBusMove,
    BuilderBusUpdate,
    BuilderEventAdd,
    BuilderEventRemove,
    BuilderEventMove,
    BuilderEventUpdate,
    // Settings parity -- audio device/sample-rate/buffer-size, MIDI I/O
    // device selection, keybindings. Same raw-JSON-passthrough routing as
    // the Builder commands above; handled in MainComponentSettings.cpp.
    SetAudioOutputDevice,
    SetSampleRate,
    SetBufferSize,
    SetMidiOutput,
    SetMidiInput,
    SetKeybinding,
    SetOutputChannels,
    // Timeline parity -- `value` is the target position in seconds. Mirrors
    // TimelineView.cpp's click/drag-to-seek (see AudioEngine::seekToSeconds);
    // the frontend throttles drag updates itself, same reason TimelineView's
    // own doc comment gives (seek restages the song, so hammering it on
    // every mouse-move would be wasteful).
    Seek,
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
    std::string songName;
    double playheadSeconds = 0.0;
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
    // Mirrors AudioEngine::isBusy() -- true during an async WAV/folder
    // import. The web UI disables Builder edits while this is set, same as
    // the native BusyOverlay blocking all input.
    bool busy = false;

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
    };
    std::vector<SongRow> songs;

    struct MeterRow {
        std::string id;
        float peakDb = -144.0f;
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
        struct SendRow {
            std::string busId;
            double gainDb = 0.0;
        };
        std::vector<SendRow> sends;
        float peakDb = -144.0f;
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
    };
    std::vector<BusRow> busses;

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
        struct Keybinding {
            std::string action;
            std::string key;
        };
        std::vector<Keybinding> keybindings;
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

    // Message-thread: publish the latest UI snapshot for remote clients.
    void publishState(const WebUiState& state);

    // Message-thread: drain one remote command (if any). Returns false if empty.
    bool pollCommand(WebCommand& out);

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
    std::string buildStateJson() const;
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

    mutable std::mutex stateMutex;
    WebUiState state;

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

} // namespace resoset
