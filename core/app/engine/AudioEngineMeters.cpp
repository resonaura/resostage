// Meter snapshot reads and interval-peak aggregation for AudioEngine.
// The audio callback publishes samples; these message-thread readers consume
// the shared meter state without changing callback ownership or timing.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"

#include <algorithm>

namespace resostage {

using audio_engine_detail::drainMeterEnvelope;
using audio_engine_detail::linearPeakToDb;

const SeqLock<MeterFrame>* AudioEngine::busMeterAt(size_t index) const {
    if (index >= busMeters.size())
        return nullptr;
    return busMeters[index].get();
}

const SeqLock<MeterFrame>* AudioEngine::trackMeterAt(size_t index) const {
    if (index >= trackMeters.size())
        return nullptr;
    return trackMeters[index].get();
}

MeterFrame AudioEngine::consumeClickMeterInterval() {
    // Take the max peak rendered since the previous UI poll, then clear.
    const float peakL = clickPeakIntervalMaxL.exchange(0.0f, std::memory_order_relaxed);
    const float peakR = clickPeakIntervalMaxR.exchange(0.0f, std::memory_order_relaxed);

    // Echo last interval once: publish N carries real peak, publish N+1 still
    // carries it if this interval was silent. WS client that only samples the
    // later frame still sees the tick. Next silent interval clears delivery.
    // Whichever is louder: the impulse latch (catches a click that came and
    // went between polls) or the last block the audio thread actually
    // rendered.
    //
    // The latch ALONE is empty on any poll that lands between callbacks, and
    // at a big buffer that is most of them -- reporting zero there is not a
    // quiet moment, it is a measurement that never happened, and the needle
    // answered by slamming to the floor twelve times a second. Falling back
    // to the last rendered block is not a simulated decay: it is the most
    // recent measurement there is. Real silence still reads as silence the
    // moment a block of silence is rendered.
    const float lastL = clickLastBlockPeakL.load(std::memory_order_relaxed);
    const float lastR = clickLastBlockPeakR.load(std::memory_order_relaxed);
    const float outL = std::max(peakL, lastL);
    const float outR = std::max(peakR, lastR);

    MeterFrame frame;
    // What a bar is driven by: the loudest sample since the last poll,
    // measured every 64 samples, so it reads the same at 512 frames and at
    // 4096.
    const MeterEnvelopePoint& click =
        drainMeterEnvelope(clickEnvelopeRing, clickLastPeak);
    frame.intervalPeakDbL = linearPeakToDb(click.peakL);
    frame.intervalPeakDbR = linearPeakToDb(click.peakR);
    frame.peakDbL = linearPeakToDb(outL);
    frame.peakDbR = linearPeakToDb(outR);
    frame.peakDb = linearPeakToDb(std::max(outL, outR));
    frame.truePeakDb = frame.peakDb;
    return frame;
}

MeterFrame AudioEngine::consumeTrackMeterInterval(size_t trackIndex) {
    MeterFrame frame;
    if (trackIndex < trackMeters.size() && trackMeters[trackIndex] != nullptr)
        (void)trackMeters[trackIndex]->read(frame);

    float peakL = 0.0f;
    float peakR = 0.0f;
    if (trackIndex < trackPeakIntervalCount && trackPeakIntervalMaxL && trackPeakIntervalMaxR) {
        peakL = trackPeakIntervalMaxL[trackIndex].exchange(0.0f, std::memory_order_relaxed);
        peakR = trackPeakIntervalMaxR[trackIndex].exchange(0.0f, std::memory_order_relaxed);
    }

    // Same logic as consumeBusMeterInterval: use the interval latch (catches
    // a short impulse that came and went between polls) OR the last rendered
    // block (so a poll landing between audio callbacks still has a real
    // measurement, not a zero it has no evidence for).
    float outL = peakL;
    float outR = peakR;
    if (trackIndex < trackPeakIntervalCount && trackLastBlockPeakL && trackLastBlockPeakR) {
        outL = std::max(peakL, trackLastBlockPeakL[trackIndex].load(std::memory_order_relaxed));
        outR = std::max(peakR, trackLastBlockPeakR[trackIndex].load(std::memory_order_relaxed));
    }

    frame.peakDbL = linearPeakToDb(outL);
    frame.peakDbR = linearPeakToDb(outR);
    frame.peakDb  = linearPeakToDb(std::max(outL, outR));
    if (frame.truePeakDb < frame.peakDb)
        frame.truePeakDb = frame.peakDb;
    return frame;
}

MeterFrame AudioEngine::consumeBusMeterInterval(size_t busIndex) {
    MeterFrame frame;
    if (busIndex < busMeters.size() && busMeters[busIndex] != nullptr)
        (void)busMeters[busIndex]->read(frame);

    float peakL = 0.0f;
    float peakR = 0.0f;
    if (busIndex < busPeakIntervalCount && busPeakIntervalMaxL && busPeakIntervalMaxR) {
        peakL = busPeakIntervalMaxL[busIndex].exchange(0.0f, std::memory_order_relaxed);
        peakR = busPeakIntervalMaxR[busIndex].exchange(0.0f, std::memory_order_relaxed);
    }

    // See consumeClickMeterInterval: impulse latch OR the last rendered
    // block, whichever is louder. Stateless on this side, so it does not
    // matter which publish path calls it or how often.
    float outL = peakL;
    float outR = peakR;
    if (busIndex < busPeakIntervalCount && busLastBlockPeakL && busLastBlockPeakR) {
        outL = std::max(peakL, busLastBlockPeakL[busIndex].load(std::memory_order_relaxed));
        outR = std::max(peakR, busLastBlockPeakR[busIndex].load(std::memory_order_relaxed));
    }

    // What a bar is driven by, measured inside the audio thread every 64
    // samples. Draining the ring here is also what keeps it from wrapping.
    if (busIndex < busEnvelopeRings.size() && busEnvelopeRings[busIndex] != nullptr
        && busIndex < busLastPeak.size()) {
        const MeterEnvelopePoint& point = drainMeterEnvelope(
            *busEnvelopeRings[busIndex], busLastPeak[busIndex]);
        frame.intervalPeakDbL = linearPeakToDb(point.peakL);
        frame.intervalPeakDbR = linearPeakToDb(point.peakR);
    }
    // Interval peaks win for display needles; keep LUFS/truePeak from the
    // latest LoudnessMeter frame for sustained program material.
    frame.peakDbL = linearPeakToDb(outL);
    frame.peakDbR = linearPeakToDb(outR);
    frame.peakDb = linearPeakToDb(std::max(outL, outR));
    if (frame.truePeakDb < frame.peakDb)
        frame.truePeakDb = frame.peakDb;
    return frame;
}

} // namespace resostage
