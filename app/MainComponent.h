#pragma once

#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include "AudioEngine.h"

#include <memory>

namespace resoset {

// Milestone 1's deliberately throwaway test UI. Enough to verify the engine
// on real hardware (device/channel selection, project load, transport,
// per-bus meters, an underrun-simulation button) -- not the designed
// timeline/mixer UI, which lands with the embedded web server in a later
// milestone.
class MainComponent final : public juce::Component,
                             private juce::Timer,
                             private juce::ListBoxModel {
public:
    MainComponent();
    ~MainComponent() override;

    void paint(juce::Graphics&) override;
    void resized() override;
    bool keyPressed(const juce::KeyPress& key) override;

private:
    AudioEngine engine;

    std::unique_ptr<juce::AudioDeviceSelectorComponent> deviceSelector;
    juce::TextButton loadProjectButton{"Load .rsnraset..."};
    juce::TextButton playButton{"Play (Space)"};
    juce::TextButton stopButton{"Stop"};
    juce::TextButton nextButton{"Next Song (N)"};
    juce::TextButton prevButton{"Prev Song (P)"};
    juce::TextButton simulateUnderrunButton{"Simulate 500ms Underrun"};
    juce::Label statusLabel;
    juce::Label playheadLabel;
    juce::ListBox songListBox{"Songs", this};
    juce::Rectangle<int> meterArea;

    std::unique_ptr<juce::FileChooser> fileChooser;

    void timerCallback() override;

    int getNumRows() override;
    void paintListBoxItem(int rowNumber, juce::Graphics&, int width, int height, bool rowIsSelected) override;
    void selectedRowsChanged(int lastRowSelected) override;

    void loadProjectClicked();
    void goToSong(int index);
    void nextSong();
    void prevSong();
    void togglePlayback();
    void setStatus(const juce::String& text);
    void paintBusMeters(juce::Graphics&);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};

} // namespace resoset
