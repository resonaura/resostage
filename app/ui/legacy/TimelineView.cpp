#include "ui/legacy/TimelineView.h"

#include <algorithm>
#include <cmath>

namespace resoset {

TimelineView::TimelineView(AudioEngine& engineRef) : engine(engineRef) {
    title.setText("TIMELINE", juce::dontSendNotification);
    title.setColour(juce::Label::textColourId, ui::muted());
    title.setFont(juce::Font(juce::FontOptions(11.0f, juce::Font::bold)));
    addAndMakeVisible(title);

    zoomOut.onClick = [this] { zoomAroundX(timelineArea.getX() + kLaneHeaderW + (timelineArea.getWidth() - kLaneHeaderW) / 2, 1.0 / 1.25); };
    zoomIn.onClick = [this] { zoomAroundX(timelineArea.getX() + kLaneHeaderW + (timelineArea.getWidth() - kLaneHeaderW) / 2, 1.25); };
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
    markerRulerArea = timelineArea.withHeight(kMarkerRulerH);
    clampLaneScroll();
}

void TimelineView::refreshStructure() {
    songLengthSeconds = engine.currentSongLengthSeconds();
    if (songLengthSeconds <= 0.0)
        songLengthSeconds = 60.0; // fallback visual span when unknown
    clampView();
    laneScrollOffset = 0.0;
    selectedSectionIndex = -1;
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

int TimelineView::visibleLaneAreaHeight() const {
    return juce::jmax(0, timelineArea.getHeight() - kMarkerRulerH - kEventLaneH - 8);
}

void TimelineView::clampLaneScroll() {
    if (!engine.isProjectLoaded() || engine.currentSongIndex() == static_cast<size_t>(-1)
        || engine.currentSongIndex() >= engine.project().songs.size()) {
        laneScrollOffset = 0.0;
        return;
    }
    const size_t trackCount = engine.trackCount();
    const double contentH = static_cast<double>(trackCount) * kLaneH;
    const double maxScroll = juce::jmax(0.0, contentH - static_cast<double>(visibleLaneAreaHeight()));
    laneScrollOffset = juce::jlimit(0.0, maxScroll, laneScrollOffset);
}

void TimelineView::zoomAroundX(int x, double factor) {
    if (timelineArea.isEmpty())
        return;
    const double anchorSeconds = xToSeconds(x);
    pixelsPerSecond = juce::jlimit(8.0, 400.0, pixelsPerSecond * factor);
    const int contentX = timelineArea.getX() + kLaneHeaderW;
    const double localPx = static_cast<double>(x - contentX);
    viewStartSeconds = anchorSeconds - localPx / pixelsPerSecond;
    clampView();
    zoomLabel.setText(juce::String(pixelsPerSecond, 0) + " px/s", juce::dontSendNotification);
    repaint();
}

double TimelineView::xToSeconds(int x) const {
    const int local = x - timelineArea.getX() - kLaneHeaderW;
    return viewStartSeconds + static_cast<double>(local) / pixelsPerSecond;
}

int TimelineView::secondsToX(double s) const {
    return timelineArea.getX() + kLaneHeaderW
           + static_cast<int>(std::lround((s - viewStartSeconds) * pixelsPerSecond));
}

std::vector<SongSection>* TimelineView::currentSections() {
    if (!engine.isProjectLoaded() || engine.currentSongIndex() == static_cast<size_t>(-1))
        return nullptr;
    Project& proj = engine.project();
    if (engine.currentSongIndex() >= proj.songs.size())
        return nullptr;
    return &proj.songs[engine.currentSongIndex()].sections;
}

int TimelineView::sectionIndexAtX(int x) const {
    auto* sections = const_cast<TimelineView*>(this)->currentSections();
    if (sections == nullptr)
        return -1;
    for (size_t i = 0; i < sections->size(); ++i) {
        const int mx = secondsToX((*sections)[i].startSeconds);
        if (std::abs(mx - x) <= 5)
            return static_cast<int>(i);
    }
    return -1;
}

void TimelineView::addSectionAt(double seconds, const juce::String& name) {
    std::vector<SongSection>* sections = currentSections();
    if (sections == nullptr)
        return;
    SongSection s;
    s.id = "sec_" + std::to_string(sections->size() + 1) + "_" + std::to_string(static_cast<long long>(seconds * 1000));
    s.name = name.toStdString();
    s.startSeconds = juce::jmax(0.0, seconds);
    s.colorIndex = static_cast<int>(sections->size());
    sections->push_back(std::move(s));
    std::sort(sections->begin(), sections->end(),
              [](const SongSection& a, const SongSection& b) { return a.startSeconds < b.startSeconds; });
    repaint(markerRulerArea);
}

void TimelineView::showSectionContextMenu(int x, int existingIndex) {
    std::vector<SongSection>* sections = currentSections();
    if (sections == nullptr)
        return;
    const double seconds = xToSeconds(x);

    juce::PopupMenu menu;
    if (existingIndex >= 0) {
        menu.addItem(100, "Rename...");
        menu.addItem(101, "Delete Marker");
        menu.addSeparator();
    }
    menu.addItem(1, "Intro");
    menu.addItem(2, "Verse");
    menu.addItem(3, "Chorus");
    menu.addItem(4, "Bridge");
    menu.addItem(5, "Outro");
    menu.addItem(6, "Custom...");

    menu.showMenuAsync(juce::PopupMenu::Options(), [this, seconds, existingIndex](int result) {
        std::vector<SongSection>* secs = currentSections();
        if (secs == nullptr || result == 0)
            return;
        if (result == 101 && existingIndex >= 0 && existingIndex < static_cast<int>(secs->size())) {
            secs->erase(secs->begin() + existingIndex);
            selectedSectionIndex = -1;
            repaint(markerRulerArea);
            return;
        }
        if (result == 100 && existingIndex >= 0 && existingIndex < static_cast<int>(secs->size())) {
            auto* aw = new juce::AlertWindow("Rename Marker", "", juce::MessageBoxIconType::NoIcon);
            aw->addTextEditor("name", juce::String((*secs)[static_cast<size_t>(existingIndex)].name), "Name:");
            aw->addButton("OK", 1, juce::KeyPress(juce::KeyPress::returnKey));
            aw->addButton("Cancel", 0, juce::KeyPress(juce::KeyPress::escapeKey));
            aw->enterModalState(true, juce::ModalCallbackFunction::create([aw, this, existingIndex](int r) {
                std::unique_ptr<juce::AlertWindow> owned(aw);
                std::vector<SongSection>* s2 = currentSections();
                if (r == 1 && s2 != nullptr && existingIndex < static_cast<int>(s2->size()))
                    (*s2)[static_cast<size_t>(existingIndex)].name = aw->getTextEditorContents("name").toStdString();
                repaint(markerRulerArea);
            }));
            return;
        }
        static const std::unordered_map<int, const char*> presets = {
            {1, "Intro"}, {2, "Verse"}, {3, "Chorus"}, {4, "Bridge"}, {5, "Outro"},
        };
        if (auto it = presets.find(result); it != presets.end()) {
            if (existingIndex >= 0 && existingIndex < static_cast<int>(secs->size()))
                (*secs)[static_cast<size_t>(existingIndex)].name = it->second;
            else
                addSectionAt(seconds, it->second);
            repaint(markerRulerArea);
        } else if (result == 6) {
            addSectionAt(seconds, "Custom");
            repaint(markerRulerArea);
        }
    });
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

    SongDef& song = engine.project().songs[engine.currentSongIndex()];
    const double bpm = song.bpm > 1.0 ? song.bpm : 120.0;
    const int num = juce::jmax(1, song.timeSignature.numerator);
    const double beatSec = 60.0 / bpm;
    const double barSec = beatSec * static_cast<double>(num);

    const int contentX = area.getX() + kLaneHeaderW;
    const int contentW = juce::jmax(1, area.getWidth() - kLaneHeaderW);
    const double viewEnd = viewStartSeconds + static_cast<double>(contentW) / pixelsPerSecond;
    const int gridTop = area.getY() + kMarkerRulerH;

    // Grid: bars + beats (below the marker ruler strip).
    const double firstBar = std::floor(viewStartSeconds / barSec) * barSec;
    for (double t = firstBar; t < viewEnd + barSec; t += beatSec) {
        const int x = secondsToX(t);
        if (x < contentX || x > area.getRight())
            continue;
        const bool isBar = std::abs(std::fmod(t + 1.0e-9, barSec)) < beatSec * 0.01
                           || std::abs(std::fmod(t + 1.0e-9, barSec) - barSec) < beatSec * 0.01;
        g.setColour(isBar ? ui::border().brighter(0.2f) : ui::border().withAlpha(0.45f));
        g.drawVerticalLine(x, static_cast<float>(gridTop), static_cast<float>(area.getBottom()));
    }

    // Section-marker region overlays: a subtle vertical colour band from
    // each marker to the next (or song end), spanning the full lane height.
    const std::vector<SongSection>& sections = song.sections;
    for (size_t i = 0; i < sections.size(); ++i) {
        const double startS = sections[i].startSeconds;
        const double endS = (i + 1 < sections.size()) ? sections[i + 1].startSeconds : songLengthSeconds;
        if (endS <= viewStartSeconds || startS >= viewEnd)
            continue;
        const int x0 = juce::jmax(contentX, secondsToX(startS));
        const int x1 = juce::jmin(area.getRight(), secondsToX(endS));
        if (x1 <= x0)
            continue;
        const juce::Colour c = ui::trackColorForIndex(sections[i].colorIndex);
        const bool selected = static_cast<int>(i) == selectedSectionIndex;
        g.setColour(c.withAlpha(selected ? 0.16f : 0.07f));
        g.fillRect(x0, gridTop, x1 - x0, area.getBottom() - gridTop);
        if (selected) {
            g.setColour(c.withAlpha(0.5f));
            g.drawRect(x0, gridTop, x1 - x0, area.getBottom() - gridTop, 1);
        }
    }

    // Header column
    g.setColour(ui::panelAlt());
    g.fillRect(area.getX(), gridTop, kLaneHeaderW, area.getBottom() - gridTop);
    g.setColour(ui::border());
    g.drawVerticalLine(contentX, static_cast<float>(gridTop), static_cast<float>(area.getBottom()));

    // Track lanes -- clipped to the lane band so vertical scroll doesn't
    // paint over the marker ruler or event lane.
    const int lanesClipTop = gridTop + 1;
    const int lanesClipBottom = juce::jmax(lanesClipTop, area.getBottom() - kEventLaneH - 4);
    int y = gridTop + 4 - static_cast<int>(std::lround(laneScrollOffset));
    const size_t trackCount = engine.trackCount();
    {
        juce::Graphics::ScopedSaveState clipState(g);
        g.reduceClipRegion(area.getX(), lanesClipTop, area.getWidth(), lanesClipBottom - lanesClipTop);

        for (size_t i = 0; i < trackCount; ++i) {
            if (y + kLaneH < lanesClipTop) { y += kLaneH; continue; } // scrolled above view
            if (y > lanesClipBottom) break;                          // scrolled below view

            auto lane = juce::Rectangle<int>(area.getX(), y, area.getWidth(), kLaneH);
            g.setColour(i % 2 ? ui::panel().brighter(0.04f) : ui::panel());
            g.fillRect(lane.withX(contentX).withWidth(contentW));

            const TrackDef* trPtr = engine.trackDefAt(i);
            if (!trPtr) continue;
            const TrackDef& tr = *trPtr;
            const juce::Colour trackColor = ui::trackColorForIndex(static_cast<int>(i));
            g.setColour(trackColor);
            g.fillRect(area.getX(), y, 3, kLaneH);
            g.setColour(ui::text());
            g.setFont(juce::Font(juce::FontOptions(11.0f)));
            g.drawText(juce::String(tr.name.empty() ? tr.id : tr.name),
                       area.getX() + 8, y, kLaneHeaderW - 12, kLaneH, juce::Justification::centredLeft);

            // Clip + peak overview waveform for the visible range
            const int x0 = juce::jmax(contentX, secondsToX(0.0));
            const int x1 = juce::jmin(area.getRight(), secondsToX(songLengthSeconds));
            if (x1 > x0) {
                auto clip = juce::Rectangle<int>(x0, y + 4, x1 - x0, kLaneH - 8);
                juce::Colour c = trackColor.withAlpha(tr.mute ? 0.15f : (tr.solo ? 0.4f : 0.24f));
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
    }

    // Event lane (below the (possibly scrolled) track lanes -- position
    // tracks wherever the loop above left off, same as before scroll support).
    auto eventLane = juce::Rectangle<int>(area.getX(), y, area.getWidth(), kEventLaneH);
    if (eventLane.getBottom() <= area.getBottom() && y >= gridTop) {
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
                c = ui::accentColor(ui::Accent::Purple);
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
        g.drawVerticalLine(phx, static_cast<float>(gridTop), static_cast<float>(area.getBottom()));
        juce::Path tri;
        tri.addTriangle(static_cast<float>(phx - 5), static_cast<float>(gridTop),
                        static_cast<float>(phx + 5), static_cast<float>(gridTop),
                        static_cast<float>(phx), static_cast<float>(gridTop + 8));
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
        g.drawText(juce::String::formatted("%d:%04.1f", m, s), x + 2, gridTop + 2, 48, 12,
                   juce::Justification::centredLeft);
    }

    // Section-marker ruler strip (top of the timeline, above the bar grid).
    g.setColour(ui::panelAlt().brighter(0.03f));
    g.fillRect(area.getX(), area.getY(), area.getWidth(), kMarkerRulerH);
    for (size_t i = 0; i < sections.size(); ++i) {
        const int mx = secondsToX(sections[i].startSeconds);
        if (mx < contentX - 4 || mx > area.getRight() + 4)
            continue;
        const juce::Colour c = ui::trackColorForIndex(sections[i].colorIndex);
        juce::Path flag;
        flag.startNewSubPath(static_cast<float>(mx), static_cast<float>(area.getY()));
        flag.lineTo(static_cast<float>(mx + 6), static_cast<float>(area.getY()) + kMarkerRulerH * 0.5f);
        flag.lineTo(static_cast<float>(mx), static_cast<float>(area.getY() + kMarkerRulerH));
        flag.closeSubPath();
        g.setColour(c);
        g.fillPath(flag);
        g.setFont(juce::Font(juce::FontOptions(9.0f, juce::Font::bold)));
        g.drawText(juce::String(sections[i].name), mx + 9, area.getY(), 100, kMarkerRulerH,
                   juce::Justification::centredLeft);
    }
}

void TimelineView::mouseWheelMove(const juce::MouseEvent& e, const juce::MouseWheelDetails& wheel) {
    if (e.mods.isCommandDown() || e.mods.isCtrlDown()) {
        zoomAroundX(e.x, wheel.deltaY > 0 ? 1.15 : 1.0 / 1.15);
        return;
    }

    // Trackpad two-finger scroll: horizontal component pans time, vertical
    // component scrolls the track lanes. Shift+scroll forces a
    // vertical-wheel device's motion into horizontal time panning instead
    // (the classic "no horizontal wheel" mouse convention).
    const bool forceHorizontal = e.mods.isShiftDown();
    double dx = wheel.deltaX;
    double dy = wheel.deltaY;
    if (forceHorizontal && dx == 0.0) {
        dx = dy;
        dy = 0.0;
    }

    if (dx != 0.0) {
        viewStartSeconds -= dx * (400.0 / pixelsPerSecond);
        clampView();
    }
    if (dy != 0.0) {
        laneScrollOffset -= dy * 120.0;
        clampLaneScroll();
    }
    repaint();
}

void TimelineView::mouseMagnify(const juce::MouseEvent& e, float scaleFactor) {
    // Trackpad pinch gesture (macOS). scaleFactor > 1 == fingers spreading (zoom in).
    zoomAroundX(e.x, static_cast<double>(scaleFactor));
}

void TimelineView::mouseDown(const juce::MouseEvent& e) {
    if (!timelineArea.contains(e.getPosition()))
        return;

    if (markerRulerArea.contains(e.getPosition())) {
        const int idx = sectionIndexAtX(e.x);
        if (e.mods.isPopupMenu()) {
            showSectionContextMenu(e.x, idx);
            return;
        }
        if (idx >= 0) {
            draggingSectionIndex = idx;
            return;
        }
        return;
    }

    if (e.x < timelineArea.getX() + kLaneHeaderW)
        return;
    if (e.mods.isPopupMenu()) {
        showSectionContextMenu(e.x, -1); // right-click in the grid also offers "add marker here"
        return;
    }
    const double sec = juce::jmax(0.0, xToSeconds(e.x));
    isDragging = true;
    dragPreviewSeconds = sec;
    lastSeekCommitMs = juce::Time::getMillisecondCounter();
    if (onSeekRequest)
        onSeekRequest(sec);
    repaint(timelineArea);
}

void TimelineView::mouseDrag(const juce::MouseEvent& e) {
    if (draggingSectionIndex >= 0) {
        std::vector<SongSection>* sections = currentSections();
        if (sections != nullptr && draggingSectionIndex < static_cast<int>(sections->size())) {
            (*sections)[static_cast<size_t>(draggingSectionIndex)].startSeconds = juce::jmax(0.0, xToSeconds(e.x));
            repaint(timelineArea);
        }
        return;
    }

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
    if (draggingSectionIndex >= 0) {
        std::vector<SongSection>* sections = currentSections();
        if (sections != nullptr)
            std::sort(sections->begin(), sections->end(),
                      [](const SongSection& a, const SongSection& b) { return a.startSeconds < b.startSeconds; });
        draggingSectionIndex = -1;
        repaint(timelineArea);
    }

    if (!isDragging)
        return;
    isDragging = false;
    // Always commit the final scrub position, even if the last drag sample
    // was skipped by the throttle above.
    if (onSeekRequest)
        onSeekRequest(dragPreviewSeconds);
}

void TimelineView::mouseDoubleClick(const juce::MouseEvent& e) {
    if (markerRulerArea.contains(e.getPosition())) {
        const int idx = sectionIndexAtX(e.x);
        if (idx >= 0) {
            // Double-click an existing marker: select its region (visual
            // emphasis in the lane overlay) rather than editing it.
            selectedSectionIndex = (selectedSectionIndex == idx) ? -1 : idx;
            repaint(timelineArea);
        } else {
            addSectionAt(xToSeconds(e.x), "Marker");
        }
    }
}

} // namespace resoset
