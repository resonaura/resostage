#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "AppSettings.h"
#include "AudioEngine.h"
#include "lighting/LightOutputResolver.h"
#include "midi/CoreMidiInputListener.h"
#include "server/WebServer.h"
#include "ipc/IpcServer.h"

#include <chrono>
#include <memory>
#include <optional>
#include <string>
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
    // `ipcSocketPath`: если непусто, создаёт IPC‑сервер и посылает
    // {"type":"ready"} после открытия аудиоустройства (для Electron UI на
    // Linux/Windows/standalone-macOS). Пусто → IPC выключен (dev‑режим,
    // когда JUCE стартует Electron через --backend-port).
    // `webPort`: порт для WebServer (default 2899). Может переопределяться
    // через --backend-port при запуске в remote-режиме.
    explicit MainComponent(std::string ipcSocketPath = {}, uint16_t webPort = kWebPort);
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
    /** Called from Electron IPC when user opens .rsnrasetmeta or .rsnraset file. */
    void openProjectFromIpc(const std::string& path);
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
    CoreMidiInputListener midiInput;
public:
    static constexpr uint16_t kWebPort = 2899;
private:
    uint16_t webPort_ = kWebPort;

    // IPC канал к Electron UI (Windows/Linux: Unix domain socket, создаваемый
    // Core на старте; macOS пока запускается Electron как дочерний процесс).
    // Принимает сообщение {"type":"ready",...} после того, как аудиоустройство
    // открыто, чтобы Electron не пытался подключиться к серверу раньше времени.
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
        {"bar_prev", "left"},
        {"bar_next", "right"},
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

    // After structural edits from the web Builder: rebuild routing, stage a
    // song if needed. SPA re-renders from the next telemetry frame.
    void notifyProjectStructureChanged();
    void notifyRoutingChanged();

    // Shared by WebCommandKind::TimelineUndo/Redo and performAction("undo"/"redo").
    void performTimelineUndo();
    void performTimelineRedo();

    // Native folder picker when web sends import without a path (rare).
    void importSongFolderNative();

    void builderSongAdd(const std::string& json);
    void builderSongImportFolder(const std::string& json);
    void builderSongRemove(const std::string& json);
    void builderSongMove(const std::string& json);
    void builderSongEnd(const std::string& json);
    void builderSongUpdate(const std::string& json);
    void builderTrackAdd(const std::string& json);
    void builderTrackRemove(const std::string& json);
    void builderTrackMove(const std::string& json);
    void builderTrackUpdate(const std::string& json);
    void builderRegionAdd(const std::string& json);
    void builderRegionRemove(const std::string& json);
    void builderRegionUpdate(const std::string& json);
    void setTrackSendFromJson(const std::string& json);
    void removeTrackSendFromJson(const std::string& json);
    void setProjectNameFromJson(const std::string& json);
    void builderTrackImportWavUpload(int songIndex, int trackIndex, const std::string& tempWavPath);
    void builderTrackImportWavDialog(const std::string& json);
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
    void settingsSetAudioDeviceType(const std::string& json);
    // Snapshots the live device's rate/buffer/channels into
    // AppSettings::deviceProfiles. Call before leaving a device and after
    // changing its routing.
    void rememberCurrentDeviceProfile();
    void settingsSetSampleRate(const std::string& json);
    void settingsSetBufferSize(const std::string& json);
    void settingsSetMidiOutput(const std::string& json);
    void settingsSetMidiInput(const std::string& json);
    void settingsSetMidiVirtualPort(const std::string& json);
    void settingsSetUiRenderEngine(const std::string& json);
    void settingsSetKeybinding(const std::string& json);
    void settingsSetOutputChannels(const std::string& json);
    void settingsMidiLearn(const std::string& json);
    void settingsMidiLearnCancel();
    void settingsMidiClear(const std::string& json);
    void populateSettingsState(WebUiState::SettingsRow& out);
    // Snapshot of everything in the settings payload that has to be asked of
    // the OS -- audio device enumeration (a full CoreAudio HAL rescan) and the
    // MIDI endpoint lists. Refreshed on a slow timer from
    // populateSettingsState(), not per telemetry frame; see there for why.
    struct HardwareSettingsCache {
        std::vector<std::string> outputDevices;
        std::string currentOutputDevice;
        // Host audio APIs this build can drive (ASIO / CoreAudio / ALSA /
        // JACK / Windows Audio ...). More than one only on Windows and Linux.
        std::vector<std::string> audioDrivers;
        std::string currentAudioDriver;
        double sampleRate = 0.0;
        int bufferSize = 0;
        std::vector<double> availableSampleRates;
        std::vector<int> availableBufferSizes;
        std::vector<std::string> outputChannelNames;
        std::vector<bool> activeOutputChannels;
        std::vector<std::string> midiOutputs;
        std::vector<std::string> midiInputs;
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

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};

} // namespace resostage
