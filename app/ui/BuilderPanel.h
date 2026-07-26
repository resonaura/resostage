#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "AudioEngine.h"
#include "ui/ClipTrimEditor.h"
#include "ui/UiColors.h"

#include <functional>

namespace resoset {

// Project structure editor: songs, tracks, events, global busses.
// Edits live Project state on the message thread; call onProjectEdited after
// structural changes so MainComponent can reselect/restage as needed.
class BuilderPanel final : public juce::Component,
                            private juce::ListBoxModel {
public:
    explicit BuilderPanel(AudioEngine& engineRef);

    void paint(juce::Graphics&) override;
    void resized() override;

    void refresh();

    std::function<void(int)> onSelectSong;      // stage song in engine
    std::function<void()> onProjectEdited;      // structure changed
    std::function<void()> onRoutingEdited;      // mix/routing-only change

    // Triggers MainComponent's Save As flow (file picker + engine.saveProject),
    // calling the given callback with whether it actually succeeded. Used by
    // WAV/folder import: both require an on-disk archive to write audio
    // into, which a brand-new (never-saved) project doesn't have yet --
    // rather than failing with an easy-to-miss error, prompt to save first
    // and continue automatically.
    std::function<void(std::function<void(bool)>)> onRequestSaveAs;

private:
    enum class ListTarget { Songs, Tracks, Events, Busses };

    // Reserved ComboBox item ID for "(none - sends only)" in trackBusBox,
    // chosen well outside the range of real bus indices (1..N).
    static constexpr int kNoBusComboId = 1000000;

    AudioEngine& engine;
    ListTarget activeList = ListTarget::Songs;

    juce::Label header;
    juce::TextButton songsTab{"Songs"};
    juce::TextButton tracksTab{"Tracks"};
    juce::TextButton eventsTab{"Events"};
    juce::TextButton bussesTab{"Busses"};

    juce::ListBox list{"BuilderList", this};

    // Persistent "which song am I editing" context, visible whenever the
    // Tracks/Events tab is active. Tracks/Events are always relative to
    // selectedSongRow regardless of which tab is showing, but with nothing
    // visible/editable outside the Songs tab that was invisible state --
    // this makes it an explicit, always-visible, always-changeable control
    // instead of a hidden dependency on whatever was last clicked in Songs.
    // Changing it never stages/restages playback -- purely an editing
    // context switch (see AudioEngine's songIndex-aware setters).
    juce::Label songContextLabel;
    juce::ComboBox songContextBox;

    juce::TextButton addButton{"Add"};
    juce::TextButton removeButton{"Remove"};
    juce::TextButton moveUpButton{"Up"};
    juce::TextButton moveDownButton{"Dn"};
    juce::TextButton importSongFolderButton{"Import Song Folder..."};

    // Song editor
    juce::Label songNameLabel;
    juce::TextEditor songNameEdit;
    juce::Label bpmLabel;
    juce::Slider bpmSlider;
    juce::Label modeLabel;
    juce::ComboBox modeBox;
    juce::Label tsLabel;
    juce::Slider tsNumSlider;
    juce::Slider tsDenSlider;
    juce::ToggleButton clickToggle{"Built-in click"};
    juce::ComboBox clickBusBox;
    juce::TextButton applySongButton{"Apply song settings"};

    // Track editor
    juce::Label trackNameLabel;
    juce::TextEditor trackNameEdit;
    juce::Label trackBusLabel;
    juce::ComboBox trackBusBox;
    juce::Label trackGainLabel;
    juce::Slider trackGainSlider;
    juce::Label trackPanLabel;
    juce::Slider trackPanSlider;
    juce::ToggleButton trackMute{"Mute"};
    juce::ToggleButton trackSolo{"Solo"};
    juce::Label trackFileLabel;
    juce::TextButton importWavButton{"Import WAV..."};
    // Waveform preview + trim handles ("Bundler Timeline Editor
    // Integration") -- see ClipTrimEditor's doc comment re: scope.
    juce::Label trackTrimLabel;
    ClipTrimEditor trackTrimEditor;
    juce::Label trackSendsLabel;
    juce::ComboBox trackSendBusBox;
    juce::Slider trackSendGainSlider;
    juce::ToggleButton trackSendPre{"Pre-fader"};
    juce::TextButton trackSendAddButton{"Add send"};
    juce::TextButton trackSendRemoveButton{"Remove last send"};
    juce::Label trackSendsListLabel;
    juce::TextButton applyTrackButton{"Apply track"};

    // Bus editor
    juce::Label busNameLabel;
    juce::TextEditor busNameEdit;
    juce::Label busOutLabel;
    // Labeled physical-channel picker ("1/2", "3/4", ... "13/14" for stereo;
    // "Ch 1".."Ch 16" for mono) rather than a raw channel-index slider --
    // item ID N (1-based) maps to output.startChannel = (N-1) * channelStep,
    // repopulated by refreshBusOutBox() whenever busChBox's mono/stereo
    // selection changes.
    juce::ComboBox busOutBox;
    juce::Label busGainLabel;
    juce::Slider busGainSlider;
    juce::Label busChLabel;
    juce::ComboBox busChBox;
    juce::ToggleButton busMute{"Mute"};
    juce::ToggleButton busSolo{"Solo"};
    juce::ToggleButton busIsAux{"Aux bus (monitor send target)"};
    juce::TextButton applyBusButton{"Apply bus"};

    // Event editor
    juce::Label eventTypeLabel;
    juce::ComboBox eventTypeBox;
    juce::Label eventTimeLabel;
    juce::Slider eventTimeSlider;
    juce::ToggleButton eventOnLoad{"Trigger on load"};
    juce::Label eventLatencyLabel;
    juce::Slider eventLatencySlider;
    juce::Label eventMidiChLabel;
    juce::Slider eventMidiChSlider;
    juce::Label eventMidiDataLabel;
    juce::Slider eventMidiData1Slider;
    juce::Slider eventMidiData2Slider;
    juce::Label eventHttpUrlLabel;
    juce::TextEditor eventHttpUrlEdit;
    juce::TextButton applyEventButton{"Apply event"};

    juce::Label emptyHint;
    std::unique_ptr<juce::FileChooser> fileChooser;
    std::unique_ptr<juce::FileChooser> folderChooser;
    std::unique_ptr<juce::AlertWindow> importSongDialog;

    int selectedSongRow = -1;
    int selectedItemRow = -1;

    int getNumRows() override;
    void paintListBoxItem(int row, juce::Graphics&, int w, int h, bool selected) override;
    void selectedRowsChanged(int last) override;

    void setListTarget(ListTarget t);
    void showSongEditor(bool show);
    void showTrackEditor(bool show);
    void showBusEditor(bool show);
    void showEventEditor(bool show);
    void loadSongEditor();
    void loadTrackEditor();
    void loadBusEditor();
    void loadEventEditor();
    void applySongSettings();
    void applyTrackSettings();
    void applyBusSettings();
    void applyEventSettings();
    void importWavClicked();
    void importSongFolderClicked();
    void promptSongFolderImport(const juce::File& folder);
    // Calls onReady() immediately if the project already has an on-disk
    // archive (engine.projectPath() non-empty); otherwise prompts to Save As
    // first (via onRequestSaveAs) and calls onReady() only if that succeeds.
    void ensureProjectSaved(std::function<void()> onReady);
    void refreshSongContextBox();
    void refreshBusOutBox();
    void fillBusCombo(juce::ComboBox& box);
    void addItem();
    void removeItem();
    void moveItem(int delta);
    static std::string makeUniqueId(const std::string& prefix, const std::vector<std::string>& used);
    SongDef* currentSong();
    const SongDef* currentSong() const;
    TrackDef* trackDefAtSelected();
};

} // namespace resoset
