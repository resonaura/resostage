#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "AudioEngine.h"
#include "ui/legacy/TimelineView.h"
#include "ui/legacy/UiColors.h"

#include <functional>
#include <memory>

namespace resoset {

// Stage-focused playback view: transport, setlist, meters, timeline.
class PlayerPanel final : public juce::Component, private juce::ListBoxModel {
public:
    explicit PlayerPanel(AudioEngine& engineRef);
    ~PlayerPanel() override = default;

    void paint(juce::Graphics&) override;
    void resized() override;

    void refreshTransport();
    void refreshProject();
    void selectSongRow(int index);

    std::function<void()> onPlay;
    std::function<void()> onStop;
    std::function<void()> onNext;
    std::function<void()> onPrev;
    std::function<void(int)> onSelectSong;

private:
    AudioEngine& engine;

    juce::Label projectLabel;
    juce::Label playheadLabel;
    juce::Label barBeatLabel;
    juce::Label songMetaLabel;
    juce::Label healthLabel;
    juce::Label alarmLabel;

    juce::TextButton playButton{"Play"};
    juce::TextButton stopButton{"Stop"};
    juce::TextButton prevButton{"Prev"};
    juce::TextButton nextButton{"Next"};

    juce::ListBox setlist{"Setlist", this};
    juce::Rectangle<int> meterArea;
    TimelineView timeline;

    int getNumRows() override;
    void paintListBoxItem(int row, juce::Graphics&, int w, int h, bool selected) override;
    void selectedRowsChanged(int lastRowSelected) override;
    void paintMeters(juce::Graphics& g);
};

} // namespace resoset
