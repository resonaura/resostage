#pragma once

#include <cstdint>

namespace resostage {

// Synthesizes a metronome click (short decaying sine burst) at each beat,
// with an accented (louder, higher-pitched) click on beat 1 of each bar.
//
// Driven by BPM + full time signature:
//   - numerator  = beats per bar (strong accent every N beats)
//   - denominator = beat unit (stored with the grid for retarget/MIDI parity)
//
// render() is a pure function of an absolute sample position on the current
// tempo grid -- no hidden free-running phase that can desync strong/weak
// beats from the transport. The audio engine passes the song playhead so
// bar 1 / beat 1 of the arrangement always gets the accented click.
//
// retarget()/prepare() only update the grid (tempo + meter). They do not
// invent a second clock; musical position comes from the caller's startSample.
//
// This is the *built-in* generator (project.json: song.builtInClickEnabled).
class ClickGenerator {
public:
    // sampleRateHz: device rate.
    // bpm: project beat tempo (same unit as UI bar|beat / globalBeatsElapsed).
    // beatsPerBar: time-signature numerator (accent every N beats).
    // beatUnit: time-signature denominator (4 = quarter, 8 = eighth, ...).
    void prepare(double sampleRateHz, double bpm, int beatsPerBar, int beatUnit = 4);

    // Update tempo + meter. Idempotent; safe on every song hop / songUpdate.
    void retarget(double bpm, int beatsPerBar, int beatUnit = 4);

    // Renders `numFrames` mono samples starting at absolute sample position
    // `startSample` on the current tempo/meter grid into `outMono`.
    // startSample is typically the song playhead (0 = bar 1, beat 1 = strong).
    void render(float* outMono, int numFrames, int64_t startSample) const;

    double currentBpm() const { return bpm; }
    int currentBeatsPerBar() const { return beatsPerBar; }
    int currentBeatUnit() const { return beatUnit; }
    double currentSampleRate() const { return sampleRateHz; }

    // samples per one beat at the current BPM / SR (for tests / MIDI helpers).
    double samplesPerBeat() const;

private:
    double sampleRateHz = 48000.0;
    double bpm = 120.0;
    int beatsPerBar = 4;
    int beatUnit = 4;
};

} // namespace resostage
