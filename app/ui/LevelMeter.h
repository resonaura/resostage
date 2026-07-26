#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "telemetry/Telemetry.h"
#include "ui/UiColors.h"

#include <algorithm>

namespace resoset {

// Vertical peak meter with ballistic bar decay, peak-hold+decay indicator,
// extended headroom, and a persistent over-0dBFS clip latch. Fed externally
// via setLevel() (typically at ~30Hz from a polling timer elsewhere), but
// owns its own Timer so the displayed level keeps decaying smoothly even if
// the caller stops feeding it fresh values entirely (e.g. transport stops
// and the polling loop that reads engine meters pauses) -- otherwise the bar
// would freeze at its last amplitude instead of falling back to silence.
class LevelMeter final : public juce::Component, private juce::Timer {
public:
    LevelMeter() { startTimerHz(30); }
    ~LevelMeter() override { stopTimer(); }

    void setLevel(float newPeakDb) { inputDb = newPeakDb; }
    void setLevel(const MeterFrame& frame) { setLevel(frame.peakDb); }

    // Clicking the meter clears the latched clip indicator (matches the
    // spec: persists until "manually clicked or reset").
    void mouseDown(const juce::MouseEvent&) override {
        if (clipLatched) {
            clipLatched = false;
            repaint();
        }
    }

    void paint(juce::Graphics& g) override {
        auto bounds = getLocalBounds().toFloat().reduced(1.0f);
        g.setColour(ui::meterBg());
        g.fillRoundedRectangle(bounds, 3.0f);

        auto area = bounds;
        auto clipBox = area.removeFromTop(std::min(6.0f, area.getHeight() * 0.15f));
        area.removeFromTop(1.0f);

        if (area.getHeight() > 1.0f) {
            const float norm = normFor(displayDb);
            auto fill = area.removeFromBottom(area.getHeight() * norm);
            g.setColour(ui::meterGradientColor(displayDb));
            g.fillRoundedRectangle(fill, 3.0f);

            // Peak-hold line, coloured to match its own position on the gradient.
            if (peakDb > kFloorDb + 1.0f) {
                const float peakNorm = normFor(peakDb);
                const float y = bounds.getBottom() - (bounds.getHeight() - clipBox.getHeight() - 1.0f) * peakNorm;
                g.setColour(ui::meterGradientColor(peakDb));
                g.fillRect(bounds.getX(), y - 1.0f, bounds.getWidth(), 2.0f);
            }
        }

        // Persistent clip indicator strip along the top.
        g.setColour(clipLatched ? juce::Colour(0xffff383c) : ui::meterBg().brighter(0.1f));
        g.fillRect(clipBox);

        g.setColour(ui::border());
        g.drawRoundedRectangle(bounds, 3.0f, 1.0f);
    }

private:
    static constexpr float kFloorDb = -100.0f;    // effective "-inf" floor for ballistic math
    static constexpr float kRangeLowDb = -60.0f;   // bottom of the visible bar
    static constexpr float kRangeHighDb = 6.0f;    // top of the visible bar (extended headroom)
    static constexpr double kBarDecayDbPerSec = 20.0;
    static constexpr double kPeakHoldSeconds = 1.5;
    static constexpr double kPeakDecayDbPerSec = 20.0;

    static float normFor(float db) {
        return juce::jlimit(0.0f, 1.0f, (db - kRangeLowDb) / (kRangeHighDb - kRangeLowDb));
    }

    void timerCallback() override {
        const double now = juce::Time::getMillisecondCounterHiRes();
        // Clamp dt so a debugger pause / app-switch stall doesn't cause one
        // giant decay jump on the next tick.
        const double dt = lastTickMs > 0.0 ? juce::jlimit(0.0, 0.25, (now - lastTickMs) / 1000.0) : (1.0 / 30.0);
        lastTickMs = now;

        const float target = std::max(inputDb, kFloorDb);

        // Ballistic bar: instant attack (jumps straight up to a louder
        // signal), timed release back down -- never freezes even if
        // setLevel() stops being called, since `target` just stays at
        // whatever it was last fed and the release ballistic still runs
        // every tick off this component's own Timer.
        displayDb = target >= displayDb ? target
                                         : std::max(target, displayDb - static_cast<float>(kBarDecayDbPerSec * dt));

        // Peak-hold: instant attack, hold at the peak for kPeakHoldSeconds,
        // then decay exponentially (here: constant dB/sec, i.e. exponential
        // in linear gain) back down toward the current target.
        if (target >= peakDb) {
            peakDb = target;
            peakHoldRemaining = kPeakHoldSeconds;
        } else if (peakHoldRemaining > 0.0) {
            peakHoldRemaining -= dt;
        } else {
            peakDb = std::max(target, peakDb - static_cast<float>(kPeakDecayDbPerSec * dt));
        }

        if (target > 0.0f)
            clipLatched = true;

        repaint();
    }

    float inputDb = kFloorDb;   // last raw value handed in via setLevel()
    float displayDb = kFloorDb; // ballistic bar level (this tick's rendered fill)
    float peakDb = kFloorDb;    // held/decaying peak-hold line
    double peakHoldRemaining = 0.0;
    double lastTickMs = 0.0;
    bool clipLatched = false;
};

} // namespace resoset
