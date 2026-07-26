#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "AudioEngine.h"
#include "midi/CoreMidiInputListener.h"
#include "ui/BuilderPanel.h"
#include "ui/BusyOverlay.h"
#include "ui/MixerPanel.h"
#include "ui/PlayerPanel.h"
#include "ui/SettingsPanel.h"
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
    enum class Mode { Player, Mixer, Builder, Settings };

    AudioEngine engine;
    WebServer webServer;
    CoreMidiInputListener midiInput;
    static constexpr uint16_t kWebPort = 8080;

    // Top bar
    juce::Label appTitle;
    juce::Label projectTitle;
    juce::TextButton newButton{"New"};
    juce::TextButton loadButton{"Load..."};
    juce::TextButton saveButton{"Save"};
    juce::TextButton saveAsButton{"Save As..."};
    juce::TextButton playerTab{"Player"};
    juce::TextButton mixerTab{"Mixer"};
    juce::TextButton builderTab{"Builder"};
    juce::TextButton settingsTab{"Settings"};
    juce::Label statusLabel;
    juce::Label alarmBanner;

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

    Mode mode = Mode::Player;
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

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};

} // namespace resoset
