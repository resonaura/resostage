#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "AppSettings.h"
#include "AudioEngine.h"
#include "midi/CoreMidiInputListener.h"
#include "ui/BusyOverlay.h"
#include "ui/DevOrEmbeddedWebView.h"
#include "ui/WebLoadingOverlay.h"
#include "web/WebServer.h"

#include <memory>
#include <unordered_map>
#include <utility>
#include <vector>

namespace resostage {

// App shell: full-window embedded SPA (Web UI) + blocking busy overlay.
// All editing / transport / settings live in the React remote; there is no
// native Player/Mixer/Builder/Settings panel fallback anymore.
class MainComponent final : public juce::Component, private juce::Timer {
public:
    MainComponent();
    ~MainComponent() override;

    void paint(juce::Graphics&) override;
    void resized() override;
    bool keyPressed(const juce::KeyPress& key) override;

    void confirmQuitIfUnsaved(std::function<void(bool)> onDecision = nullptr);
    void checkAndOfferAutosaveRecovery();

    void handleTouchBarTab(const std::string& tabId);
    void setTouchBarPeer(void* nsViewPeer);

    bool loadProjectFromPath(const juce::File& file);

    /** Called from native menu bar and MacKeyMonitor hotkey dispatch. */
    void performAction(const std::string& action);

    /** Expose active key bindings for Mac menu bar update. */
    const std::unordered_map<std::string, std::string>& getKeyBindings() const { return keyBindings; }

private:
    AudioEngine engine;
    WebServer webServer;
    CoreMidiInputListener midiInput;
    static constexpr uint16_t kWebPort = 2899;

    // Rig-wide preferences (hotkeys, MIDI bindings, audio/MIDI device setup)
    // -- global across every project/set, loaded once at startup from
    // Application Support (see AppSettings.h) and rewritten to disk on every
    // change from the Settings screen. NOT part of Project/engine.project().
    AppSettings appSettings;
    void saveAppSettingsToDisk();

    juce::Label alarmBanner;
    std::unique_ptr<DevOrEmbeddedWebView> webView;
    BusyOverlay busyOverlay;
    WebLoadingOverlay webLoadingOverlay;
    bool wasBusyLastTick = false;
    // When true, the SPA has a text/input/textarea focused so native hotkey
    // processing is suppressed and keystrokes pass through for normal typing.
    std::atomic<bool> editableFieldFocused{false};
    // Mirrored into WebUiState::statusMessage (no native status bar anymore).
    std::string lastStatusMessage;

    bool awaitingQuitDecision = false;
    std::function<void(bool)> pendingQuitDecision;

    void* touchBarPeer = nullptr;
    std::string touchBarActiveTab;
    std::string lastSeenSpaView;
    void syncTouchBarToTab(const std::string& tabId);

    std::unordered_map<std::string, std::string> keyBindings = {
        {"play", "space"},
        {"stop", "escape"},
        {"next", "n"},
        {"prev", "p"},
        {"mode_player", "f1"},
        {"mode_mixer", "f2"},
        {"mode_editor", "f3"},
        {"mode_settings", "f4"},
        {"section_prev", "["},
        {"section_next", "]"},
        {"section_last", "end"},
        {"undo", "cmd + z"},
        {"redo", "cmd + shift + z"},
    };
    // Additional bindings where the same action maps to multiple keys.
    // These are checked in matchAndPerformAction after the main map.
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
    void applyGlobalBindings();
    void jumpToSectionRelative(int delta);
    void jumpToLastSection();
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

    // Shared by the WebCommandKind::TimelineUndo/Redo dispatch (web/remote)
    // and performAction("undo"/"redo") (native hotkeys/MIDI) so both entry
    // points share one implementation instead of duplicating it.
    void performTimelineUndo();
    void performTimelineRedo();

    // Hotkey dispatch. On Mac the monitor passes macKeyCode/juceMods for
    // physical-keyCode matching (cross-layout Cmd+Z etc.).
    bool matchAndPerformAction(const juce::KeyPress& key,
                               uint16_t macKeyCode = 0,
                               int juceMods = 0);

    // Convert a keybinding description ("cmd + z", "space") to Mac
    // virtual keyCode + JUCE modifier mask. Returns (0, 0) on failure.
    static std::pair<uint16_t, int> descriptionToMacKeyCode(const std::string& desc);

    // Native folder picker when web sends import without a path (rare).
    void importSongFolderNative();

    void builderSongAdd(const std::string& json);
    void builderSongImportFolder(const std::string& json);
    void builderSongRemove(const std::string& json);
    void builderSongMove(const std::string& json);
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

    void settingsSetAudioOutputDevice(const std::string& json);
    void settingsSetSampleRate(const std::string& json);
    void settingsSetBufferSize(const std::string& json);
    void settingsSetMidiOutput(const std::string& json);
    void settingsSetMidiInput(const std::string& json);
    void settingsSetMidiVirtualPort(const std::string& json);
    void settingsSetKeybinding(const std::string& json);
    void settingsSetOutputChannels(const std::string& json);
    void settingsMidiLearn(const std::string& json);
    void settingsMidiLearnCancel();
    void settingsMidiClear(const std::string& json);
    void populateSettingsState(WebUiState::SettingsRow& out);
    void handleMidiLearnMessage(MidiTriggerType type, int channel1to16, int number);

    void transportSeek(const std::string& json);
    void maybePublishPeaks();
    std::string buildPeaksJson() const;
    int lastPeaksPublishSongIndex = -2;
    bool lastPeaksPublishComplete = false;

    void maybePublishAllPeaks();
    std::string buildAllPeaksJson() const;
    int lastAllPeaksBuiltCount = -1;
    bool lastAllPeaksComplete = false;
    juce::uint32 lastPeaksPublishMs = 0;
    juce::uint32 lastAllPeaksPublishMs = 0;

    bool wasHardwareAlarm = false;
    int startupTicks = 0;
    // Bumped by performAction() every time it actually executes a recognized
    // action -- native hotkey (MacKeyMonitor), MIDI (CoreMidiInputListener::
    // onAction), and the macOS menu bar all funnel through that one method,
    // so this single pair covers all three input paths without duplicating
    // per-path tracking. SettingsScreen compares lastAction_ against each
    // binding row to flash only the row that actually fired.
    int lastActionNonce_{0};
    std::string lastAction_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};

} // namespace resostage
