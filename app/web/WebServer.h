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
};

struct WebCommand {
    WebCommandKind kind = WebCommandKind::Stop;
    int arg = 0; // SelectSong index
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

    struct SongRow {
        std::string name;
        double bpm = 120.0;
        bool autoplay = false;
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
        int sends = 0;
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
        float peakDb = -144.0f;
    };
    std::vector<BusRow> busses;

    double cpuPercent = 0.0;
    uint64_t rssBytes = 0;
    uint64_t freeBytes = 0;
    uint64_t underrunCount = 0;
    uint64_t audioCallbackCount = 0;
    int webClientCount = 0;
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

private:
    friend int resosetHttpCallback(struct lws* wsi, int reason, void* user, void* in, size_t len);
    friend int resosetWsCallback(struct lws* wsi, int reason, void* user, void* in, size_t len);

    void serviceLoop();
    std::string buildStateJson() const;
    void enqueueCommand(WebCommand cmd);
    bool handleHttpApi(struct lws* wsi, const char* path, const char* method, const char* body, size_t bodyLen);
    int serveStatic(struct lws* wsi, const char* path);

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

    // Per-session WS bookkeeping lives in the .cpp (opaque to callers).
    // The service thread owns a linked list of live WS sessions via user data.
};

} // namespace resoset
