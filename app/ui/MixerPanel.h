#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "AudioEngine.h"
#include "ui/MixerStrip.h"

#include <memory>
#include <vector>

namespace resoset {

// Horizontal strip mixer: current-song tracks + global busses.
class MixerPanel final : public juce::Component {
public:
    explicit MixerPanel(AudioEngine& engineRef);

    void paint(juce::Graphics&) override;
    void resized() override;

    // Rebuild strips when project/song changes.
    void refreshStructure();
    // Poll meters / keep fader state if needed.
    void refreshMeters();

private:
    AudioEngine& engine;
    juce::Label title;
    juce::Viewport viewport;
    juce::Component stripContainer;
    std::vector<std::unique_ptr<MixerStrip>> trackStrips;
    std::vector<std::unique_ptr<MixerStrip>> busStrips;
    juce::Label emptyLabel;   // shown instead of the whole mixer when no project is loaded
    juce::Label noTracksHint; // shown alongside busses/sends when a project is loaded but no song/tracks are staged
    // Inline Return (aux) bus creation -- see addReturnBusClicked(). Sits in
    // the top bar rather than the strip row so it stays put regardless of
    // scroll position.
    juce::TextButton addReturnBusButton{"+ Return"};

    void rebuildStrips();
    void layoutStrips();
    void addReturnBusClicked();
};

} // namespace resoset
