#pragma once

#include <cstdint>

namespace resoset {

// Synthesizes a metronome click (short decaying sine burst) at each beat,
// with an accented (louder, higher-pitched) click on beat 1 of each bar,
// driven by a song's BPM and beats-per-bar. Purely functional: render()
// computes the click waveform directly from an absolute sample position
// with no internal playback-position state to desync, so it composes
// naturally with StreamingTrackBuffer's catch-up jumps (the render loop can
// ask for the click pattern starting at any position, including one that
// skipped forward after a stall, and get the correct answer).
//
// This is the *built-in* generator (project.json: song.builtInClickEnabled).
// Bands that prefer a hand-recorded/produced click can just route an
// ordinary click.wav stem to a bus like any other track -- both are
// supported side by side.
class ClickGenerator {
public:
    void prepare(double sampleRateHz, double bpm, int beatsPerBar);

    // Renders `numFrames` mono samples starting at absolute sample position
    // `startSample` (relative to song start = sample 0) into `outMono`.
    void render(float* outMono, int numFrames, int64_t startSample) const;

private:
    double sampleRateHz = 48000.0;
    double bpm = 120.0;
    int beatsPerBar = 4;
};

} // namespace resoset
