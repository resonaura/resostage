#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "AudioEngine.h"
#include "ui/UiColors.h"

#include <functional>

namespace resoset {

// Multi-lane timeline for the current song: track rows with peak-overview
// waveforms, event markers, bar grid (BPM / time signature), playhead, zoom,
// and a song-section marker ruler (Intro/Verse/Chorus/... structural tags).
class TimelineView final : public juce::Component {
public:
    explicit TimelineView(AudioEngine& engineRef);

    void paint(juce::Graphics&) override;
    void resized() override;
    void mouseWheelMove(const juce::MouseEvent&, const juce::MouseWheelDetails&) override;
    void mouseMagnify(const juce::MouseEvent&, float scaleFactor) override;
    void mouseDown(const juce::MouseEvent&) override;
    void mouseDrag(const juce::MouseEvent&) override;
    void mouseUp(const juce::MouseEvent&) override;
    void mouseDoubleClick(const juce::MouseEvent&) override;

    void refreshStructure();
    void refreshPlayhead();

    // Optional: seek request (samples/seconds) -- wired later if engine gains seek.
    std::function<void(double seconds)> onSeekRequest;

private:
    AudioEngine& engine;

    juce::Label title;
    juce::TextButton zoomIn{"+"};
    juce::TextButton zoomOut{"-"};
    juce::Label zoomLabel;

    double pixelsPerSecond = 40.0;
    double viewStartSeconds = 0.0;
    double playheadSeconds = 0.0;
    double songLengthSeconds = 0.0;
    double laneScrollOffset = 0.0; // px, vertical scroll across track lanes

    // engine.seekToSeconds() fully restages the song (disk decode + peak
    // rebuild) because StreamingTrackBuffer can only fast-forward, never seek
    // backward. Calling it on every mouseDrag pixel (JUCE fires that on every
    // mouse-move) would hammer the message thread with restages mid-gesture.
    // Instead: draw the preview triangle immediately from the raw mouse
    // position, but only commit an actual engine seek at a throttled cadence,
    // with a guaranteed final commit on mouseUp.
    bool isDragging = false;
    double dragPreviewSeconds = 0.0;
    juce::uint32 lastSeekCommitMs = 0;
    static constexpr juce::uint32 kSeekThrottleMs = 90;

    // Section-marker drag (repositioning an existing marker on the ruler).
    int draggingSectionIndex = -1;
    int selectedSectionIndex = -1; // set by double-clicking a marker; visual emphasis only

    juce::Rectangle<int> timelineArea;
    juce::Rectangle<int> markerRulerArea;
    static constexpr int kLaneHeaderW = 120;
    static constexpr int kLaneH = 28;
    static constexpr int kEventLaneH = 24;
    static constexpr int kMarkerRulerH = 16;

    double xToSeconds(int x) const;
    int secondsToX(double s) const;
    void clampView();
    void clampLaneScroll();
    void zoomAroundX(int x, double factor);
    int visibleLaneAreaHeight() const;

    // Section-marker helpers (mutate engine.project() directly -- markers
    // are pure organisational metadata with no audio/routing impact, so no
    // engine republish is needed after editing them).
    std::vector<SongSection>* currentSections();
    int sectionIndexAtX(int x) const;
    void showSectionContextMenu(int x, int existingIndex);
    void addSectionAt(double seconds, const juce::String& name);
};

} // namespace resoset
