/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "AppSettings.h"
#include "AudioEngine.h"
#include "OfflineRenderer.h"
#include "lighting/LightOutputResolver.h"
#include "midi/CoreMidiInputListener.h"
#include "server/WebServer.h"
#include "ipc/IpcServer.h"
#include "network/UDPDiscovery.h"
#include "plugins/PluginCatalogService.h"

#include <chrono>
#include <deque>
#include <atomic>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace resostage {

// Headless core: audio / lighting / transport + embedded WebServer.
// Owned by ResoStageApplication with no DocumentWindow / desktop peer
// (see Main.cpp) so native dialogs never resurrect a blank host window.
// Occasional OS FileChooser / AlertWindow peers are created on demand.
class MainComponent final : public juce::Component, private juce::Timer {
public:
    // A non-empty ipcSocketPath starts an IPC server and sends
    // {"type":"ready"} after the audio device opens (for Electron UI on
    // Linux/Windows/standalone macOS). An empty path disables IPC (development
    // mode, when JUCE starts Electron with --backend-port).
    // webPort is the WebServer port (default 2899); remote startup can
    // override it with --backend-port.
    explicit MainComponent(std::string ipcSocketPath = {}, uint16_t webPort = kWebPort, bool enableDiscovery = true, std::string bindAddress = "0.0.0.0");
    ~MainComponent() override;

    void paint(juce::Graphics&) override;
    void resized() override;

    void confirmQuitIfUnsaved(std::function<void(bool)> onDecision = nullptr);

    bool loadProjectFromPath(const juce::File& file);

    // Settings > UI = "electron": spawn the Electron shell (electron/), which
    // becomes the on-screen window/menu bar/Touch Bar; the JUCE window backs
    // off to a headless accessory process that keeps serving the backend.
    void launchElectronShell();
    void terminateElectronShell();

    // Settings > UI = "browser" (default): open the SPA in the system browser
    // against the embedded backend, then back off to headless as well.
    void launchBrowserTab();

    /** Called from the Electron menu bar, MIDI, and web action POSTs. */
    void performAction(const std::string& action);
    void performContinuousAction(const std::string& target, float normalizedVal);
    /** Called from Electron IPC when user opens .rsnrasetmeta or .rsnraset file. */
    void openProjectFromIpc(const std::string& path);
    void saveProjectToPath(const std::string& path, std::function<void(bool)> onDone = nullptr);
    void importSongFolderFromPath(const std::string& path);
    /**
     * Always drop the project-folder icon into the container's Resources/
     * subfolder (and apply it on Windows via desktop.ini). Runs on save.
     */
    void ensureProjectFolderIcon(const juce::File& projectFile);

    /** Expose active key bindings for the Electron menu. */
    const std::unordered_map<std::string, std::string>& getKeyBindings() const { return keyBindings; }

    /** Expose the recent-projects list for the Electron menu's Open Recent submenu. */
    const std::vector<RecentProjectEntry>& getRecentProjects() const { return appSettings.recentProjects; }

private:
    AudioEngine engine;
    WebServer webServer;
    PluginCatalogService pluginCatalog;
    CoreMidiInputListener midiInput;
public:
    static constexpr uint16_t kWebPort = 2899;
private:
    uint16_t webPort_ = kWebPort;

    // IPC channel to Electron: Core creates a Unix-domain socket on POSIX or
    // a named pipe on Windows at startup. Sends {"type":"ready",...} after
    // the audio device opens so Electron does not connect prematurely.
    std::unique_ptr<IpcServer> ipcServer;
    std::string ipcSocketPath;
    void notifyCoreReady();

    // Rig-wide preferences (hotkeys, MIDI bindings, audio/MIDI device setup)
    // -- global across every project/set, loaded once at startup from
    // Application Support (see AppSettings.h) and rewritten to disk on every
    // change from the Settings screen. NOT part of Project/engine.project().
    AppSettings appSettings;
    void saveAppSettingsToDisk();

    // Non-null only in electron mode -- the spawned Electron shell (see
    // launchElectronShell()). Killed on shutdown so quitting ResoStage
    // always takes the shell down with it.
    std::unique_ptr<juce::ChildProcess> electronProcess;
    // Non-null only when RESOSTAGE_SPAWNED_BY_SHELL is set (this process has
    // no Dock icon of its own) -- see platform/TrayIcon.h.
    std::unique_ptr<class TrayIcon> trayIcon;
    // Mirrored into WebUiState::statusMessage.
    std::string lastStatusMessage;

    bool awaitingQuitDecision = false;
    std::function<void(bool)> pendingQuitDecision;

    // Pending "open project requested from Finder/Explorer while current
    // project is dirty" -- see openProjectFromIpc / handleOpenDecision.
    bool awaitingOpenDecision = false;
    std::string pendingOpenPath;

    std::function<void(bool)> pendingSaveAsCallback;

    std::string lastSeenSpaView;

    std::unordered_map<std::string, std::string> keyBindings = {
        {"play", "space"},
        {"stop", "escape"},
        {"next", "n"},
        {"prev", "p"},
        {"mode_player", "f1"},
        {"mode_mixer", "f2"},
        {"mode_editor", "f3"},
        {"mode_light", "f4"},
        {"mode_settings", "f5"},
        {"section_prev", "["},
        {"section_next", "]"},
        {"section_last", "end"},
        {"bar_prev", ","},
        {"bar_next", "."},
#if JUCE_MAC
        {"undo", "cmd + z"},
        {"redo", "cmd + shift + z"},
#else
        {"undo", "ctrl + z"},
        {"redo", "ctrl + shift + z"},
#endif
    };
    // Multi-key actions (same action, extra accelerators) for the Electron menu.
    std::vector<std::pair<std::string, std::string>> extraKeyBindings = {
        {"stop_to_start", "0"},
    };
    std::string uiTabRequest;
    uint64_t uiTabSeq = 0;
    std::string midiLearnAction;
    std::unique_ptr<juce::FileChooser> fileChooser;
    // Folder import dialogs (replaces BuilderPanel's own chooser state).
    std::unique_ptr<juce::FileChooser> folderChooser;
    std::unique_ptr<juce::AlertWindow> importSongDialog;

    void timerCallback() override;

    void newProjectClicked();
    void loadProjectClicked();
    void saveProjectClicked(bool saveAs, std::function<void(bool)> onDone = nullptr);
    void handleQuitDecision(int choice);
    void handleOpenDecision(int choice);
    void applyGlobalBindings();
    void jumpToSectionRelative(int delta);
    void jumpToLastSection();
    void jumpToBarRelative(int direction);
    void rememberRecentProject(const juce::File& file);
    void requestUiTab(const std::string& tab);
    void ensureSongSelected();
    void goToSong(int index);
    void nextSong();
    void prevSong();
    void togglePlayback();
    void stopToStartClicked();
    void setStatus(const juce::String& text);
    void onProjectLoaded();
    void publishWebState();
    void drainWebCommands();
    void startAudioRender(const std::string& json);
    void pluginSlotAdd(const std::string& json);
    void pluginSlotReplace(const std::string& json);
    void pluginSlotRemove(const std::string& json);
    void pluginSlotMove(const std::string& json);
    void pluginSlotBypass(const std::string& json);
    void pluginSlotRetry(const std::string& json);
    void pluginSlotKeepAwake(const std::string& json);
    void pluginSlotPark(const std::string& json);
    void pluginSlotUnpark(const std::string& json);
    void pluginSlotOpenEditor(const std::string& json);
    void closePluginEditor(const std::string& slotId);
    void closeAllPluginEditors();
    // Vendor editors stay bounded and pin the processor bank they belong to.
    std::vector<std::unique_ptr<juce::DocumentWindow>> pluginEditorWindows;

    // After structural edits from the web Builder: rebuild routing, stage a
    // song if needed. SPA re-renders from the next telemetry frame.
    // Locator-only publications retain the prepared region activity cache;
    // ordinary Builder mutations conservatively invalidate it by default.
    void notifyProjectStructureChanged(bool contentChanged = true);
    void notifyRoutingChanged();

    // Shared by WebCommandKind::TimelineUndo/Redo and performAction("undo"/"redo").
    bool performTimelineUndo(bool publishState = true);
    bool performTimelineRedo(bool publishState = true);
    uint64_t lastHistoryRequestId_ = 0; // Applied on the message thread, published with its restored project.
    std::deque<WebUiState::HistoryResult> historyResults_;
    uint64_t projectEpoch_ = 0; // Changes only when the authoritative project is replaced.
    std::deque<WebUiState::EditorCommandResult> editorCommandResults_;

    // Native folder picker when web sends import without a path (rare).
    void importSongFolderNative();

    void builderSongAdd(const std::string& json);
    void builderSongImportFolder(const std::string& json);
    void builderSongRemove(const std::string& json);
    void builderSongMove(const std::string& json);
    void builderSongEnd(const std::string& json);
    void builderSongUpdate(const std::string& json);
    void builderTrackAdd(const std::string& json);
    void builderTrackDuplicate(const std::string& json);
    void builderTrackRemove(const std::string& json);
    void builderTrackMove(const std::string& json);
    void builderTrackUpdate(const std::string& json);
    void builderRegionAdd(const std::string& json);
    void builderRegionRemove(const std::string& json);
    void builderRegionUpdate(const std::string& json);
    void builderMIDIRegionAdd(const std::string& json);
    void builderMIDIRegionRemove(const std::string& json);
    void builderMIDIRegionUpdate(const std::string& json);
    void builderMidiRegionAdd(const std::string& json) { builderMIDIRegionAdd(json); }
    void builderMidiRegionRemove(const std::string& json) { builderMIDIRegionRemove(json); }
    void builderMidiRegionUpdate(const std::string& json) { builderMIDIRegionUpdate(json); }
    void builderAutomationLaneAdd(const std::string& json);
    void builderAutomationLaneRemove(const std::string& json);
    void builderAutomationLaneUpdate(const std::string& json);
    void builderAutomationPointAdd(const std::string& json);
    void builderAutomationPointRemove(const std::string& json);
    void builderAutomationPointsReplace(const std::string& json);
    void builderAutomationRecordGesture(const std::string& json);
    void setTrackSendFromJson(const std::string& json);
    void removeTrackSendFromJson(const std::string& json);
    void setProjectNameFromJson(const std::string& json);
    void builderTrackImportWAVUpload(int songIndex, int trackIndex, const std::string& tempWavPath,
                                     double startSeconds = 0.0,
                                     const std::string& requestId = {});
    void builderTrackImportWAVDialog(const std::string& json);
    void builderTrackImportWavUpload(int songIndex, int trackIndex, const std::string& tempWavPath,
                                     double startSeconds = 0.0,
                                     const std::string& requestId = {}) {
        builderTrackImportWAVUpload(songIndex, trackIndex, tempWavPath, startSeconds, requestId);
    }
    void builderTrackImportWavDialog(const std::string& json) {
        builderTrackImportWAVDialog(json);
    }
    void builderBusAdd();
    void builderBusRemove(const std::string& json);
    void builderBusMove(const std::string& json);
    void builderBusUpdate(const std::string& json);
    void builderEventAdd(const std::string& json);
    void builderEventRemove(const std::string& json);
    void builderEventMove(const std::string& json);
    void builderEventUpdate(const std::string& json);
    void builderSectionAdd(const std::string& json);
    void builderSectionRemove(const std::string& json);
    void builderSectionUpdate(const std::string& json);
    void builderCycleUpdate(const std::string& json);

    void lightingSetConfig(const std::string& json);
    void lightingFixtureAdd(const std::string& json);
    void lightingFixtureDuplicate(const std::string& json);
    void lightingFixtureRemove(const std::string& json);
    void lightingFixtureUpdate(const std::string& json);
    void lightingTrackAdd(const std::string& json);
    void lightingTrackRemove(const std::string& json);
    void lightingTrackMove(const std::string& json);
    void lightingTrackUpdate(const std::string& json);
    void lightingCueAdd(const std::string& json);
    void lightingCueRemove(const std::string& json);
    void lightingCueUpdate(const std::string& json);

    void settingsSetAudioOutputDevice(const std::string& json);
    void settingsSetAudioInputDevice(const std::string& json);
    void settingsSetAudioDeviceType(const std::string& json);
    void settingsShowAudioControlPanel();
    // Snapshots the live device's rate/buffer/channels into
    // AppSettings::deviceProfiles. Call before leaving a device and after
    // changing its routing.
    void rememberCurrentDeviceProfile();
    void settingsSetSampleRate(const std::string& json);
    void settingsSetBufferSize(const std::string& json);
    void settingsSetMIDIOutput(const std::string& json);
    void settingsSetMIDIInput(const std::string& json);
    void settingsSetMIDIVirtualPort(const std::string& json);
    void settingsSetMidiOutput(const std::string& json) { settingsSetMIDIOutput(json); }
    void settingsSetMidiInput(const std::string& json) { settingsSetMIDIInput(json); }
    void settingsSetMidiVirtualPort(const std::string& json) { settingsSetMIDIVirtualPort(json); }
    void settingsSetUiRenderEngine(const std::string& json);
    void settingsSetTheme(const std::string& json);
    void settingsSetKeybinding(const std::string& json);
    void settingsSetCountInBars(const std::string& json);
    void settingsSetOutputChannels(const std::string& json);
    void settingsSetInputChannels(const std::string& json);
    void settingsMIDILearn(const std::string& json);
    void settingsMIDILearnCancel();
    void settingsMIDIClear(const std::string& json);
    void settingsMidiLearn(const std::string& json) { settingsMIDILearn(json); }
    void settingsMidiLearnCancel() { settingsMIDILearnCancel(); }
    void settingsMidiClear(const std::string& json) { settingsMIDIClear(json); }
    void populateSettingsState(WebUiState::SettingsRow& out);
    // Snapshot of everything in the settings payload that has to be asked of
    // the OS -- audio device enumeration (a full CoreAudio HAL rescan) and the
    // MIDI endpoint lists. Refreshed on a slow timer from
    // populateSettingsState(), not per telemetry frame; see there for why.
    struct HardwareSettingsCache {
        std::vector<std::string> outputDevices;
        std::string currentOutputDevice;
        std::vector<std::string> inputDevices;
        std::string currentInputDevice;
        // Host audio APIs this build can drive (ASIO / CoreAudio / ALSA /
        // JACK / Windows Audio ...). More than one only on Windows and Linux.
        std::vector<std::string> audioDrivers;
        std::string currentAudioDriver;
        bool hasControlPanel = false;
        double sampleRate = 0.0;
        int bufferSize = 0;
        std::vector<double> availableSampleRates;
        std::vector<int> availableBufferSizes;
        std::vector<std::string> outputChannelNames;
        std::vector<bool> activeOutputChannels;
        std::vector<std::string> inputChannelNames;
        std::vector<bool> activeInputChannels;
        double inputLatencyMs = 0.0;
        double outputLatencyMs = 0.0;
        double roundtripLatencyMs = 0.0;
        std::vector<std::string> midiOutputs;
        std::vector<std::string> midiInputs;
        std::string currentMidiInput;
        bool virtualMidiPortEnabled = false;
    };
    HardwareSettingsCache hardwareSettingsCache;
    juce::uint32 hardwareSettingsCacheMs = 0;
    void rescanHardwareSettings();
    // Forces the next populateSettingsState() to re-ask the OS. Call after
    // anything that deliberately changes the device/MIDI setup, so the UI does
    // not wait out the slow refresh to show what the user just picked.
    void invalidateHardwareSettingsCache();
    void handleMidiLearnMessage(MidiTriggerType type, int channel1to16, int number);
    void handleMIDILearnMessage(MidiTriggerType type, int channel1to16, int number) {
        handleMidiLearnMessage(type, channel1to16, number);
    }

    void transportSeek(const std::string& json);
    void maybePublishPeaks();
    std::string buildPeaksJson() const;
    int lastPeaksPublishSongIndex = -2;
    bool lastPeaksPublishComplete = false;
    int lastPeaksPublishFilledCount = -1;

    void maybePublishAllPeaks();
    std::string buildAllPeaksJson() const;
    int lastAllPeaksBuiltCount = -1;
    bool lastAllPeaksComplete = false;
    juce::uint32 lastPeaksPublishMs = 0;
    juce::uint32 lastAllPeaksPublishMs = 0;

    bool wasHardwareAlarm = false;
    int startupTicks = 0;
    // Bumped by performAction() every time it actually executes a recognized
    // action -- MIDI (CoreMidiInputListener::onAction), the Electron menu bar,
    // and web action POSTs all funnel through that one method, so this single
    // pair covers all input paths without duplicating per-path tracking.
    // SettingsScreen compares lastAction_ against each
    // binding row to flash only the row that actually fired.
    int lastActionNonce_{0};
    std::string lastAction_;

    // Idle-behavior fade state for the WebUiState preview feed (mirrors
    // LightEngine's own thread-local state in threadLoop, so the preview and
    // the real DMX output both fade to/from blackout/staticColor/effect at
    // the same rate via the shared blendTowardIdle + kIdleFadeSeconds -- see
    // publishWebState). `lightingPreviewLastResolved` is the last non-idle
    // resolve, `lightingPreviewLastFrame` the previous frame's output, and
    // `lightingPreviewResumeFrom` the idle output captured when the override
    // turned off -- the three "from" snapshots the fades start from.
    bool lightingPreviewWasIdleFading = false;
    std::chrono::steady_clock::time_point lightingPreviewIdleFadeStart;
    std::vector<ResolvedFixtureOutput> lightingPreviewLastResolved;
    bool lightingPreviewWasResumeFading = false;
    std::chrono::steady_clock::time_point lightingPreviewResumeFadeStart;
    std::vector<ResolvedFixtureOutput> lightingPreviewResumeFrom;
    std::vector<ResolvedFixtureOutput> lightingPreviewLastFrame;

    UDPDiscovery udpDiscovery;
    std::string bindAddress_ = "0.0.0.0";
    double lastTogglePlaybackTime_{0.0};

    std::thread audioRenderThread;
    std::atomic<bool> audioRenderRunning{false};
    std::atomic<bool> cancelAudioRender{false};

    // Message-thread FIFO for commands accepted while an import/save owns the
    // document. In-order draining keeps multi-file track-add/upload batches
    // intact; only immediate stop/cancel commands may bypass it.
    static constexpr size_t kMaximumDeferredCommands = 1024;
    static constexpr size_t kMaximumDeferredCommandBytes = 4 * 1024 * 1024;
    std::deque<WebCommand> deferredWebCommands;
    size_t deferredWebCommandBytes = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};

} // namespace resostage
