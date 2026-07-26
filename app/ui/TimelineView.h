#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "AudioEngine.h"
#include "ui/UiColors.h"

#include <functional>

namespace resoset {

// Multi-lane timeline for the current song: track rows with peak-overview
// waveforms, event markers, bar grid (BPM / time signature), playhead, zoom.
class TimelineView final : public juce::Component {
public:
    explicit TimelineView(AudioEngine& engineRef);

    void paint(juce::Graphics&) override;
    void resized() override;
    void mouseWheelMove(const juce::MouseEvent&, const juce::MouseWheelDetails&) override;
    void mouseDown(const juce::MouseEvent&) override;
    void mouseDrag(const juce::MouseEvent&) override;
    void mouseUp(const juce::MouseEvent&) override;

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

    juce::Rectangle<int> timelineArea;
    static constexpr int kLaneHeaderW = 120;
    static constexpr int kLaneH = 28;
    static constexpr int kEventLaneH = 24;

    double xToSeconds(int x) const;
    int secondsToX(double s) const;
    void clampView();
};

} // namespace resoset
