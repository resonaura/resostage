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

struct WRegionPeakOverview {
    std::string id;
    std::string trackId;
    double durationSeconds = 0.0;
    std::vector<WPeakLevel> levels;
};

struct WSongPeaks {
    std::vector<WRegionPeakOverview> tracks;
};

struct WAllPeaksPayload {
    std::vector<WSongPeaks> songs;
};

struct WSeekPayload {
    double seconds = 0.0;
    std::optional<int> songIndex;
};

// ── Web Server Telemetry ─────────────────────────────────────────────────────

struct WClickSendTelemetry {
    std::string busId;
    double gainDb = 0.0;
    bool enabled = true;
};

struct WRegionTelemetry {
    std::string id;
    std::string trackId;
    std::string file;
    double startSeconds = 0.0;
    double sourceOffsetSeconds = 0.0;
    double durationSeconds = 0.0;
    double gainDb = 0.0;

    std::optional<double> fadeInSeconds;
    std::optional<double> fadeOutSeconds;
    std::optional<double> fadeInCurve;
    std::optional<double> fadeOutCurve;
    std::optional<bool> loop;
    std::optional<double> loopLengthSeconds;
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

struct WLightCueTelemetry {
    std::string id;
    std::string trackId;
    double startSeconds = 0.0;
    double durationSeconds = 0.0;
    uint8_t colorR = 255;
    uint8_t colorG = 255;
    uint8_t colorB = 255;
    double intensity = 1.0;
    double fadeInSeconds = 0.0;
    double fadeOutSeconds = 0.0;
    std::string label;
    std::string effectType;
    std::string effectSourceType;
    std::string effectSourceId;
    double effectIntensity = 0.0;
    bool tempoSync = false;
    std::string tempoSubdiv;
    double effectRateHz = 0.0;
    std::string gradientPreset;
    std::string gradientColors;
    std::string blendMode;
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
    double leftSec = 0.0;
    double rightSec = 0.0;
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
    std::string busId;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    bool mono = false;
    std::vector<WSendTelemetry> sends;
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
    bool isAux = false;
    int startChannel = 0;
    int channels = 2;
    double peakDb = -100.0;
    double peakDbL = -100.0;
    double peakDbR = -100.0;
};

struct WFixtureTelemetry {
    std::string id;
    std::string name;
    std::string kind;
    int gridColumn = 0;
    int gridRow = 0;
    int ledCount = 0;
    bool addressable = false;
    double posX = 0.0;
    double posY = 0.0;
    double posZ = 0.0;
    double rotationYDeg = 0.0;
    bool mountedHorizontally = false;
    int dmxUniverse = 1;
    int dmxStartChannel = 1;
    int dmxChannelCount = 1;
    std::string shape;
    int matrixCols = 0;
    std::string channelProfile;
    double tiltDeg = 0.0;
    double refreshRateHz = 0.0;
    std::string networkHost;
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

struct WLightingTelemetry {
    bool enabled = false;
    std::string kind;
    int resoLightColumns = 0;
    int resoLightRows = 0;
    std::string idleBehavior;
    uint8_t idleColorR = 0;
    uint8_t idleColorG = 0;
    uint8_t idleColorB = 0;
    double idleIntensity = 0.0;
    std::string idleEffectType;
    double idleEffectRateHz = 0.0;
    std::string idleGradientPreset;
    std::string idleGradientColors;
    double defaultRefreshRateHz = 0.0;
    std::vector<WFixtureTelemetry> fixtures;
    std::string artNetTargetHost;
    std::vector<WDiscoveredBoardTelemetry> discoveredBoards;
};

struct WLightTrackTelemetry {
    std::string id;
    std::string name;
    std::vector<std::string> fixtureIds;
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
    uint64_t underrunCount = 0;
    uint64_t audioCallbackCount = 0;
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

    std::optional<bool> click;
    std::optional<std::string> clickName;
    std::optional<std::string> clickBusId;
    std::optional<double> clickGainDb;
    std::optional<double> clickPan;
    std::optional<bool> clickMono;
    std::optional<bool> clickSolo;
    std::optional<std::vector<WClickSendTelemetry>> clickSends;
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

    WLightingTelemetry lighting;
    std::vector<WLightTrackTelemetry> lightTracks;

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
