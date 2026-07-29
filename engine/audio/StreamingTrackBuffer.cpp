#include "StreamingTrackBuffer.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

namespace resoset {

namespace {

// Cap catch-up skip size so a runaway playhead-vs-EOF gap (audio thread
// keeps advancing after a stem is exhausted) can never overflow size_t
// when converted to a byte count, or ask the zip cursor to skip terabytes
// of archive data in one go. ~60s of 48kHz is plenty for real underruns.
constexpr int64_t kMaxSkipDeviceFrames = 48000 * 60;

void zeroPlanar(float* const* outChannels, int channels, int64_t numFrames) {
    if (outChannels == nullptr || numFrames <= 0)
        return;
    for (int ch = 0; ch < channels; ++ch) {
        if (outChannels[ch] != nullptr)
            std::fill(outChannels[ch], outChannels[ch] + numFrames, 0.0f);
    }
}

} // namespace

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
    refillWritePtrs.clear();
    refillReadPtrs.clear();

    resampleRatio = (deviceSampleRate > 0.0 && decoder.sampleRate() > 0.0)
                        ? decoder.sampleRate() / deviceSampleRate
                        : 1.0;
    nativeChunk.clear();
    nativeChunkFrames = 0;
    nativeChunkReadIdx = 0;
    lastNativeSample.assign(static_cast<size_t>(decoder.numChannels()), 0.0f);
    haveLastNativeSample = false;
    nativePhase = 0.0;

    // Pre-size pointer scratch so refill() never heap-allocates mid-stream
    // (malloc under memory pressure is a classic "SSD fine, audio dies" path).
    const size_t ch = static_cast<size_t>(std::max(0, decoder.numChannels()));
    refillWritePtrs.resize(ch, nullptr);
    refillReadPtrs.resize(ch, nullptr);

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

    // Light prime only (~1.5s). Filling 75% of an 8s ring here used to block
    // seek for seconds on a busy SSD; StreamingEngine::seekActiveSongTo /
    // the IO thread finish the rest after return.
    const double sr = openDeviceSampleRate > 0.0 ? openDeviceSampleRate : 48000.0;
    const int64_t primeTarget = static_cast<int64_t>(sr * 1.5);
    for (int i = 0; i < 32 && wantsRefill(); ++i) {
        if (ring.framesAvailable() >= primeTarget)
            break;
        refill();
    }
    return true;
}

bool StreamingTrackBuffer::refill() {
    const int bpf = decoder.bytesPerFrame();

    // Once the source is known dead, never service skip demand or try to
    // decode again -- pendingSkipFrames can pile up to billions of samples
    // if the song playhead keeps running past this stem's EOF (other tracks
    // still playing). Converting that to a byte count used to overflow /
    // pull random archive bytes and push denormal/garbage floats that
    // metered as +400..+700 dBFS across every bus.
    if (sourceExhausted.load(std::memory_order_acquire)) {
        pendingSkipFrames.store(0, std::memory_order_release);
        return ring.framesAvailable() > 0;
    }

    int64_t skip = pendingSkipFrames.load(std::memory_order_acquire);
    if (skip > 0 && bpf > 0) {
        // Bound the skip so a pathological gap cannot overflow size_t or
        // hang the IO thread on a multi-terabyte zip seek.
        skip = std::min(skip, kMaxSkipDeviceFrames);

        // `skip` is in the OUTPUT (device) domain; convert to native frames
        // before skipping bytes in the source. When resampleRatio == 1.0
        // (no resampling needed) this is a no-op multiply/divide, so the
        // common case behaves exactly as before.
        const double nativeWantedD =
            static_cast<double>(skip) * std::max(resampleRatio, 1e-12);
        // Clamp before casting: on 32-bit size_t hosts a multi-minute skip
        // at high channel/bit-depth could otherwise wrap the byte count.
        constexpr double kMaxNativeFrames = static_cast<double>(1LL << 28); // ~256M frames
        const int64_t nativeFramesWanted = static_cast<int64_t>(
            std::min(std::max(nativeWantedD, 1.0), kMaxNativeFrames) + 0.5);
        const uint64_t bytesToSkipU =
            static_cast<uint64_t>(nativeFramesWanted) * static_cast<uint64_t>(bpf);
        const size_t bytesToSkip = static_cast<size_t>(
            std::min(bytesToSkipU, static_cast<uint64_t>(std::numeric_limits<size_t>::max() / 4)));
        const size_t skippedBytes = cursor.skip(bytesToSkip);
        const int64_t nativeFramesSkipped =
            bpf > 0 ? static_cast<int64_t>(skippedBytes) / bpf : 0;

        if (nativeFramesSkipped > 0) {
            const int64_t deviceFramesSkipped = std::max<int64_t>(
                1, static_cast<int64_t>(static_cast<double>(nativeFramesSkipped)
                                        / std::max(resampleRatio, 1e-12) + 0.5));
            const int64_t pending = pendingSkipFrames.load(std::memory_order_relaxed);
            pendingSkipFrames.store(std::max<int64_t>(0, pending - deviceFramesSkipped),
                                    std::memory_order_release);
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

    if (refillWritePtrs.size() != channels)
        refillWritePtrs.assign(channels, nullptr);
    if (refillReadPtrs.size() != channels)
        refillReadPtrs.assign(channels, nullptr);

    if (std::abs(resampleRatio - 1.0) < 1e-6) {
        // Fast path: source already matches the device rate, no resampling.
        if (refillScratch.size() != channels
            || (channels > 0 && static_cast<int64_t>(refillScratch[0].size()) < toDecode)) {
            refillScratch.assign(channels, std::vector<float>(static_cast<size_t>(toDecode)));
        }

        for (size_t i = 0; i < channels; ++i)
            refillWritePtrs[i] = refillScratch[i].data();

        const int64_t got = decoder.decodeFrames(readFn, refillWritePtrs.data(), toDecode);

        if (got == 0) {
            sourceExhausted.store(true, std::memory_order_release);
            return ring.framesAvailable() > 0;
        }

        for (size_t i = 0; i < channels; ++i)
            refillReadPtrs[i] = refillScratch[i].data();
        ring.push(refillReadPtrs.data(), got);
        return true;
    }

    // Resampling path: linear-interpolate native-rate decoded audio into
    // `toDecode` output (device-rate) frames. See the header comment on
    // resampleRatio for the state this carries across calls.
    if (refillScratch.size() != channels
        || (channels > 0 && static_cast<int64_t>(refillScratch[0].size()) < toDecode)) {
        refillScratch.assign(channels, std::vector<float>(static_cast<size_t>(toDecode)));
    }

    int64_t written = 0;
    bool exhausted = false;
    while (written < toDecode) {
        if (nativeChunkReadIdx >= nativeChunkFrames) {
            // Need a fresh chunk of native-rate audio.
            if (nativeChunk.size() != channels)
                nativeChunk.assign(channels, std::vector<float>(static_cast<size_t>(kRefillChunkFrames)));
            for (size_t i = 0; i < channels; ++i)
                refillWritePtrs[i] = nativeChunk[i].data();
            nativeChunkFrames = decoder.decodeFrames(readFn, refillWritePtrs.data(), kRefillChunkFrames);
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
        for (size_t i = 0; i < channels; ++i)
            refillReadPtrs[i] = refillScratch[i].data();
        ring.push(refillReadPtrs.data(), written);
    }

    if (exhausted) {
        // Mark dead whether or not we pushed a final partial chunk -- the
        // next refill must not keep trying to decode past EOF.
        sourceExhausted.store(true, std::memory_order_release);
        if (written == 0)
            return ring.framesAvailable() > 0;
    }
    return true;
}

int64_t StreamingTrackBuffer::read(float* const* outChannels, int64_t numFrames, int64_t expectedPosition) {
    const int channels = decoder.numChannels();
    if (numFrames <= 0)
        return 0;

    const int64_t currentPos = readPosition.load(std::memory_order_relaxed);
    const bool dead = sourceExhausted.load(std::memory_order_acquire)
                      && ring.framesAvailable() <= 0;

    // Stem already finished and ring is dry: pure silence, position follows
    // the playhead. Do NOT queue skip demand -- after EOF the song playhead
    // (other tracks / click / song length) keeps advancing, and each
    // callback's gap would otherwise grow without bound (see refill()).
    if (dead) {
        zeroPlanar(outChannels, channels, numFrames);
        // expectedPosition is the START of this block; after a full block of
        // silence we sit at expectedPosition + numFrames (or current+num if
        // the playhead somehow rewound).
        const int64_t endPos =
            (expectedPosition > currentPos ? expectedPosition : currentPos) + numFrames;
        readPosition.store(endPos, std::memory_order_relaxed);
        return 0;
    }

    if (expectedPosition > currentPos) {
        const int64_t gap = expectedPosition - currentPos;
        const int64_t discarded = ring.discard(gap);
        const int64_t stillNeeded = gap - discarded;
        if (stillNeeded > 0) {
            // Cap so a single stall cannot enqueue an unbounded skip.
            const int64_t add = std::min(stillNeeded, kMaxSkipDeviceFrames);
            pendingSkipFrames.fetch_add(add, std::memory_order_acq_rel);
        }
        readPosition.store(expectedPosition, std::memory_order_relaxed);
    }

    const int64_t got = ring.pop(outChannels, numFrames);
    readPosition.fetch_add(got, std::memory_order_relaxed);

    // Past EOF with a partial final pop: absorb the silent remainder into
    // our position so the next callback does not re-queue a catch-up skip
    // for frames we already treated as silence. Mid-stream underruns still
    // leave position lagging (got only) so the next gap correctly queues a
    // real skip of the missing source audio.
    if (got < numFrames && sourceExhausted.load(std::memory_order_acquire)
        && ring.framesAvailable() <= 0) {
        readPosition.fetch_add(numFrames - got, std::memory_order_relaxed);
    }
    return got;
}

} // namespace resoset
