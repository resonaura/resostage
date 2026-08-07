#include "MixRenderer.h"

#include "MixMath.h"

#include <algorithm>
#include <cmath>

namespace resostage {

const StripLevels MixRenderer::kSilentLevels{};

void MixRenderer::prepare(double sampleRate, int maxBlockSize, size_t maxStrips) {
    currentSampleRate = sampleRate > 0.0 ? sampleRate : 48000.0;
    maxBlock = std::max(1, maxBlockSize);
    stripCapacity = maxStrips;

    const size_t samples = stripCapacity * 2 * static_cast<size_t>(maxBlock);
    preBuffer.assign(samples, 0.0f);
    postBuffer.assign(samples, 0.0f);
    stripLevels.assign(stripCapacity, StripLevels{});
    stripSmoothers.assign(stripCapacity, Smoother{});
    edgeSmoothers.clear();
}

bool MixRenderer::canRender(const MixGraph& graph) const {
    return graph.strips.size() <= stripCapacity && maxBlock > 0;
}

void MixRenderer::resetSmoothing() {
    std::fill(stripSmoothers.begin(), stripSmoothers.end(), Smoother{});
    std::fill(edgeSmoothers.begin(), edgeSmoothers.end(), -1.0f);
}

float MixRenderer::smoothingCoefficient() const {
    const float sr = static_cast<float>(std::max(1.0, currentSampleRate));
    return 1.0f - std::exp(-1.0f / (0.010f * sr));
}

float* MixRenderer::preRow(uint32_t stripIndex, int channel) {
    return preBuffer.data()
           + (static_cast<size_t>(stripIndex) * 2 + static_cast<size_t>(channel))
                 * static_cast<size_t>(maxBlock);
}

const float* MixRenderer::preRow(uint32_t stripIndex, int channel) const {
    return preBuffer.data()
           + (static_cast<size_t>(stripIndex) * 2 + static_cast<size_t>(channel))
                 * static_cast<size_t>(maxBlock);
}

float* MixRenderer::postRow(uint32_t stripIndex, int channel) {
    return postBuffer.data()
           + (static_cast<size_t>(stripIndex) * 2 + static_cast<size_t>(channel))
                 * static_cast<size_t>(maxBlock);
}

const float* MixRenderer::postRow(uint32_t stripIndex, int channel) const {
    return postBuffer.data()
           + (static_cast<size_t>(stripIndex) * 2 + static_cast<size_t>(channel))
                 * static_cast<size_t>(maxBlock);
}

void MixRenderer::beginBlock(const MixGraph& graph, int numSamples) {
    if (!canRender(graph))
        return;
    const size_t span = static_cast<size_t>(std::min(numSamples, maxBlock));
    for (uint32_t s = 0; s < graph.strips.size(); ++s) {
        std::fill_n(preRow(s, 0), span, 0.0f);
        std::fill_n(preRow(s, 1), span, 0.0f);
    }
}

float* MixRenderer::sourceChannel(uint32_t stripIndex, int channel) {
    if (stripIndex >= stripCapacity || channel < 0 || channel > 1)
        return nullptr;
    return preRow(stripIndex, channel);
}

const float* MixRenderer::postChannel(uint32_t stripIndex, int channel) const {
    if (stripIndex >= stripCapacity || channel < 0 || channel > 1)
        return nullptr;
    return postRow(stripIndex, channel);
}

const StripLevels& MixRenderer::levels(uint32_t stripIndex) const {
    if (stripIndex >= stripLevels.size())
        return kSilentLevels;
    return stripLevels[stripIndex];
}

void MixRenderer::process(const MixGraph& graph, int numSamples) {
    if (!canRender(graph))
        return;
    const int span = std::min(numSamples, maxBlock);
    if (span <= 0)
        return;

    // Edge glide state is positional. Resizing here is the one allocation on
    // this path and it only happens when the topology actually changed (a
    // send added or removed), never for a knob move.
    if (edgeSmoothers.size() != graph.edges.size())
        edgeSmoothers.assign(graph.edges.size(), -1.0f);

    const float alpha = smoothingCoefficient();

    // Edges are sorted by destination and every edge runs from a lower strip
    // index to a higher one, so one shared cursor walks them in lockstep with
    // the strip sweep -- each strip's inputs are finished before it is
    // processed, and each strip is processed before it is used as an input.
    size_t edgeCursor = 0;

    for (uint32_t s = 0; s < graph.strips.size(); ++s) {
        const MixStrip& strip = graph.strips[s];

        // 1. Accumulate inputs.
        float* destL = preRow(s, 0);
        float* destR = preRow(s, 1);
        const bool destStereo = strip.channels >= 2;

        while (edgeCursor < graph.edges.size() && graph.edges[edgeCursor].to == s) {
            const MixEdge& edge = graph.edges[edgeCursor];
            const size_t edgeIndex = edgeCursor;
            ++edgeCursor;
            if (!edge.active || edge.from >= graph.strips.size())
                continue;

            // Post-fader sends carry the source's own fader and pan (already
            // baked into `post`); pre-fader sends bypass them by reading the
            // untouched input sum.
            const float* srcL = edge.preFader ? preRow(edge.from, 0) : postRow(edge.from, 0);
            const float* srcR = edge.preFader ? preRow(edge.from, 1) : postRow(edge.from, 1);

            float& smoothed = edgeSmoothers[edgeIndex];
            if (smoothed < 0.0f)
                smoothed = edge.gainLinear;

            // Settled send level -- true for every block in which nobody has a
            // hand on that fader, i.e. almost all of them. Once `smoothed`
            // equals the target the glide recursion adds exactly zero, so
            // hoisting it out is bit-identical; what it buys is a loop the
            // compiler can vectorise instead of a serial dependency chain, and
            // that matters because this is the loop that runs once per send
            // per source (tracks x sends, the thing that grows fastest on a
            // big rig).
            if (smoothed == edge.gainLinear) {
                const float g = smoothed;
                if (destStereo) {
                    for (int i = 0; i < span; ++i) {
                        destL[i] += srcL[i] * g;
                        destR[i] += srcR[i] * g;
                    }
                } else if (edge.sourceChannel == 0) {
                    for (int i = 0; i < span; ++i)
                        destL[i] += srcL[i] * g;
                } else if (edge.sourceChannel == 1) {
                    for (int i = 0; i < span; ++i)
                        destL[i] += srcR[i] * g;
                } else {
                    for (int i = 0; i < span; ++i)
                        destL[i] += mix_math::monoSum(srcL[i], srcR[i]) * g;
                }
                continue;
            }

            const float smoothedAtBlockStart = smoothed;
            for (int i = 0; i < span; ++i) {
                smoothed += alpha * (edge.gainLinear - smoothed);
                if (destStereo) {
                    destL[i] += srcL[i] * smoothed;
                    destR[i] += srcR[i] * smoothed;
                } else {
                    // A one-channel destination takes exactly one signal:
                    // the left source channel, the right one, or their sum.
                    const float mono = edge.sourceChannel == 0 ? srcL[i]
                                       : edge.sourceChannel == 1
                                           ? srcR[i]
                                           : mix_math::monoSum(srcL[i], srcR[i]);
                    destL[i] += mono * smoothed;
                }
            }

            // Land it. `x += alpha*(target-x)` approaches the target but
            // stalls short of it: once alpha*(target-x) is below the last bit
            // of x the addition is a no-op and the glide freezes ~1.4e-5 out
            // (-97 dBFS), forever unequal. Without this the fast path above
            // would switch itself off permanently the first time anyone
            // touched a send. Snapping only when a whole block moved the value
            // nowhere means the step taken here is, by construction, one the
            // float could not represent anyway.
            if (smoothed == smoothedAtBlockStart)
                smoothed = edge.gainLinear;
        }

        // 2 + 3. Fader, pan, mono fold, meter.
        float* outL = postRow(s, 0);
        float* outR = postRow(s, 1);

        float targetL = 0.0f;
        float targetR = 0.0f;
        mix_math::panGains(strip.gainLinear, strip.pan, targetL, targetR);
        const float targetMono = strip.channels == 1 ? 1.0f : 0.0f;

        // Where a one-channel strip's single signal comes from. A source
        // strip is handed stereo audio by the caller, so it genuinely folds
        // L+R. Everything else was fed by edges, and the edge loop above
        // already collapsed into channel 0 for a one-channel destination --
        // folding again here would average in the empty right side and cost
        // 6 dB on every output lane.
        const bool foldsOwnStereo =
            strip.kind == StripKind::Track || strip.kind == StripKind::Click;

        Smoother& smoother = stripSmoothers[s];
        if (!smoother.primed) {
            smoother.gainL = targetL;
            smoother.gainR = targetR;
            smoother.monoMix = targetMono;
            smoother.primed = true;
        }

        float peakL = 0.0f;
        float peakR = 0.0f;

        // Settled: all three glide states sit exactly on their targets, so
        // every `x += alpha * (target - x)` below is a no-op and `monoMix` is
        // exactly 0 or exactly 1. Splitting that case out costs nothing in
        // fidelity -- the arithmetic left in each branch is the general
        // expression with the constant substituted in, so the samples are
        // bit-identical -- and it is what makes a 32-lane output rig cheap,
        // because an output lane is settled from its very first block (its
        // fader and pan are constants the graph never changes).
        const bool settled = smoother.gainL == targetL && smoother.gainR == targetR
                             && smoother.monoMix == targetMono;

        if (settled && targetMono == 1.0f) {
            // Mono strip: both sides carry the same `mid`.
            for (int i = 0; i < span; ++i) {
                const float inL = std::isfinite(destL[i]) ? destL[i] : 0.0f;
                const float inR = std::isfinite(destR[i]) ? destR[i] : 0.0f;
                const float mid = foldsOwnStereo ? mix_math::monoSum(inL, inR) : inL;
                // Written as the general lerp with monoMix == 1 rather than
                // plain `mid`, because `a + (b - a)` is not exactly `b` in
                // IEEE arithmetic and this must not drift from the slow path.
                const float wetL = (inL + (mid - inL)) * targetL;
                const float wetR = (inR + (mid - inR)) * targetR;
                outL[i] = wetL;
                outR[i] = wetR;
                peakL = std::max(peakL, std::abs(wetL));
                peakR = std::max(peakR, std::abs(wetR));
            }
        } else if (settled) {
            // Stereo strip: monoMix == 0, so the fold lerp is the identity.
            for (int i = 0; i < span; ++i) {
                const float inL = std::isfinite(destL[i]) ? destL[i] : 0.0f;
                const float inR = std::isfinite(destR[i]) ? destR[i] : 0.0f;
                const float wetL = inL * targetL;
                const float wetR = inR * targetR;
                outL[i] = wetL;
                outR[i] = wetR;
                peakL = std::max(peakL, std::abs(wetL));
                peakR = std::max(peakR, std::abs(wetR));
            }
        } else {
            // Something is still gliding: run the full recursion per sample.
            const Smoother atBlockStart = smoother;
            for (int i = 0; i < span; ++i) {
                smoother.gainL += alpha * (targetL - smoother.gainL);
                smoother.gainR += alpha * (targetR - smoother.gainR);
                smoother.monoMix += alpha * (targetMono - smoother.monoMix);

                // A denormal or a NaN from a decoder must not poison the whole
                // downstream mix, so it is scrubbed at the one point every
                // signal passes through.
                const float inL = std::isfinite(destL[i]) ? destL[i] : 0.0f;
                const float inR = std::isfinite(destR[i]) ? destR[i] : 0.0f;

                // Crossfade stereo <-> mono so the mono toggle does not click.
                // At monoMix == 1 both sides carry `mid`, which is what lets a
                // mono bus still be balanced across a stereo pair of lanes.
                const float mid = foldsOwnStereo ? mix_math::monoSum(inL, inR) : inL;
                const float foldedL = inL + smoother.monoMix * (mid - inL);
                const float foldedR = inR + smoother.monoMix * (mid - inR);

                const float wetL = foldedL * smoother.gainL;
                const float wetR = foldedR * smoother.gainR;
                outL[i] = wetL;
                outR[i] = wetR;

                peakL = std::max(peakL, std::abs(wetL));
                peakR = std::max(peakR, std::abs(wetR));
            }

            // Land each glide that a whole block could no longer move -- see
            // the identical note on the edge smoother above. This is what
            // lets `settled` become true again after a fader move; without it
            // the exponential stalls ~1.4e-5 short of its target and the
            // strip runs the slow path for the rest of the session.
            if (smoother.gainL == atBlockStart.gainL)
                smoother.gainL = targetL;
            if (smoother.gainR == atBlockStart.gainR)
                smoother.gainR = targetR;
            if (smoother.monoMix == atBlockStart.monoMix)
                smoother.monoMix = targetMono;
        }

        stripLevels[s].peakL = peakL;
        stripLevels[s].peakR = peakR;
    }
}

void MixRenderer::writeToOutputs(const MixGraph& graph, float* const* outputChannelData,
                                 int numOutputChannels, int numSamples) const {
    if (!canRender(graph) || outputChannelData == nullptr)
        return;
    const int span = std::min(numSamples, maxBlock);

    for (uint32_t s = graph.firstLaneStrip; s < graph.strips.size(); ++s) {
        const MixStrip& lane = graph.strips[s];
        if (lane.kind != StripKind::OutputLane)
            continue;
        const int channel = lane.physicalChannel;
        if (channel < 0 || channel >= numOutputChannels)
            continue; // shadow lane, or a channel this device does not have
        float* dest = outputChannelData[channel];
        if (dest == nullptr)
            continue;
        const float* src = postRow(s, 0);
        for (int i = 0; i < span; ++i)
            dest[i] += src[i];
    }
}

} // namespace resostage
