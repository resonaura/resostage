#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include <algorithm>

namespace resoset {

class WebLoadingOverlay final : public juce::Component {
public:
    enum class State { FadingIn, Visible, FadingOut, Hidden };

    WebLoadingOverlay() {
        setInterceptsMouseClicks(false, false);
    }

    void startLoading() {
        state = State::FadingIn;
        fadeAlpha = 0.0f;
        setVisible(true);
        repaint();
    }

    void dismiss() {
        if (state != State::Hidden && state != State::FadingOut) {
            state = State::FadingOut;
        }
    }

    // Call on timer tick (~30Hz)
    void tickAnimation() {
        if (state == State::FadingIn) {
            fadeAlpha = std::min(kTargetAlpha, fadeAlpha + 0.08f);
            if (fadeAlpha >= kTargetAlpha) {
                state = State::Visible;
            }
            repaint();
        } else if (state == State::FadingOut) {
            fadeAlpha = std::max(0.0f, fadeAlpha - 0.06f);
            if (fadeAlpha <= 0.0f) {
                state = State::Hidden;
                setVisible(false);
            }
            repaint();
        }
    }

    bool isDone() const { return state == State::Hidden; }

    void paint(juce::Graphics& g) override {
        const float bgAlpha = std::clamp(fadeAlpha / kTargetAlpha, 0.0f, 1.0f);
        g.fillAll(juce::Colours::black.withAlpha(bgAlpha));

        g.setColour(juce::Colours::white.withAlpha(fadeAlpha));
        juce::Font font(juce::FontOptions(18.0f).withStyle("Thin"));
        g.setFont(font);
        g.drawText("Loading...", getLocalBounds(), juce::Justification::centred, false);
    }

private:
    static constexpr float kTargetAlpha = 0.45f;
    State state = State::Hidden;
    float fadeAlpha = 0.0f;
};

} // namespace resoset
