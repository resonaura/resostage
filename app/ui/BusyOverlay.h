#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "ui/UiColors.h"

namespace resoset {

// Full-window blocking overlay shown while AudioEngine::isBusy() (an async
// import in flight). Intercepts all mouse input so nothing underneath can be
// clicked -- concurrent project edits during an import would be silently
// lost when the import's background-thread snapshot overwrites the live
// project on completion (see AudioEngine::importSongFromFolderAsync's doc).
// The caller (MainComponent) drives visibility/animation from its own timer.
class BusyOverlay final : public juce::Component {
public:
    BusyOverlay() {
        setInterceptsMouseClicks(true, true);
        message.setJustificationType(juce::Justification::centred);
        message.setColour(juce::Label::textColourId, ui::text());
        message.setFont(juce::Font(juce::FontOptions(15.0f, juce::Font::bold)));
        addAndMakeVisible(message);
    }

    void setMessage(const juce::String& text) { message.setText(text, juce::dontSendNotification); }

    // Call once per timer tick while visible to animate the spinner.
    void advanceSpinner(float degreesPerTick) {
        spinAngle += degreesPerTick;
        if (spinAngle > 360.0f)
            spinAngle -= 360.0f;
        repaint(spinnerBounds());
    }

    void paint(juce::Graphics& g) override {
        g.fillAll(ui::bg().withAlpha(0.85f));

        const auto bounds = spinnerBounds().toFloat();
        const float thickness = 4.0f;
        g.setColour(ui::border());
        g.drawEllipse(bounds, thickness);

        juce::Path arc;
        arc.addArc(bounds.getX(), bounds.getY(), bounds.getWidth(), bounds.getHeight(),
                   juce::degreesToRadians(spinAngle), juce::degreesToRadians(spinAngle + 110.0f), true);
        g.setColour(ui::accent());
        g.strokePath(arc, juce::PathStrokeType(thickness, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
    }

    void resized() override {
        auto r = getLocalBounds();
        message.setBounds(r.getCentreX() - 150, r.getCentreY() + 30, 300, 24);
    }

private:
    juce::Label message{"", "Working..."};
    float spinAngle = 0.0f;

    juce::Rectangle<int> spinnerBounds() const {
        const auto r = getLocalBounds();
        constexpr int d = 40;
        return {r.getCentreX() - d / 2, r.getCentreY() - d / 2 - 10, d, d};
    }
};

} // namespace resoset
