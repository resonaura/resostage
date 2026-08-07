// Executes a MixGraph on the audio thread.
//
// One forward sweep over the strips, in the order buildMixGraph() laid them
// out. For each strip:
//
//   1. accumulate every incoming edge into `pre`
//   2. `post` = pre * fader * pan (mono-folded first when channels == 1)
//   3. capture the peak of `post` -- that is the meter, so it shows the fader,
//      the pan and every send mixed in, and never shows mute or someone
//      else's solo
//   4. outgoing edges read `post` (or `pre`, for pre-fader sends)
//
// Because that loop is the same four steps for a track, the metronome, an aux
// and the master, there is exactly one implementation of the fader law, the
// pan law, the mono fold and the meter tap in the whole engine.
//
// Real-time contract: the renderer does NOT own the graph. The audio thread
// passes in whichever graph it acquired for this block (see RoutingEngine)
// and the renderer only reads it, so a message-thread republish can never
// swap the graph out from under a half-finished sweep. Buffers are sized once
// by prepare() for a capacity; a graph that outgrows that capacity is refused
// (the block renders silence) rather than allocated for on the audio thread.
//
// JUCE-free on purpose so the mix can be driven headlessly from tests --
// see core/tests/test_mix_renderer.cpp.
#pragma once

#include "MixGraph.h"

#include <vector>

namespace resostage {

struct StripLevels {
    float peakL = 0.0f; // linear, post-fader/post-pan, pre-mute
    float peakR = 0.0f;
};

class MixRenderer {
public:
    // Message thread. Sizes every scratch buffer for the worst case this
    // renderer will be asked to handle. Headroom above the current project's
    // strip count is deliberate: adding a send must not have to reallocate
    // while the transport is running.
    void prepare(double sampleRate, int maxBlockSize, size_t maxStrips);

    size_t capacity() const { return stripCapacity; }
    bool canRender(const MixGraph& graph) const;

    // Audio thread. Clears the scratch for this block; call before writing
    // any source audio.
    void beginBlock(const MixGraph& graph, int numSamples);

    // Audio thread. Where the caller writes a source strip's decoded audio.
    // Always 2 channels: a stereo source writes both, a mono file writes the
    // same samples to each. Returns nullptr for an out-of-capacity strip.
    float* sourceChannel(uint32_t stripIndex, int channel);

    // Audio thread. Runs the sweep described at the top of this file.
    void process(const MixGraph& graph, int numSamples);

    // Audio thread, after process(). Post-fader/post-pan signal of a strip --
    // what its meter shows and what its outgoing edges carried.
    const float* postChannel(uint32_t stripIndex, int channel) const;

    // Audio thread, after process(). Peak of `post`, per strip.
    const StripLevels& levels(uint32_t stripIndex) const;

    // Audio thread, after process(). Sums every output lane into the device
    // buffers with `+=`, so a lane shared by Main and an aux send stacks
    // instead of one overwriting the other. Lanes whose physical channel is
    // currently gone (shadow lanes) write nowhere.
    void writeToOutputs(const MixGraph& graph, float* const* outputChannelData,
                        int numOutputChannels, int numSamples) const;

    // Audio thread. Drops all glide state, so the next block primes straight
    // to its target instead of sweeping up from a stale coefficient. Used
    // when the strip layout changed under us (a track was added/removed) or
    // after a transport gap, where a glide would be an audible artefact
    // rather than a de-click.
    void resetSmoothing();

private:
    struct Smoother {
        float gainL = 1.0f;
        float gainR = 1.0f;
        float monoMix = 0.0f; // 0 = stereo, 1 = folded to mono
        bool primed = false;
    };

    // ~10 ms exponential glide, so a fader move, a pan sweep or a mono toggle
    // ramps instead of stepping (a coefficient step inside a block is an
    // audible click).
    float smoothingCoefficient() const;

    double currentSampleRate = 48000.0;
    int maxBlock = 512;
    size_t stripCapacity = 0;

    // Strip i owns rows 2*i (L) and 2*i+1 (R) of each buffer.
    std::vector<float> preBuffer;
    std::vector<float> postBuffer;
    std::vector<StripLevels> stripLevels;
    std::vector<Smoother> stripSmoothers;
    // Glide state for edge gains, keyed by edge index. Rebuilt implicitly
    // whenever the edge count changes; -1 means "not primed yet".
    std::vector<float> edgeSmoothers;

    static const StripLevels kSilentLevels;

    float* preRow(uint32_t stripIndex, int channel);
    const float* preRow(uint32_t stripIndex, int channel) const;
    float* postRow(uint32_t stripIndex, int channel);
    const float* postRow(uint32_t stripIndex, int channel) const;
};

} // namespace resostage
