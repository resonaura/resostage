#include "ui/TimelineView.h"

#include <algorithm>
#include <cmath>

namespace resoset {

TimelineView::TimelineView(AudioEngine& engineRef) : engine(engineRef) {
    title.setText("TIMELINE", juce::dontSendNotification);
    title.setColour(juce::Label::textColourId, ui::muted());
    title.setFont(juce::Font(juce::FontOptions(11.0f, juce::Font::bold)));
    addAndMakeVisible(title);

    zoomOut.onClick = [this] {
        pixelsPerSecond = juce::jmax(8.0, pixelsPerSecond / 1.25);
        zoomLabel.setText(juce::String(pixelsPerSecond, 0) + " px/s", juce::dontSendNotification);
        repaint();
    };
    zoomIn.onClick = [this] {
        pixelsPerSecond = juce::jmin(400.0, pixelsPerSecond * 1.25);
        zoomLabel.setText(juce::String(pixelsPerSecond, 0) + " px/s", juce::dontSendNotification);
        repaint();
    };
    zoomOut.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    zoomIn.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    addAndMakeVisible(zoomOut);
    addAndMakeVisible(zoomIn);

    zoomLabel.setColour(juce::Label::textColourId, ui::muted());
    zoomLabel.setJustificationType(juce::Justification::centred);
    zoomLabel.setText("40 px/s", juce::dontSendNotification);
    addAndMakeVisible(zoomLabel);
}

void TimelineView::resized() {
    auto r = getLocalBounds().reduced(8);
    auto top = r.removeFromTop(22);
    title.setBounds(top.removeFromLeft(100));
    zoomIn.setBounds(top.removeFromRight(28));
    top.removeFromRight(4);
    zoomOut.setBounds(top.removeFromRight(28));
    top.removeFromRight(4);
    zoomLabel.setBounds(top.removeFromRight(70));
    r.removeFromTop(4);
    timelineArea = r;
}

void TimelineView::refreshStructure() {
    songLengthSeconds = engine.currentSongLengthSeconds();
    if (songLengthSeconds <= 0.0)
        songLengthSeconds = 60.0; // fallback visual span when unknown
    clampView();
    repaint();
}

void TimelineView::refreshPlayhead() {
    playheadSeconds = engine.transport().playheadSeconds.load(std::memory_order_relaxed);
    // Keep playhead roughly in view while playing.
    if (engine.isPlaying() && timelineArea.getWidth() > kLaneHeaderW) {
        const double viewW = static_cast<double>(timelineArea.getWidth() - kLaneHeaderW) / pixelsPerSecond;
        if (playheadSeconds < viewStartSeconds || playheadSeconds > viewStartSeconds + viewW * 0.85) {
            viewStartSeconds = juce::jmax(0.0, playheadSeconds - viewW * 0.25);
            clampView();
        }
    }
    repaint(timelineArea);
}

void TimelineView::clampView() {
    const double viewW = timelineArea.getWidth() > kLaneHeaderW
                             ? static_cast<double>(timelineArea.getWidth() - kLaneHeaderW) / pixelsPerSecond
                             : 10.0;
    const double maxStart = juce::jmax(0.0, songLengthSeconds - viewW * 0.5);
    viewStartSeconds = juce::jlimit(0.0, maxStart, viewStartSeconds);
}

double TimelineView::xToSeconds(int x) const {
    const int local = x - timelineArea.getX() - kLaneHeaderW;
    return viewStartSeconds + static_cast<double>(local) / pixelsPerSecond;
}

int TimelineView::secondsToX(double s) const {
    return timelineArea.getX() + kLaneHeaderW
           + static_cast<int>(std::lround((s - viewStartSeconds) * pixelsPerSecond));
}

void TimelineView::paint(juce::Graphics& g) {
    g.setColour(ui::panel());
    g.fillRoundedRectangle(getLocalBounds().toFloat().reduced(2.0f), 10.0f);
    g.setColour(ui::border());
    g.drawRoundedRectangle(getLocalBounds().toFloat().reduced(2.0f), 10.0f, 1.0f);

    if (timelineArea.isEmpty())
        return;

    auto area = timelineArea;
    g.setColour(ui::bg());
    g.fillRoundedRectangle(area.toFloat(), 6.0f);

    if (!engine.isProjectLoaded() || engine.currentSongIndex() == static_cast<size_t>(-1)
        || engine.currentSongIndex() >= engine.project().songs.size()) {
        g.setColour(ui::muted());
        g.drawText("Select a song to show the timeline", area, juce::Justification::centred);
        return;
    }

    const SongDef& song = engine.project().songs[engine.currentSongIndex()];
    const double bpm = song.bpm > 1.0 ? song.bpm : 120.0;
    const int num = juce::jmax(1, song.timeSignature.numerator);
    const double beatSec = 60.0 / bpm;
    const double barSec = beatSec * static_cast<double>(num);

    const int contentX = area.getX() + kLaneHeaderW;
    const int contentW = juce::jmax(1, area.getWidth() - kLaneHeaderW);
    const double viewEnd = viewStartSeconds + static_cast<double>(contentW) / pixelsPerSecond;

    // Grid: bars + beats
    const double firstBar = std::floor(viewStartSeconds / barSec) * barSec;
    for (double t = firstBar; t < viewEnd + barSec; t += beatSec) {
        const int x = secondsToX(t);
        if (x < contentX || x > area.getRight())
            continue;
        const bool isBar = std::abs(std::fmod(t + 1.0e-9, barSec)) < beatSec * 0.01
                           || std::abs(std::fmod(t + 1.0e-9, barSec) - barSec) < beatSec * 0.01;
        g.setColour(isBar ? ui::border().brighter(0.2f) : ui::border().withAlpha(0.45f));
        g.drawVerticalLine(x, static_cast<float>(area.getY()), static_cast<float>(area.getBottom()));
    }

    // Header column
    g.setColour(ui::panelAlt());
    g.fillRect(area.getX(), area.getY(), kLaneHeaderW, area.getHeight());
    g.setColour(ui::border());
    g.drawVerticalLine(contentX, static_cast<float>(area.getY()), static_cast<float>(area.getBottom()));

    int y = area.getY() + 4;

    // Track lanes
    const size_t trackCount = song.tracks.size();
    for (size_t i = 0; i < trackCount; ++i) {
        auto lane = juce::Rectangle<int>(area.getX(), y, area.getWidth(), kLaneH);
        if (lane.getBottom() > area.getBottom() - kEventLaneH - 4)
            break;

        g.setColour(i % 2 ? ui::panel().brighter(0.04f) : ui::panel());
        g.fillRect(lane.withX(contentX).withWidth(contentW));

        const TrackDef& tr = song.tracks[i];
        g.setColour(ui::text());
        g.setFont(juce::Font(juce::FontOptions(11.0f)));
        g.drawText(juce::String(tr.name.empty() ? tr.id : tr.name),
                   area.getX() + 6, y, kLaneHeaderW - 10, kLaneH, juce::Justification::centredLeft);

        // Clip + peak overview waveform for the visible range
        const int x0 = juce::jmax(contentX, secondsToX(0.0));
        const int x1 = juce::jmin(area.getRight(), secondsToX(songLengthSeconds));
        if (x1 > x0) {
            auto clip = juce::Rectangle<int>(x0, y + 4, x1 - x0, kLaneH - 8);
            juce::Colour c = ui::accent().withAlpha(tr.mute ? 0.18f : (tr.solo ? 0.45f : 0.28f));
            g.setColour(c);
            g.fillRoundedRectangle(clip.toFloat(), 3.0f);

            if (const PeakOverview* ov = engine.trackPeaksAt(i);
                ov != nullptr && !ov->peaks.empty() && songLengthSeconds > 0.0) {
                const int midY = clip.getCentreY();
                const int halfH = juce::jmax(2, clip.getHeight() / 2 - 1);
                g.setColour(ui::text().withAlpha(tr.mute ? 0.35f : 0.85f));
                const int bins = static_cast<int>(ov->peaks.size());
                for (int px = clip.getX(); px < clip.getRight(); ++px) {
                    const double t = xToSeconds(px);
                    if (t < 0.0 || t > songLengthSeconds)
                        continue;
                    const int bin = juce::jlimit(0, bins - 1,
                                                 static_cast<int>(t / songLengthSeconds * bins));
                    const float peak = ov->peaks[static_cast<size_t>(bin)];
                    const int h = juce::jmax(1, static_cast<int>(peak * static_cast<float>(halfH)));
                    g.drawVerticalLine(px, static_cast<float>(midY - h), static_cast<float>(midY + h));
                }
            }

            g.setColour(ui::border());
            g.drawRoundedRectangle(clip.toFloat(), 3.0f, 1.0f);
        }
        y += kLaneH;
    }

    // Event lane
    auto eventLane = juce::Rectangle<int>(area.getX(), y, area.getWidth(), kEventLaneH);
    if (eventLane.getBottom() <= area.getBottom()) {
        g.setColour(ui::panelAlt());
        g.fillRect(eventLane.withX(contentX).withWidth(contentW));
        g.setColour(ui::muted());
        g.setFont(juce::Font(juce::FontOptions(10.0f, juce::Font::bold)));
        g.drawText("EVENTS", area.getX() + 6, y, kLaneHeaderW - 10, kEventLaneH, juce::Justification::centredLeft);

        for (const TimelineEvent& ev : song.events) {
            if (ev.triggerOnLoad)
                continue;
            const int x = secondsToX(ev.timeSeconds);
            if (x < contentX - 4 || x > area.getRight() + 4)
                continue;
            juce::Colour c = ui::play();
            if (ev.type == EventType::Http)
                c = ui::warn();
            else if (ev.type == EventType::Dmx)
                c = juce::Colour(0xffc084fc);
            else if (ev.type == EventType::MidiCC)
                c = ui::accent();
            g.setColour(c);
            g.fillRect(x - 1, y + 4, 3, kEventLaneH - 8);
            g.setFont(juce::Font(juce::FontOptions(9.0f)));
            g.drawText(juce::String(ev.id), x + 4, y + 2, 80, kEventLaneH - 4, juce::Justification::centredLeft);
        }
    }

    // Playhead (while dragging, follow the mouse directly rather than waiting
    // for a throttled engine seek + telemetry round-trip to catch up).
    const int phx = secondsToX(isDragging ? dragPreviewSeconds : playheadSeconds);
    if (phx >= contentX && phx <= area.getRight()) {
        g.setColour(ui::stop());
        g.drawVerticalLine(phx, static_cast<float>(area.getY()), static_cast<float>(area.getBottom()));
        juce::Path tri;
        tri.addTriangle(static_cast<float>(phx - 5), static_cast<float>(area.getY()),
                        static_cast<float>(phx + 5), static_cast<float>(area.getY()),
                        static_cast<float>(phx), static_cast<float>(area.getY() + 8));
        g.fillPath(tri);
    }

    // Time ruler text
    g.setColour(ui::muted());
    g.setFont(juce::Font(juce::FontOptions(10.0f)));
    for (double t = firstBar; t < viewEnd; t += barSec) {
        const int x = secondsToX(t);
        if (x < contentX || x > area.getRight() - 30)
            continue;
        const int m = static_cast<int>(t) / 60;
        const double s = t - m * 60;
        g.drawText(juce::String::formatted("%d:%04.1f", m, s), x + 2, area.getY() + 2, 48, 12,
                   juce::Justification::centredLeft);
    }
}

void TimelineView::mouseWheelMove(const juce::MouseEvent& e, const juce::MouseWheelDetails& wheel) {
    if (e.mods.isCommandDown() || e.mods.isCtrlDown()) {
        const double factor = wheel.deltaY > 0 ? 1.15 : 1.0 / 1.15;
        pixelsPerSecond = juce::jlimit(8.0, 400.0, pixelsPerSecond * factor);
        zoomLabel.setText(juce::String(pixelsPerSecond, 0) + " px/s", juce::dontSendNotification);
    } else {
        viewStartSeconds -= wheel.deltaY * (40.0 / pixelsPerSecond);
        if (std::abs(wheel.deltaX) > 0.0)
            viewStartSeconds -= wheel.deltaX * (40.0 / pixelsPerSecond);
        clampView();
    }
    repaint();
}

void TimelineView::mouseDown(const juce::MouseEvent& e) {
    if (!timelineArea.contains(e.getPosition()))
        return;
    if (e.x < timelineArea.getX() + kLaneHeaderW)
        return;
    const double sec = juce::jmax(0.0, xToSeconds(e.x));
    isDragging = true;
    dragPreviewSeconds = sec;
    lastSeekCommitMs = juce::Time::getMillisecondCounter();
    if (onSeekRequest)
        onSeekRequest(sec);
    repaint(timelineArea);
}

void TimelineView::mouseDrag(const juce::MouseEvent& e) {
    if (!isDragging)
        return;
    const double sec = juce::jmax(0.0, xToSeconds(e.x));
    dragPreviewSeconds = sec;
    repaint(timelineArea); // cheap: just moves the preview triangle

    const juce::uint32 now = juce::Time::getMillisecondCounter();
    if (now - lastSeekCommitMs < kSeekThrottleMs)
        return; // skip the expensive restage; mouseUp guarantees a final commit
    lastSeekCommitMs = now;
    if (onSeekRequest)
        onSeekRequest(sec);
}

void TimelineView::mouseUp(const juce::MouseEvent&) {
    if (!isDragging)
        return;
    isDragging = false;
    // Always commit the final scrub position, even if the last drag sample
    // was skipped by the throttle above.
    if (onSeekRequest)
        onSeekRequest(dragPreviewSeconds);
}

} // namespace resoset
