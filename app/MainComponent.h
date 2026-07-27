#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "AudioEngine.h"
#include "midi/CoreMidiInputListener.h"
#include "ui/legacy/BuilderPanel.h"
#include "ui/legacy/BusyOverlay.h"
#include "ui/DevOrEmbeddedWebView.h"
#include "ui/legacy/MixerPanel.h"
#include "ui/legacy/PlayerPanel.h"
#include "ui/legacy/SettingsPanel.h"
#include "web/WebServer.h"

#include <memory>
#include <unordered_map>

namespace resoset {

// App shell: top bar (project + mode tabs) + Player / Mixer / Builder / Settings.
class MainComponent final : public juce::Component, private juce::Timer {
public:
    MainComponent();
    ~MainComponent() override;

    void paint(juce::Graphics&) override;
    void resized() override;
    bool keyPressed(const juce::KeyPress& key) override;

private:
    // Web is the default (and, per the "single UI" goal, primary) landing
    // view -- a HeroUI/Tailwind React remote with full parity for transport,
    // mixer, project lifecycle, and Builder structural editing. The native
    // panels stay reachable as tabs mainly as a fallback/dev tool now.
    enum class Mode { Web, Player, Mixer, Builder, Settings };

    AudioEngine engine;
    WebServer webServer;
    CoreMidiInputListener midiInput;
    static constexpr uint16_t kWebPort = 2899;

    // Top bar
    juce::Label appTitle;
    juce::Label projectTitle;
    juce::TextButton newButton{"New"};
    juce::TextButton loadButton{"Load..."};
    juce::TextButton saveButton{"Save"};
    juce::TextButton saveAsButton{"Save As..."};
    juce::TextButton webTab{"Web UI"};
    juce::TextButton playerTab{"Player"};
    juce::TextButton mixerTab{"Mixer"};
    juce::TextButton builderTab{"Builder"};
    juce::TextButton settingsTab{"Settings"};
    juce::Label statusLabel;
    juce::Label alarmBanner;

    // http://localhost:2900 (Vite dev server) first, falls back to whatever
    // the embedded WebServer below is serving. Constructed after webServer
    // so kWebPort is already known.
    std::unique_ptr<DevOrEmbeddedWebView> webView;
    PlayerPanel playerPanel;
    MixerPanel mixerPanel;
    BuilderPanel builderPanel;
    SettingsPanel settingsPanel;

    // Shown/animated from timerCallback() whenever engine.isBusy() (an async
    // WAV/song-folder import in flight) -- blocks all input so no concurrent
    // project edit can be silently lost when the import completes and
    // reloads the archive. Always on top of everything else.
    BusyOverlay busyOverlay;
    bool wasBusyLastTick = false;

    Mode mode = Mode::Web; // always the default landing view -- see setMode(Mode::Web) in the constructor
    std::unordered_map<std::string, std::string> keyBindings = {
        {"play", "space"},
        {"stop", "escape"},
        {"next", "n"},
        {"prev", "p"},
    };
    std::unique_ptr<juce::FileChooser> fileChooser;

    void timerCallback() override;

    void setMode(Mode m);
    void styleModeTab(juce::TextButton& b, Mode m);
    void newProjectClicked();
    void loadProjectClicked();
    // onDone, if given, is called with whether the save actually succeeded
    // (including "user cancelled the file picker" = false) -- lets callers
    // like BuilderPanel's folder-import flow chain "save first, then
    // continue" instead of leaving the user at a dead end.
    void saveProjectClicked(bool saveAs, std::function<void(bool)> onDone = nullptr);
    void applyProjectBindings();
    void performAction(const std::string& action);
    // If no song is currently staged and the project has at least one,
    // stages the first song -- called after project load and after any
    // structural edit (e.g. importing the first song into an empty
    // project), so the Player/Mixer/Timeline show something immediately
    // instead of an empty view until the user manually clicks a song.
    void ensureSongSelected();
    void goToSong(int index);
    void nextSong();
    void prevSong();
    void togglePlayback();
    void setStatus(const juce::String& text);
    void onProjectLoaded();
    void publishWebState();
    void drainWebCommands();

    // Builder structural-edit parity for the web UI -- see
    // MainComponentBuilder.cpp. Each mirrors the matching BuilderPanel.cpp
    // method (addItem/removeItem/moveItem/apply*Settings), just JSON-driven
    // instead of widget-driven, and finishes by invoking the same
    // builderPanel.onProjectEdited()/onRoutingEdited() hooks the native
    // Builder tab already uses to refresh everything else.
    void builderSongAdd(const std::string& json);
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
    void builderTrackImportWavUpload(int songIndex, int trackIndex, const std::string& tempWavPath);
    void builderBusAdd();
    void builderBusRemove(const std::string& json);
    void builderBusMove(const std::string& json);
    void builderBusUpdate(const std::string& json);
    void builderEventAdd(const std::string& json);
    void builderEventRemove(const std::string& json);
    void builderEventMove(const std::string& json);
    void builderEventUpdate(const std::string& json);

    // Settings parity for the web UI -- see MainComponentSettings.cpp.
    // Mirrors SettingsPanel.cpp's AudioDeviceSelectorComponent callbacks and
    // MIDI/keybinding row handlers, JSON-driven instead of widget-driven.
    void settingsSetAudioOutputDevice(const std::string& json);
    void settingsSetSampleRate(const std::string& json);
    void settingsSetBufferSize(const std::string& json);
    void settingsSetMidiOutput(const std::string& json);
    void settingsSetMidiInput(const std::string& json);
    void settingsSetKeybinding(const std::string& json);
    void settingsSetOutputChannels(const std::string& json);
    void populateSettingsState(WebUiState::SettingsRow& out);

    // Timeline parity for the web UI -- see MainComponentTimeline.cpp.
    void transportSeek(const std::string& json);
    // Publishes the staged song's per-track peak-overview JSON (see
    // WebServer::publishPeaks()) once right after a song change, then keeps
    // republishing each tick while the background peak build is still in
    // flight (rebuildTrackPeaks() runs off-thread -- see AudioEngine.cpp),
    // stopping once every track has real data. Called from timerCallback().
    void maybePublishPeaks();
    std::string buildPeaksJson() const;
    int lastPeaksPublishSongIndex = -2;
    bool lastPeaksPublishComplete = false;

    // Continuous multi-song timeline parity: same idea as maybePublishPeaks/
    // buildPeaksJson above, but covers every song's tracks (not just the
    // staged one) -- see AudioEngine::ensureAllSongPeaksBuilt().
    void maybePublishAllPeaks();
    std::string buildAllPeaksJson() const;
    int lastAllPeaksBuiltCount = -1;
    bool lastAllPeaksComplete = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};

} // namespace resoset
