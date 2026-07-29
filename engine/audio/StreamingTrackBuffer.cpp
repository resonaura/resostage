#include "StreamingTrackBuffer.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

namespace resoset {

namespace {

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

bool StreamingTrackBuffer::open(const ProjectLoader& loader, const std::string& archivePath,
                                int64_t ringCapacityFrames, double deviceSampleRate, std::string& error) {
    releaseResident();
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

    preferredStart = 0;
    preferredLength = totalFrames();

    const size_t ch = static_cast<size_t>(std::max(0, decoder.numChannels()));
    refillWritePtrs.resize(ch, nullptr);
    refillReadPtrs.resize(ch, nullptr);

    return true;
}

void StreamingTrackBuffer::setPreferredResidentWindow(int64_t deviceStart, int64_t deviceLength) {
    preferredStart = std::max<int64_t>(0, deviceStart);
    preferredLength = std::max<int64_t>(0, deviceLength);
    if (preferredLength <= 0)
        preferredLength = std::max<int64_t>(0, totalFrames() - preferredStart);
}

size_t StreamingTrackBuffer::estimatedResidentBytes() const {
    const int ch = std::max(0, decoder.numChannels());
    int64_t len = preferredLength;
    if (len <= 0)
        len = std::max<int64_t>(0, totalFrames() - preferredStart);
    if (ch <= 0 || len <= 0)
        return 0;
    return static_cast<size_t>(ch) * static_cast<size_t>(len) * sizeof(float);
}

void StreamingTrackBuffer::closeDiskCursor() {
    cursor = ProjectLoader::StreamCursor{};
}

void StreamingTrackBuffer::releaseResident() {
    residentActive = false;
    residentStart = 0;
    residentLength = 0;
    residentByteCount = 0;
    residentData.clear();
}

bool StreamingTrackBuffer::decodeIntoResident(int64_t deviceStart, int64_t deviceFrames, std::string& error) {
    if (deviceFrames <= 0) {
        error = "empty resident window";
        return false;
    }
    if (openLoader == nullptr || openArchivePath.empty()) {
        error = "no loader";
        return false;
    }

    // Preserve preferred window across re-open (open() resets it to full file).
    const int64_t keepStart = preferredStart;
    const int64_t keepLen = preferredLength;
    std::string openErr;
    if (!open(*openLoader, openArchivePath, openRingCapacityFrames, openDeviceSampleRate, openErr)) {
        error = openErr;
        return false;
    }
    preferredStart = keepStart;
    preferredLength = keepLen;

    const int channels = decoder.numChannels();
    if (channels <= 0) {
        error = "no channels";
        return false;
    }

    if (deviceStart > 0) {
        pendingSkipFrames.store(deviceStart, std::memory_order_release);
        int guard = 0;
        while (pendingSkipFrames.load(std::memory_order_acquire) > 0
               && !sourceExhausted.load(std::memory_order_acquire)
               && guard++ < 1000000) {
            refill();
            ring.reset(); // discard any accidental decode after skip drained
        }
        if (pendingSkipFrames.load(std::memory_order_acquire) > 0) {
            error = "failed to skip to resident window start";
            return false;
        }
    }

    residentData.assign(static_cast<size_t>(channels),
                        std::vector<float>(static_cast<size_t>(deviceFrames), 0.0f));

    int64_t got = 0;
    auto readFn = [this](void* buf, size_t bufSize) { return cursor.read(buf, bufSize); };

    while (got < deviceFrames) {
        const int64_t chunk = std::min(deviceFrames - got, kRefillChunkFrames);
        std::vector<float*> chunkPtrs(static_cast<size_t>(channels));
        for (int c = 0; c < channels; ++c)
            chunkPtrs[static_cast<size_t>(c)] =
                residentData[static_cast<size_t>(c)].data() + got;

        int64_t decoded = 0;
        if (std::abs(resampleRatio - 1.0) < 1e-6) {
            if (refillScratch.size() != static_cast<size_t>(channels)
                || static_cast<int64_t>(refillScratch[0].size()) < chunk) {
                refillScratch.assign(static_cast<size_t>(channels),
                                     std::vector<float>(static_cast<size_t>(chunk)));
            }
            if (refillWritePtrs.size() != static_cast<size_t>(channels))
                refillWritePtrs.assign(static_cast<size_t>(channels), nullptr);
            for (size_t i = 0; i < static_cast<size_t>(channels); ++i)
                refillWritePtrs[i] = refillScratch[i].data();
            decoded = decoder.decodeFrames(readFn, refillWritePtrs.data(), chunk);
            if (decoded <= 0)
                break;
            for (int c = 0; c < channels; ++c)
                std::memcpy(chunkPtrs[static_cast<size_t>(c)],
                            refillScratch[static_cast<size_t>(c)].data(),
                            static_cast<size_t>(decoded) * sizeof(float));
        } else {
            ring.reset();
            int spins = 0;
            while (ring.framesAvailable() < chunk
                   && !sourceExhausted.load(std::memory_order_acquire)
                   && spins++ < 10000) {
                if (!refill())
                    break;
            }
            decoded = ring.pop(chunkPtrs.data(), chunk);
            if (decoded <= 0)
                break;
        }
        got += decoded;
        if (decoded < chunk)
            break;
    }

    if (got <= 0) {
        error = "no audio decoded for resident window";
        residentData.clear();
        return false;
    }

    if (got < deviceFrames) {
        for (auto& chv : residentData)
            chv.resize(static_cast<size_t>(got));
    }

    residentStart = deviceStart;
    residentLength = got;
    residentByteCount = static_cast<size_t>(channels) * static_cast<size_t>(got) * sizeof(float);
    residentActive = true;
    sourceExhausted.store(true, std::memory_order_release);
    pendingSkipFrames.store(0, std::memory_order_release);
    ring.reset();
    closeDiskCursor();
    return true;
}

bool StreamingTrackBuffer::tryLoadResident(size_t maxBytes, size_t& outBytes, std::string& error) {
    outBytes = 0;
    if (residentActive) {
        outBytes = residentByteCount;
        return true;
    }
    int64_t start = preferredStart;
    int64_t len = preferredLength;
    if (len <= 0)
        len = std::max<int64_t>(0, totalFrames() - start);
    if (len <= 0) {
        // Empty clip — mark resident silence, no disk.
        residentActive = true;
        residentStart = start;
        residentLength = 0;
        residentByteCount = 0;
        sourceExhausted.store(true, std::memory_order_release);
        closeDiskCursor();
        return true;
    }
    const size_t need = estimatedResidentBytes();
    if (need == 0) {
        const int ch = std::max(1, decoder.numChannels());
        if (static_cast<size_t>(ch) * static_cast<size_t>(len) * sizeof(float) > maxBytes) {
            error = "resident window exceeds budget";
            return false;
        }
    } else if (need > maxBytes) {
        error = "resident window exceeds budget";
        return false;
    }

    if (!decodeIntoResident(start, len, error))
        return false;
    outBytes = residentByteCount;
    return true;
}

bool StreamingTrackBuffer::hardSeekTo(int64_t deviceFrame, std::string& error) {
    if (deviceFrame < 0)
        deviceFrame = 0;

    if (residentActive) {
        // Random-access RAM — no disk, no re-open.
        readPosition.store(deviceFrame, std::memory_order_release);
        pendingSkipFrames.store(0, std::memory_order_release);
        return true;
    }

    if (openLoader == nullptr || openArchivePath.empty()) {
        error = "hardSeekTo: buffer was never opened";
        return false;
    }

    if (!open(*openLoader, openArchivePath, openRingCapacityFrames, openDeviceSampleRate, error))
        return false;

    if (deviceFrame > 0) {
        pendingSkipFrames.store(deviceFrame, std::memory_order_release);
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

    readPosition.store(deviceFrame, std::memory_order_release);
    pendingSkipFrames.store(0, std::memory_order_release);

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
    if (residentActive)
        return false;

    const int bpf = decoder.bytesPerFrame();

    if (sourceExhausted.load(std::memory_order_acquire)) {
        pendingSkipFrames.store(0, std::memory_order_release);
        return ring.framesAvailable() > 0;
    }

    int64_t skip = pendingSkipFrames.load(std::memory_order_acquire);
    if (skip > 0 && bpf > 0) {
        skip = std::min(skip, kMaxSkipDeviceFrames);
        const double nativeWantedD =
            static_cast<double>(skip) * std::max(resampleRatio, 1e-12);
        constexpr double kMaxNativeFrames = static_cast<double>(1LL << 28);
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
            nativeChunkFrames = 0;
            nativeChunkReadIdx = 0;
            haveLastNativeSample = false;
            nativePhase = 0.0;
        } else {
            sourceExhausted.store(true, std::memory_order_release);
            pendingSkipFrames.store(0, std::memory_order_release);
        }

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

    if (refillScratch.size() != channels
        || (channels > 0 && static_cast<int64_t>(refillScratch[0].size()) < toDecode)) {
        refillScratch.assign(channels, std::vector<float>(static_cast<size_t>(toDecode)));
    }

    int64_t written = 0;
    bool exhausted = false;
    while (written < toDecode) {
        if (nativeChunkReadIdx >= nativeChunkFrames) {
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
        while (nativePhase >= 1.0 && nativeChunkReadIdx < nativeChunkFrames) {
            for (size_t ch = 0; ch < channels; ++ch)
                lastNativeSample[ch] = nativeChunk[ch][static_cast<size_t>(nativeChunkReadIdx)];
            haveLastNativeSample = true;
            ++nativeChunkReadIdx;
            nativePhase -= 1.0;
        }
        if (nativeChunkReadIdx >= nativeChunkFrames)
            continue;
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

    if (residentActive) {
        // Random-access RAM path — never underruns, never queues disk skip.
        if (expectedPosition < 0)
            expectedPosition = 0;
        readPosition.store(expectedPosition, std::memory_order_relaxed);

        for (int64_t i = 0; i < numFrames; ++i) {
            const int64_t absPos = expectedPosition + i;
            const int64_t rel = absPos - residentStart;
            if (rel >= 0 && rel < residentLength) {
                for (int ch = 0; ch < channels; ++ch) {
                    if (outChannels[ch] != nullptr)
                        outChannels[ch][i] =
                            residentData[static_cast<size_t>(ch)][static_cast<size_t>(rel)];
                }
            } else {
                for (int ch = 0; ch < channels; ++ch) {
                    if (outChannels[ch] != nullptr)
                        outChannels[ch][i] = 0.0f;
                }
            }
        }
        readPosition.store(expectedPosition + numFrames, std::memory_order_relaxed);
        return numFrames;
    }

    const int64_t currentPos = readPosition.load(std::memory_order_relaxed);
    const bool dead = sourceExhausted.load(std::memory_order_acquire)
                      && ring.framesAvailable() <= 0;

    if (dead) {
        zeroPlanar(outChannels, channels, numFrames);
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
            const int64_t add = std::min(stillNeeded, kMaxSkipDeviceFrames);
            pendingSkipFrames.fetch_add(add, std::memory_order_acq_rel);
        }
        readPosition.store(expectedPosition, std::memory_order_relaxed);
    }

    const int64_t got = ring.pop(outChannels, numFrames);
    readPosition.fetch_add(got, std::memory_order_relaxed);

    if (got < numFrames && sourceExhausted.load(std::memory_order_acquire)
        && ring.framesAvailable() <= 0) {
        readPosition.fetch_add(numFrames - got, std::memory_order_relaxed);
    }
    return got;
}

} // namespace resoset
