#include "StreamingTrackBuffer.h"

#include <algorithm>
#include <cmath>

namespace resoset {

bool StreamingTrackBuffer::open(const ProjectLoader& loader, const std::string& archivePath, int64_t ringCapacityFrames,
                                 double deviceSampleRate, std::string& error) {
    openLoader = &loader;
    openArchivePath = archivePath;
    openRingCapacityFrames = ringCapacityFrames;
    openDeviceSampleRate = deviceSampleRate;

    cursor = loader.openStream(archivePath, error);
    if (!cursor.isValid())
        return false;

    auto readFn = [this](void* buf, size_t bufSize) { return cursor.read(buf, bufSize); };
    if (!decoder.parseHeader(readFn, error))
        return false;

    ring.prepare(decoder.numChannels(), ringCapacityFrames);
    readPosition.store(0, std::memory_order_relaxed);
    pendingSkipFrames.store(0, std::memory_order_relaxed);
    sourceExhausted.store(false, std::memory_order_relaxed);
    refillScratch.clear();

    resampleRatio = (deviceSampleRate > 0.0 && decoder.sampleRate() > 0.0)
                        ? decoder.sampleRate() / deviceSampleRate
                        : 1.0;
    nativeChunk.clear();
    nativeChunkFrames = 0;
    nativeChunkReadIdx = 0;
    lastNativeSample.assign(static_cast<size_t>(decoder.numChannels()), 0.0f);
    haveLastNativeSample = false;
    nativePhase = 0.0;

    return true;
}

bool StreamingTrackBuffer::hardSeekTo(int64_t deviceFrame, std::string& error) {
    if (openLoader == nullptr || openArchivePath.empty()) {
        error = "hardSeekTo: buffer was never opened";
        return false;
    }
    if (deviceFrame < 0)
        deviceFrame = 0;

    // Full re-open: decoder/cursor are forward-only, so any position (forward
    // OR back) is reached by rewinding to the data chunk start then skipping.
    if (!open(*openLoader, openArchivePath, openRingCapacityFrames, openDeviceSampleRate, error))
        return false;

    if (deviceFrame > 0) {
        pendingSkipFrames.store(deviceFrame, std::memory_order_release);
        // Drain the skip on this thread (caller holds projectLoaderMutex so
        // the I/O thread cannot race us). Container-format skip is an fseek;
        // even multi-minute seeks are typically milliseconds.
        int guard = 0;
        while (pendingSkipFrames.load(std::memory_order_acquire) > 0
               && !sourceExhausted.load(std::memory_order_acquire)
               && guard++ < 1000000) {
            refill();
        }
        if (pendingSkipFrames.load(std::memory_order_acquire) > 0
            && !sourceExhausted.load(std::memory_order_acquire)) {
            error = "hardSeekTo: skip did not complete for " + openArchivePath;
            return false;
        }
    }

    // Source cursor is now at deviceFrame (or EOF). Advertise that position
    // so the audio thread will not queue a second skip on the first read.
    readPosition.store(deviceFrame, std::memory_order_release);
    pendingSkipFrames.store(0, std::memory_order_release);

    // Prime the ring so the first post-seek callback has real audio instead
    // of a silence gap (during which the sample-locked click would still
    // tick -- the audible "metronome ran away" symptom).
    for (int i = 0; i < 8 && !sourceExhausted.load(std::memory_order_acquire); ++i) {
        if (ring.framesFree() <= 0)
            break;
        refill();
    }
    return true;
}

bool StreamingTrackBuffer::refill() {
    const int bpf = decoder.bytesPerFrame();

    int64_t skip = pendingSkipFrames.load(std::memory_order_acquire);
    if (skip > 0 && bpf > 0) {
        // `skip` is in the OUTPUT (device) domain; convert to native frames
        // before skipping bytes in the source. When resampleRatio == 1.0
        // (no resampling needed) this is a no-op multiply/divide, so the
        // common case behaves exactly as before.
        const int64_t nativeFramesWanted =
            static_cast<int64_t>(static_cast<double>(skip) * resampleRatio + 0.5);
        const size_t bytesToSkip = static_cast<size_t>(std::max<int64_t>(nativeFramesWanted, 1)) * static_cast<size_t>(bpf);
        const size_t skippedBytes = cursor.skip(bytesToSkip);
        const int64_t nativeFramesSkipped = static_cast<int64_t>(skippedBytes) / bpf;

        if (nativeFramesSkipped > 0) {
            const int64_t deviceFramesSkipped = std::max<int64_t>(
                1, static_cast<int64_t>(static_cast<double>(nativeFramesSkipped) / resampleRatio + 0.5));
            pendingSkipFrames.fetch_sub(std::min(skip, deviceFramesSkipped), std::memory_order_acq_rel);
            // The cursor just jumped -- any buffered-but-unconsumed native
            // frames and interpolation phase are for the wrong position now.
            nativeChunkFrames = 0;
            nativeChunkReadIdx = 0;
            haveLastNativeSample = false;
            nativePhase = 0.0;
        } else {
            // Source exhausted while trying to skip past it.
            sourceExhausted.store(true, std::memory_order_release);
            pendingSkipFrames.store(0, std::memory_order_release);
        }

        // Stop here only if there's still skip left to service (partial
        // progress) -- otherwise fall through to attempt a decode in this
        // SAME call. Returning unconditionally right after any skip service
        // (even a fully-drained one) used to starve playback indefinitely:
        // read()'s gap-detection queues fresh catch-up demand on every
        // single audio callback whenever the ring is behind -- including
        // during ordinary cold-start fill-up, not just genuine stalls --
        // and since this function only ever did ONE of {skip, decode} per
        // call, a background thread whose ~10ms tick can't strictly outpace
        // the ~10.6ms audio callback rate (very plausible with several real
        // tracks each adding per-tick overhead) would perpetually find fresh
        // skip demand waiting and never reach the decode branch at all.
        if (pendingSkipFrames.load(std::memory_order_relaxed) > 0
            || sourceExhausted.load(std::memory_order_relaxed))
            return true;
    }

    if (sourceExhausted.load(std::memory_order_acquire))
        return ring.framesAvailable() > 0;

    const int64_t free = ring.framesFree();
    if (free <= 0)
        return true;

    const int64_t toDecode = std::min(free, kRefillChunkFrames);
    const size_t channels = static_cast<size_t>(decoder.numChannels());
    auto readFn = [this](void* buf, size_t bufSize) { return cursor.read(buf, bufSize); };

    if (std::abs(resampleRatio - 1.0) < 1e-6) {
        // Fast path: source already matches the device rate, no resampling.
        if (refillScratch.size() != channels || (channels > 0 && static_cast<int64_t>(refillScratch[0].size()) < toDecode)) {
            refillScratch.assign(channels, std::vector<float>(static_cast<size_t>(toDecode)));
        }

        std::vector<float*> writePtrs(channels);
        for (size_t i = 0; i < channels; ++i)
            writePtrs[i] = refillScratch[i].data();

        const int64_t got = decoder.decodeFrames(readFn, writePtrs.data(), toDecode);

        if (got == 0) {
            sourceExhausted.store(true, std::memory_order_release);
            return ring.framesAvailable() > 0;
        }

        std::vector<const float*> readPtrs(writePtrs.begin(), writePtrs.end());
        ring.push(readPtrs.data(), got);
        return true;
    }

    // Resampling path: linear-interpolate native-rate decoded audio into
    // `toDecode` output (device-rate) frames. See the header comment on
    // resampleRatio for the state this carries across calls.
    if (refillScratch.size() != channels || (channels > 0 && static_cast<int64_t>(refillScratch[0].size()) < toDecode)) {
        refillScratch.assign(channels, std::vector<float>(static_cast<size_t>(toDecode)));
    }

    int64_t written = 0;
    bool exhausted = false;
    while (written < toDecode) {
        if (nativeChunkReadIdx >= nativeChunkFrames) {
            // Need a fresh chunk of native-rate audio.
            if (nativeChunk.size() != channels)
                nativeChunk.assign(channels, std::vector<float>(static_cast<size_t>(kRefillChunkFrames)));
            std::vector<float*> writePtrs(channels);
            for (size_t i = 0; i < channels; ++i)
                writePtrs[i] = nativeChunk[i].data();
            nativeChunkFrames = decoder.decodeFrames(readFn, writePtrs.data(), kRefillChunkFrames);
            nativeChunkReadIdx = 0;
            if (nativeChunkFrames <= 0) {
                exhausted = true;
                break;
            }
        }

        // Consume whole native frames until nativePhase is back in [0, 1) --
        // each consumed frame becomes the new interpolation anchor.
        while (nativePhase >= 1.0 && nativeChunkReadIdx < nativeChunkFrames) {
            for (size_t ch = 0; ch < channels; ++ch)
                lastNativeSample[ch] = nativeChunk[ch][static_cast<size_t>(nativeChunkReadIdx)];
            haveLastNativeSample = true;
            ++nativeChunkReadIdx;
            nativePhase -= 1.0;
        }
        if (nativeChunkReadIdx >= nativeChunkFrames)
            continue; // chunk drained (possibly mid-consumption) -- refill and keep going

        // Interpolate between lastNativeSample (or, for the very first
        // sample of the track, nativeChunk[readIdx] itself -- phase is 0.0
        // there anyway) and the next unconsumed native frame.
        for (size_t ch = 0; ch < channels; ++ch) {
            const float a = haveLastNativeSample ? lastNativeSample[ch]
                                                  : nativeChunk[ch][static_cast<size_t>(nativeChunkReadIdx)];
            const float b = nativeChunk[ch][static_cast<size_t>(nativeChunkReadIdx)];
            refillScratch[ch][static_cast<size_t>(written)] = static_cast<float>(a + (b - a) * nativePhase);
        }
        ++written;
        nativePhase += resampleRatio;
    }

    if (written > 0) {
        std::vector<const float*> readPtrs(channels);
        for (size_t i = 0; i < channels; ++i)
            readPtrs[i] = refillScratch[i].data();
        ring.push(readPtrs.data(), written);
    }

    if (exhausted && written == 0) {
        sourceExhausted.store(true, std::memory_order_release);
        return ring.framesAvailable() > 0;
    }
    return true;
}

int64_t StreamingTrackBuffer::read(float* const* outChannels, int64_t numFrames, int64_t expectedPosition) {
    const int64_t currentPos = readPosition.load(std::memory_order_relaxed);

    if (expectedPosition > currentPos) {
        const int64_t gap = expectedPosition - currentPos;
        const int64_t discarded = ring.discard(gap);
        const int64_t stillNeeded = gap - discarded;
        if (stillNeeded > 0)
            pendingSkipFrames.fetch_add(stillNeeded, std::memory_order_acq_rel);
        readPosition.store(expectedPosition, std::memory_order_relaxed);
    }

    const int64_t got = ring.pop(outChannels, numFrames);
    readPosition.fetch_add(got, std::memory_order_relaxed);
    return got;
}

} // namespace resoset
