#pragma once

#include "glaze/glaze.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace resostage::wire {

// ── App Settings ─────────────────────────────────────────────────────────────

struct WMidiMapping {
    std::string action;
    int channel = 0;
    std::string triggerType = "noteOn";
    int number = 0;
};

struct WRecentProject {
    std::string path;
    std::string displayName;
    std::string lastOpenedIso;
};

struct WAppSettings {
    std::string outputDeviceName;
    double sampleRate = 0.0;
    int bufferSize = 0;
    std::string midiOutputName;
    std::string midiInputName;
    bool virtualMidiPortEnabled = false;
    std::string uiRenderEngine = "browser";
    std::vector<int> activeOutputChannels;
    std::unordered_map<std::string, std::string> keybindings;
    std::vector<WMidiMapping> midiMappings;
    std::vector<WRecentProject> recentProjects;
};

struct AppSettingsPrettyOpts : glz::opts {
    static constexpr bool indented = true;
};

// ── Peak Overviews / Timeline ────────────────────────────────────────────────

struct WPeakLevel {
    int samplesPerBin = 0;
    std::vector<float> min;
    std::vector<float> max;
    std::vector<float> rms;
};

struct WPeakOverview {
    double durationSeconds = 0.0;
    std::vector<WPeakLevel> levels;
};

struct WTrackPeakOverview {
    std::string id;
    double durationSeconds = 0.0;
    std::vector<WPeakLevel> levels;
};

struct WPeaksPayload {
    std::vector<WTrackPeakOverview> tracks;
};

// One source file's peak levels, carried ONCE per payload however many regions
// are cut from it. Peak overviews are a property of the file, not of the clip:
// every region sharing a wav gets identical level arrays and differs only in
// the window it draws. Emitting them per region meant a stem sliced ten ways
// shipped ten copies of the same few hundred kilobytes, in a blob that is
// rebuilt on the message thread and re-downloaded on every region edit.
struct WPeakFileLevels {
    std::string file;
    double durationSeconds = 0.0;
    std::vector<WPeakLevel> levels;
};

struct WRegionPeakOverview {
    std::string id;
    std::string trackId;
    // Kept here as well as on the file entry: it is what the SPA's song-length
    // math reads straight off these rows, and it is 8 bytes against the
    // kilobytes that moved out.
    double durationSeconds = 0.0;
    // Index into WAllPeaksPayload::files, or -1 when this region's file has no
    // peaks built yet.
    int levelsIndex = -1;
};

struct WSongPeaks {
    std::vector<WRegionPeakOverview> tracks;
};

struct WAllPeaksPayload {
    std::vector<WPeakFileLevels> files;
    std::vector<WSongPeaks> songs;
};

struct WSeekPayload {
    double seconds = 0.0;
    std::optional<int> songIndex;
};

// ── Web Server Telemetry ─────────────────────────────────────────────────────
//
// Mirrors the canonical nested keys of the on-disk project format (see
// core/engine/project/ProjectJson.cpp's project_json_wire DTOs -- those are
// the source of truth for names). Rows that map 1:1 onto project data carry
// nested containers (source/fade/loop/output/color/effect/gradient/grid/
// position/rotation/dmx/idle/resoLight) instead of the flat duplicates an
// earlier wire format used. Send level is the schema's 0-100 linear percent
// (100 == unity / 0 dB), NOT a dB value -- see sendLevelToDb/sendDbToLevel.

struct WSendConfig {
    std::string bus;
    double level = 100.0;
    bool preFader = false;
    bool enabled = true;
};

// A source's main route + aux sends (tracks/clicks). `type` is the on-disk
// OutputType string: "main" | "sends-only" | "ext-out". `target` is only set
// for "ext-out" (one or two comma-joined "audio::out:N" mono lanes).
struct WSourceOutput {
    std::string type = "main";
    std::optional<std::string> target;
    std::vector<WSendConfig> sends;
};

// Per-song flat click mirror (back-compat for older SPA code that reads
// song.click / song.clickSends). Kept flat on purpose -- the *root* click's
// routing lives in WClickChannel.output (below), the projected rows just
// duplicate it for Builder convenience.
struct WClickSendTelemetry {
    std::string busId;
    double level = 100.0; // 0-100 LINEAR percent, same unit as SendConfig::level
    bool enabled = true;
};

// Project-global metronome, mirrored field-for-field from ClickChannel in
// ProjectSchema.h (type/target/sends carry the routing exactly like a track).
struct WClickTelemetry {
    bool enabled = false;
    std::string name = "Click";
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    // The metronome shares the tracks' solo group -- soloing a track during a
    // show means "against the click", not "kill the click".
    std::string soloGroup = "sources";
    bool soloActiveInGroup = false;
    WSourceOutput output;
};

struct WRegionSource {
    std::string file;
    double offsetSeconds = 0.0;
};

struct WRegionFade {
    double inSeconds = 0.0;
    double outSeconds = 0.0;
    double inCurve = 0.0;
    double outCurve = 0.0;
};

struct WRegionLoop {
    bool enabled = false;
    double lengthSeconds = 0.0;
};

struct WRegionTelemetry {
    std::string id;
    std::string trackId;
    double startSeconds = 0.0;
    double durationSeconds = 0.0;
    double gainDb = 0.0;
    WRegionSource source;
    // Fade/loop are view-scoped like the old flat fade/loop keys were: only
    // emitted by full-detail views (editor) and the player timeline.
    std::optional<WRegionFade> fade;
    std::optional<WRegionLoop> loop;
};

struct WEventTelemetry {
    std::string id;
    std::string type;
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

struct WSectionTelemetry {
    std::string id;
    std::string name;
    double startSeconds = 0.0;
    int colorIndex = 0;
};

// ── Nested telemetry DTOs ────────────────────────────────────────────────────
// These mirror the on-disk format's project_json_wire structs (see
// core/engine/project/ProjectJson.cpp) so the wire contract and the persisted
// contract share the exact same key names, and the SPA can treat them as one.

struct WColorTelemetry {
    uint8_t r = 255;
    uint8_t g = 255;
    uint8_t b = 255;
};

struct WLightCueFadeTelemetry {
    double inSeconds = 0.0;
    double outSeconds = 0.0;
};

struct WLightEffectTelemetry {
    std::optional<std::string> type; // null = no effect
    std::string sourceType = "bus";  // "bus" | "track"
    std::optional<std::string> sourceId;
    double intensity = 0.8;
    bool tempoSync = false;
    std::string tempoSubdivision = "1/4";
    double rateHz = 2.0;
};

struct WLightGradientTelemetry {
    std::string preset = "solid";
    std::optional<std::string> colors; // CSV #RRGGBB stops; empty = preset/base color
};

struct WLightCueTelemetry {
    std::string id;
    std::string trackId;
    double startSeconds = 0.0;
    double durationSeconds = 1.0;
    std::optional<std::string> label;
    WColorTelemetry color{255, 255, 255};
    double intensity = 1.0;
    WLightCueFadeTelemetry fade;
    WLightEffectTelemetry effect;
    WLightGradientTelemetry gradient;
    std::string blendMode = "normal";
};

struct WSongTelemetry {
    std::string name;
    double bpm = 120.0;
    std::string mode = "auto";
    int tsNum = 4;
    int tsDen = 4;
    bool click = true;
    std::string clickBusId;
    double clickGainDb = 0.0;
    std::vector<WClickSendTelemetry> clickSends;
    std::vector<WRegionTelemetry> regions;
    std::vector<WEventTelemetry> events;
    std::vector<WSectionTelemetry> sections;
    std::vector<WLightCueTelemetry> lightCues;
};

struct WCycleTelemetry {
    bool active = false;
    bool skip = false;
    double startSeconds = 0.0;
    double endSeconds = 4.0;
    int songIndex = -1;
};

struct WMeterTelemetry {
    std::string id;
    double peakDb = -100.0;
    double peakDbL = -100.0;
    double peakDbR = -100.0;
    double shortTermLufs = 0.0;
};

struct WSendTelemetry {
    std::string busId;
    double gainDb = 0.0;
};

struct WTrackTelemetry {
    std::string id;
    std::string name;
    int channels = 2; // 1 = mono (stereo regions summed L+R before pan/sends)
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    std::string soloGroup = "sources";
    bool soloActiveInGroup = false;
    WSourceOutput output; // type/target/sends, same as ClickChannel/track on disk
    double peakDb = -100.0;
    double peakDbL = -100.0;
    double peakDbR = -100.0;
};

struct WBusTelemetry {
    std::string id;
    std::string name;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    // See WebServer.h's BusRow -- solo is always scoped to a group.
    std::string soloGroup = "none";
    bool soloActiveInGroup = false;
    bool isAux = false;
    // A fabricated output lane rather than an authorable project bus, and
    // whether its physical channel is currently reachable. The SPA reads both
    // to flag a route whose output has gone missing (device unplugged, channel
    // switched off) instead of silently showing it as fine.
    bool isDirectOut = false;
    bool unavailable = false;
    int startChannel = 0;
    int channels = 2;
    double peakDb = -100.0;
    double peakDbL = -100.0;
    double peakDbR = -100.0;
};

struct WFixtureGridTelemetry {
    int column = 0;
    int row = 0;
};

struct WFixturePositionTelemetry {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

struct WFixtureRotationTelemetry {
    double y = 0.0;
};

struct WFixtureDmxTelemetry {
    int universe = 0;
    int startChannel = 1;
    int channelCount = 3;
};

struct WFixtureTelemetry {
    std::string id;
    std::string name;
    std::string kind;
    WFixtureGridTelemetry grid;
    int ledCount = 0;
    bool addressable = false;
    WFixturePositionTelemetry position;
    WFixtureRotationTelemetry rotation;
    bool mountedHorizontally = false;
    WFixtureDmxTelemetry dmx;
    std::string shape;
    int matrixColumns = 0;
    std::string channelProfile;
    double tiltDegrees = 0.0;
    double refreshRateHz = 0.0;
    // Real-hardware transport (ResoLightBar only). Empty = preview-only.
    std::string networkHost;
    // Live link status from LightHardwareServer (not persisted).
    bool hwConfigured = false;
    bool hwConnected = false;
    int hwRssiDbm = 0;
    std::string hwChipType;
};

struct WDiscoveredBoardTelemetry {
    std::string mac;
    std::string ip;
    std::string name;
    std::string chipType;
    double lastSeenSecondsAgo = 0.0;
};

struct WIdleColorTelemetry {
    uint8_t r = 0;
    uint8_t g = 0;
    uint8_t b = 0;
};

struct WIdleEffectTelemetry {
    std::string type = "none";
    double rateHz = 2.0;
};

struct WIdleGradientTelemetry {
    std::string preset = "solid";
    std::optional<std::string> colors;
};

struct WIdleTelemetry {
    std::string behavior = "hold";
    WIdleColorTelemetry color{0, 0, 0};
    double intensity = 1.0;
    WIdleEffectTelemetry effect;
    WIdleGradientTelemetry gradient;
};

struct WResoLightGridTelemetry {
    int columns = 2;
    int rows = 1;
};

struct WLightTrackTelemetry {
    std::string id;
    std::string name;
    std::vector<std::string> fixtureIds;
};

struct WLightingTelemetry {
    bool enabled = false;
    std::string kind = "none";
    WResoLightGridTelemetry resolight;
    WIdleTelemetry idle;
    double defaultRefreshRateHz = 44.0;
    std::optional<std::string> artNetTargetHost; // null = broadcast
    std::vector<WFixtureTelemetry> fixtures;
    std::vector<WLightTrackTelemetry> tracks;
    std::vector<WDiscoveredBoardTelemetry> discoveredBoards;
};

// ── Signal flow diagram ──────────────────────────────────────────────────────
// A direct projection of the engine's published MixGraph (see
// core/engine/audio/MixGraph.h). Shipped only for the "mixgraph" view.

struct WMixStripTelemetry {
    std::string id;
    std::string name;
    std::string kind;
    std::string soloGroup;
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    bool audible = true;
    int physicalChannel = -1;
    double peakDb = -144.0;
};

struct WMixEdgeTelemetry {
    std::string from;
    std::string to;
    double level = 100.0;
    bool preFader = false;
    bool active = true;
    int sourceChannel = -1;
};

struct WMixGraphTelemetry {
    std::vector<WMixStripTelemetry> strips;
    std::vector<WMixEdgeTelemetry> edges;
};

struct WProcessTelemetry {
    int pid = 0;
    std::string name;
    uint64_t rssBytes = 0;
    double cpuPercent = 0.0;
};

struct WHealthTelemetry {
    double cpuPercent = 0.0;
    uint64_t rssBytes = 0;
    uint64_t freeBytes = 0;
    uint64_t systemTotalBytes = 0;
    uint32_t cpuCoreCount = 1;
    uint64_t underrunCount = 0;
    uint64_t audioCallbackCount = 0;
    // Blocks that left as silence while the transport was playing -- see
    // SystemHealth::noteSilentBlock(). Not a driver dropout, but audible.
    uint64_t silentBlockCount = 0;
    uint64_t streamStarveCount = 0;
    uint32_t webClientCount = 0;
    std::vector<WProcessTelemetry> processes;
};

struct WKeybindingTelemetry {
    std::string action;
    std::string key;
};

struct WRecentProjectTelemetry {
    std::string path;
    std::string displayName;
    std::string lastOpenedIso;
};

struct WMidiBindingTelemetry {
    std::string action;
    std::string trigger;
    int channel = 0;
    int number = 0;
};

struct WSettingsTelemetry {
    std::optional<std::string> currentOutputDevice;
    std::optional<std::vector<std::string>> outputDevices;
    std::optional<double> sampleRate;
    std::optional<std::vector<double>> availableSampleRates;
    std::optional<int> bufferSize;
    std::optional<std::vector<int>> availableBufferSizes;
    std::optional<std::vector<std::string>> outputChannelNames;
    std::optional<std::vector<bool>> activeOutputChannels;
    std::optional<std::vector<std::string>> midiOutputs;
    std::optional<std::vector<std::string>> midiInputs;
    std::optional<bool> virtualMidiPortEnabled;
    std::optional<std::string> uiRenderEngine;

    std::vector<WKeybindingTelemetry> keybindings;
    std::vector<WRecentProjectTelemetry> recentProjects;
    std::vector<WMidiBindingTelemetry> midiBindings;
    std::string midiLearnAction;
};

struct WEngineTelemetryPayload {
    std::string projectName;
    std::string songName;
    double playheadSeconds = 0.0;
    double globalPlayheadSeconds = 0.0;
    double globalBeatsElapsed = 0.0;
    double sampleRate = 0.0;
    double drift = 0.0;
    double bpm = 0.0;
    bool playing = false;
    bool hardwareAlarm = false;
    int songIndex = 0;
    int songCount = 0;
    std::string statusMessage;
    bool busy = false;
    bool quitConfirmPending = false;
    std::string uiTab;
    uint32_t uiTabSeq = 0;
    bool canUndo = false;
    bool canRedo = false;
    std::string undoLabel;
    std::string redoLabel;
    std::string lastAction;
    uint64_t lastActionNonce = 0;
    int wsHz = 0;

    // Project-global metronome channel, mirrored from ClickChannel
    // (enabled/name/channels/gainDb/pan/mute/solo/output). Null when the
    // player/mixer view doesn't need it.
    std::optional<WClickTelemetry> click;
    // Metronome-only peak (not the destination bus). Mono source → L=R.
    std::optional<double> clickPeakDb;
    std::optional<double> clickPeakDbL;
    std::optional<double> clickPeakDbR;
    std::optional<double> streamBufferMinSec;
    std::optional<double> streamBufferAvgSec;
    std::optional<int> streamResidentTracks;
    std::optional<int> streamStreamingTracks;
    std::optional<bool> streamBufferUrgent;
    std::optional<double> streamResidentMiB;

    std::optional<std::vector<WSongTelemetry>> songs;
    std::optional<WCycleTelemetry> cycle;
    std::optional<std::vector<WMeterTelemetry>> meters;
    std::optional<std::vector<WTrackTelemetry>> tracks;
    std::optional<std::vector<WBusTelemetry>> busses;

    WLightingTelemetry lighting; // fixtures + light tracks both nested inside

    // Only present for the "mixgraph" view -- see WebUiState::MixGraphRow.
    std::optional<WMixGraphTelemetry> mixGraph;

    std::optional<WHealthTelemetry> health;
    WSettingsTelemetry settings;
};

// ── Raw Waveform & Export & Menu ─────────────────────────────────────────────

struct WWaveformRawPayload {
    double sampleRate = 0.0;
    double startSec = 0.0;
    std::vector<float> samples;
};

struct WExportStatusPayload {
    bool ready = false;
    std::string fileName;
};

struct WMenuItem {
    std::optional<bool> separator;
    std::optional<std::string> kind;
    std::string title;
    std::optional<std::string> role;
    std::optional<std::string> actionId;
    std::optional<bool> dynamicKey;
    std::optional<std::string> key;
};

struct WTouchBarTab {
    std::string id;
    std::string label;
};

struct WMenu {
    std::string title;
    std::vector<WMenuItem> items;
};

struct WMenuModelPayload {
    std::vector<WMenu> menus;
    std::vector<WTouchBarTab> touchbar;
    std::unordered_map<std::string, std::string> keybindings;
    std::vector<WRecentProjectTelemetry> recentProjects;
};

} // namespace resostage::wire
