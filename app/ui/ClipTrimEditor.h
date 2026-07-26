#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "audio/PeakOverview.h"
#include "ui/UiColors.h"

#include <algorithm>
#include <functional>

namespace resoset {

// Lightweight waveform-preview + trim-handle widget for the Builder's clip
// import workflow ("Bundler Timeline Editor Integration"): lets the user
// see and adjust a track's clip boundaries before finishing an import.
//
// NOTE: this only edits TrackDef::trimStartSeconds/trimEndSeconds metadata
// (persisted in the project file). The playback/streaming engine does not
// currently clip reads to this range -- wiring real-time enforcement into
// StreamingTrackBuffer touches the same lock-free ring-buffer/skip-catchup
// path that live playback depends on, so it's deliberately left as a
// separate follow-up rather than risking that path here.
class ClipTrimEditor final : public juce::Component {
public:
    void setWaveform(const PeakOverview* overview, double totalDurationSeconds) {
        peaks = overview;
        duration = juce::jmax(0.0, totalDurationSeconds);
        trimStart = juce::jlimit(0.0, duration, trimStart);
        trimEnd = trimEnd <= 0.0 || trimEnd > duration ? duration : trimEnd;
        repaint();
    }

    // endSec <= 0 means "untrimmed end" (full duration).
    void setTrim(double startSec, double endSec) {
        trimStart = juce::jlimit(0.0, duration, startSec);
        trimEnd = (endSec <= 0.0 || endSec > duration) ? duration : endSec;
        repaint();
    }

    double trimStartSeconds() const { return trimStart; }
    // Returns 0.0 (== "untrimmed") when the end handle sits at the clip's
    // natural end, matching the "0 means unset" convention on TrackDef.
    double trimEndSecondsOrZeroIfFull() const { return trimEnd >= duration - 0.001 ? 0.0 : trimEnd; }

    std::function<void(double startSec, double endSecOrZero)> onTrimChanged;

    void paint(juce::Graphics& g) override {
        auto b = getLocalBounds().toFloat();
        g.setColour(ui::meterBg());
        g.fillRoundedRectangle(b, 4.0f);

        if (peaks != nullptr && !peaks->peaks.empty() && duration > 0.0) {
            const int bins = static_cast<int>(peaks->peaks.size());
            const float midY = b.getCentreY();
            const float halfH = b.getHeight() * 0.42f;
            g.setColour(ui::accent().withAlpha(0.75f));
            for (int x = 0; x < static_cast<int>(b.getWidth()); ++x) {
                const int bin = juce::jlimit(0, bins - 1,
                                             static_cast<int>((static_cast<float>(x) / b.getWidth()) * static_cast<float>(bins)));
                const float peak = peaks->peaks[static_cast<size_t>(bin)];
                const float h = juce::jmax(1.0f, peak * halfH);
                g.drawVerticalLine(static_cast<int>(b.getX()) + x, midY - h, midY + h);
            }
        }

        if (duration > 0.0) {
            const float xStart = xForSeconds(trimStart);
            const float xEnd = xForSeconds(trimEnd);
            g.setColour(juce::Colours::black.withAlpha(0.6f));
            if (xStart > b.getX())
                g.fillRect(b.withRight(xStart));
            if (xEnd < b.getRight())
                g.fillRect(b.withLeft(xEnd));

            g.setColour(ui::warn());
            g.fillRect(xStart - 2.0f, b.getY(), 4.0f, b.getHeight());
            g.fillRect(xEnd - 2.0f, b.getY(), 4.0f, b.getHeight());
        }

        g.setColour(ui::border());
        g.drawRoundedRectangle(b, 4.0f, 1.0f);
    }

    void mouseDown(const juce::MouseEvent& e) override {
        if (duration <= 0.0)
            return;
        const float xStart = xForSeconds(trimStart);
        const float xEnd = xForSeconds(trimEnd);
        const float dStart = std::abs(e.position.x - xStart);
        const float dEnd = std::abs(e.position.x - xEnd);
        const float kGrabPx = 8.0f;
        if (dStart <= kGrabPx || dEnd <= kGrabPx)
            draggingHandle = dStart <= dEnd ? 1 : 2;
        else
            draggingHandle = 0;
    }

    void mouseDrag(const juce::MouseEvent& e) override {
        if (draggingHandle == 0 || duration <= 0.0)
            return;
        const double sec = juce::jlimit(0.0, duration, secondsForX(e.position.x));
        if (draggingHandle == 1)
            trimStart = juce::jmin(sec, trimEnd - 0.05);
        else
            trimEnd = juce::jmax(sec, trimStart + 0.05);
        repaint();
    }

    void mouseUp(const juce::MouseEvent&) override {
        if (draggingHandle != 0 && onTrimChanged)
            onTrimChanged(trimStart, trimEndSecondsOrZeroIfFull());
        draggingHandle = 0;
    }

private:
    float xForSeconds(double s) const {
        return duration > 0.0
                   ? static_cast<float>(getX()) + static_cast<float>(s / duration) * static_cast<float>(getWidth())
                   : static_cast<float>(getX());
    }
    double secondsForX(float x) const {
        return getWidth() > 0
                   ? (static_cast<double>(x - static_cast<float>(getX())) / static_cast<double>(getWidth())) * duration
                   : 0.0;
    }

    const PeakOverview* peaks = nullptr;
    double duration = 0.0;
    double trimStart = 0.0;
    double trimEnd = 0.0;
    int draggingHandle = 0; // 0 = none, 1 = start handle, 2 = end handle
};

} // namespace resoset
