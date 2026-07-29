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

bool StreamingTrackBuffer::openUnlocked(const ProjectLoader& loader, const std::string& archivePath,
                                        int64_t ringCapacityFrames, double deviceSampleRate,
                                        std::string& error) {
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
    // Cache data payload offset for O(1) directory rewinds.
    dataPayloadFileOffset = cursor.tell();

    readPosition.store(0, std::memory_order_relaxed);
    pendingSkipFrames.store(0, std::memory_order_relaxed);
    sourceExhausted.store(false, std::memory_order_relaxed);
    residentLoadInFlight.store(false, std::memory_order_relaxed);
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

    // Reuse ring storage across re-opens when size matches (hopscotch / seek).
    // First open still defers alloc to first refill (IO thread).
    if (ring.capacity() == openRingCapacityFrames && ring.numChannels() == decoder.numChannels()
        && ring.capacity() > 0) {
        ring.prepare(decoder.numChannels(), openRingCapacityFrames);
        ringReady.store(true, std::memory_order_release);
    } else {
        ringReady.store(false, std::memory_order_release);
    }
    return true;
}

bool StreamingTrackBuffer::open(const ProjectLoader& loader, const std::string& archivePath,
                                int64_t ringCapacityFrames, double deviceSampleRate, std::string& error) {
    std::lock_guard<std::mutex> lock(diskIoMutex);
    return openUnlocked(loader, archivePath, ringCapacityFrames, deviceSampleRate, error);
}

void StreamingTrackBuffer::ensureRingReadyUnlocked() {
    if (ringReady.load(std::memory_order_relaxed))
        return;
    ring.prepare(decoder.numChannels(), openRingCapacityFrames);
    ringReady.store(true, std::memory_order_release);
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

void StreamingTrackBuffer::closeDiskCursorUnlocked() {
    cursor = ProjectLoader::StreamCursor{};
}

void StreamingTrackBuffer::releaseResident() {
    residentActive.store(false, std::memory_order_release);
    residentStart = 0;
    residentLength = 0;
    residentByteCount = 0;
    residentData.clear();
}

bool StreamingTrackBuffer::decodeWindowSideChannel(int64_t deviceStart, int64_t deviceFrames,
                                                   std::vector<std::vector<float>>& outPlanar,
                                                   int64_t& outFrames, std::string& error) const {
    outFrames = 0;
    outPlanar.clear();
    if (openLoader == nullptr || openArchivePath.empty() || deviceFrames <= 0) {
        error = "invalid side-channel load";
        return false;
    }

    // Fully independent stream — never touches this->cursor / ring / decoder.
    ProjectLoader::StreamCursor sideCursor = openLoader->openStream(openArchivePath, error);
    if (!sideCursor.isValid())
        return false;

    WavStreamDecoder sideDec;
    auto readFn = [&sideCursor](void* buf, size_t bufSize) { return sideCursor.read(buf, bufSize); };
    if (!sideDec.parseHeader(readFn, error))
        return false;

    const int channels = sideDec.numChannels();
    if (channels <= 0) {
        error = "no channels";
        return false;
    }

    const double ratio = (openDeviceSampleRate > 0.0 && sideDec.sampleRate() > 0.0)
                             ? sideDec.sampleRate() / openDeviceSampleRate
                             : 1.0;
    const int bpf = sideDec.bytesPerFrame();

    // Skip to window start (device domain → native bytes).
    if (deviceStart > 0 && bpf > 0) {
        const double nativeWantedD =
            static_cast<double>(deviceStart) * std::max(ratio, 1e-12);
        const int64_t nativeFrames = static_cast<int64_t>(std::max(nativeWantedD, 0.0) + 0.5);
        const size_t bytesToSkip =
            static_cast<size_t>(std::min<uint64_t>(
                static_cast<uint64_t>(nativeFrames) * static_cast<uint64_t>(bpf),
                static_cast<uint64_t>(std::numeric_limits<size_t>::max() / 4)));
        (void)sideCursor.skip(bytesToSkip);
    }

    outPlanar.assign(static_cast<size_t>(channels),
                     std::vector<float>(static_cast<size_t>(deviceFrames), 0.0f));

    if (std::abs(ratio - 1.0) < 1e-6) {
        // Fast path: decode directly into outPlanar.
        std::vector<float*> ptrs(static_cast<size_t>(channels));
        for (int c = 0; c < channels; ++c)
            ptrs[static_cast<size_t>(c)] = outPlanar[static_cast<size_t>(c)].data();

        int64_t got = 0;
        std::vector<float> scratch;
        while (got < deviceFrames) {
            const int64_t chunk = std::min(deviceFrames - got, kRefillChunkFrames);
            std::vector<float*> chunkPtrs(static_cast<size_t>(channels));
            for (int c = 0; c < channels; ++c)
                chunkPtrs[static_cast<size_t>(c)] =
                    outPlanar[static_cast<size_t>(c)].data() + got;
            const int64_t n = sideDec.decodeFrames(readFn, chunkPtrs.data(), chunk);
            if (n <= 0)
                break;
            got += n;
            if (n < chunk)
                break;
        }
        if (got <= 0) {
            error = "no audio in side-channel load";
            outPlanar.clear();
            return false;
        }
        if (got < deviceFrames) {
            for (auto& ch : outPlanar)
                ch.resize(static_cast<size_t>(got));
        }
        outFrames = got;
        return true;
    }

    // Resample path: decode native chunks and linear-interpolate to device frames.
    std::vector<std::vector<float>> nativeChunk(
        static_cast<size_t>(channels), std::vector<float>(static_cast<size_t>(kRefillChunkFrames)));
    std::vector<float*> nativePtrs(static_cast<size_t>(channels));
    for (int c = 0; c < channels; ++c)
        nativePtrs[static_cast<size_t>(c)] = nativeChunk[static_cast<size_t>(c)].data();

    int64_t nativeChunkFrames = 0;
    int64_t nativeReadIdx = 0;
    std::vector<float> lastSample(static_cast<size_t>(channels), 0.0f);
    bool haveLast = false;
    double phase = 0.0;
    int64_t written = 0;
    bool exhausted = false;

    while (written < deviceFrames) {
        if (nativeReadIdx >= nativeChunkFrames) {
            nativeChunkFrames = sideDec.decodeFrames(readFn, nativePtrs.data(), kRefillChunkFrames);
            nativeReadIdx = 0;
            if (nativeChunkFrames <= 0) {
                exhausted = true;
                break;
            }
        }
        while (phase >= 1.0 && nativeReadIdx < nativeChunkFrames) {
            for (int c = 0; c < channels; ++c)
                lastSample[static_cast<size_t>(c)] =
                    nativeChunk[static_cast<size_t>(c)][static_cast<size_t>(nativeReadIdx)];
            haveLast = true;
            ++nativeReadIdx;
            phase -= 1.0;
        }
        if (nativeReadIdx >= nativeChunkFrames)
            continue;
        for (int c = 0; c < channels; ++c) {
            const float a = haveLast ? lastSample[static_cast<size_t>(c)]
                                     : nativeChunk[static_cast<size_t>(c)][static_cast<size_t>(nativeReadIdx)];
            const float b =
                nativeChunk[static_cast<size_t>(c)][static_cast<size_t>(nativeReadIdx)];
            outPlanar[static_cast<size_t>(c)][static_cast<size_t>(written)] =
                static_cast<float>(a + (b - a) * phase);
        }
        ++written;
        phase += ratio;
    }
    (void)exhausted;
    if (written <= 0) {
        error = "no resampled audio in side-channel load";
        outPlanar.clear();
        return false;
    }
    if (written < deviceFrames) {
        for (auto& ch : outPlanar)
            ch.resize(static_cast<size_t>(written));
    }
    outFrames = written;
    return true;
}

bool StreamingTrackBuffer::tryLoadResident(size_t maxBytes, size_t& outBytes, std::string& error) {
    outBytes = 0;
    if (residentActive.load(std::memory_order_acquire)) {
        outBytes = residentByteCount;
        return true;
    }
    // One load at a time per buffer (resident thread + accidental double call).
    bool expected = false;
    if (!residentLoadInFlight.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
        error = "resident load already in flight";
        return false;
    }

    struct ClearInFlight {
        std::atomic<bool>& f;
        ~ClearInFlight() { f.store(false, std::memory_order_release); }
    } clear{residentLoadInFlight};

    int64_t start = preferredStart;
    int64_t len = preferredLength;
    if (len <= 0)
        len = std::max<int64_t>(0, totalFrames() - start);

    if (len <= 0) {
        std::lock_guard<std::mutex> lock(diskIoMutex);
        if (residentActive.load(std::memory_order_relaxed)) {
            outBytes = residentByteCount;
            return true;
        }
        residentStart = start;
        residentLength = 0;
        residentByteCount = 0;
        residentData.clear();
        closeDiskCursorUnlocked();
        sourceExhausted.store(true, std::memory_order_release);
        pendingSkipFrames.store(0, std::memory_order_release);
        residentActive.store(true, std::memory_order_release);
        return true;
    }

    const size_t need = estimatedResidentBytes();
    if (need > maxBytes && need > 0) {
        error = "resident window exceeds budget";
        return false;
    }

    // Heavy work: side stream only — live ring/cursor keep serving audio.
    std::vector<std::vector<float>> temp;
    int64_t got = 0;
    if (!decodeWindowSideChannel(start, len, temp, got, error))
        return false;

    // Publish without tearing the live ring under the audio thread.
    // We intentionally do NOT ring.reset() — stale ring is ignored once
    // residentActive is true; audio only uses residentData after the store.
    {
        std::lock_guard<std::mutex> lock(diskIoMutex);
        if (residentActive.load(std::memory_order_relaxed)) {
            outBytes = residentByteCount;
            return true;
        }
        residentData = std::move(temp);
        residentStart = start;
        residentLength = got;
        residentByteCount =
            static_cast<size_t>(std::max(0, decoder.numChannels())) * static_cast<size_t>(got)
            * sizeof(float);
        closeDiskCursorUnlocked();
        sourceExhausted.store(true, std::memory_order_release);
        pendingSkipFrames.store(0, std::memory_order_release);
        // Publish last — audio acquires this before reading residentData.
        residentActive.store(true, std::memory_order_release);
        outBytes = residentByteCount;
    }
    return true;
}

bool StreamingTrackBuffer::softRewindToStart(std::string& error) {
    if (residentActive.load(std::memory_order_acquire)) {
        // Resident window stays; just snap the playhead to preferred start.
        readPosition.store(preferredStart, std::memory_order_release);
        pendingSkipFrames.store(0, std::memory_order_release);
        return true;
    }

    // Already sitting at the start with ring headroom — do NOT wipe the ring.
    // That wipe was the "slight lag" after every hop (silence until re-fill).
    if (readPosition.load(std::memory_order_relaxed) == 0
        && pendingSkipFrames.load(std::memory_order_relaxed) == 0
        && !sourceExhausted.load(std::memory_order_acquire)
        && framesAvailable() > 0) {
        return true;
    }

    std::lock_guard<std::mutex> lock(diskIoMutex);
    if (residentActive.load(std::memory_order_relaxed)) {
        readPosition.store(preferredStart, std::memory_order_release);
        pendingSkipFrames.store(0, std::memory_order_release);
        return true;
    }
    if (openLoader == nullptr || openArchivePath.empty()) {
        error = "softRewindToStart: buffer was never opened";
        return false;
    }

    // Re-check under lock after the fast path above.
    if (readPosition.load(std::memory_order_relaxed) == 0
        && pendingSkipFrames.load(std::memory_order_relaxed) == 0
        && !sourceExhausted.load(std::memory_order_relaxed)
        && ringReady.load(std::memory_order_relaxed) && ring.framesAvailable() > 0) {
        return true;
    }

    // Fast path (directory containers): fseek to cached data payload — no
    // fclose/fopen/parseHeader. This is what makes hopscotch feel instant.
    if (dataPayloadFileOffset >= 0 && cursor.isValid() && cursor.seekAbsolute(dataPayloadFileOffset)) {
        decoder.resetDataCursor();
        if (ringReady.load(std::memory_order_relaxed))
            ring.prepare(decoder.numChannels(), openRingCapacityFrames); // index reset / reuse
        else
            ensureRingReadyUnlocked();
        readPosition.store(0, std::memory_order_relaxed);
        pendingSkipFrames.store(0, std::memory_order_relaxed);
        sourceExhausted.store(false, std::memory_order_relaxed);
        nativeChunkFrames = 0;
        nativeChunkReadIdx = 0;
        haveLastNativeSample = false;
        nativePhase = 0.0;
        return true;
    }

    // Slow path (ZIP / first open / seek failed): full re-open.
    const int64_t keepPrefStart = preferredStart;
    const int64_t keepPrefLen = preferredLength;
    if (!openUnlocked(*openLoader, openArchivePath, openRingCapacityFrames, openDeviceSampleRate,
                      error))
        return false;
    preferredStart = keepPrefStart;
    preferredLength = keepPrefLen > 0 ? keepPrefLen : preferredLength;
    return true;
}

bool StreamingTrackBuffer::hardSeekTo(int64_t deviceFrame, std::string& error) {
    if (deviceFrame < 0)
        deviceFrame = 0;

    if (residentActive.load(std::memory_order_acquire)) {
        readPosition.store(deviceFrame, std::memory_order_release);
        pendingSkipFrames.store(0, std::memory_order_release);
        return true;
    }

    // Frame 0: soft rewind path (keeps ring).
    if (deviceFrame == 0)
        return softRewindToStart(error);

    std::lock_guard<std::mutex> lock(diskIoMutex);
    if (residentActive.load(std::memory_order_relaxed)) {
        readPosition.store(deviceFrame, std::memory_order_release);
        return true;
    }

    if (openLoader == nullptr || openArchivePath.empty()) {
        error = "hardSeekTo: buffer was never opened";
        return false;
    }

    const int64_t keepPrefStart = preferredStart;
    const int64_t keepPrefLen = preferredLength;
    if (!openUnlocked(*openLoader, openArchivePath, openRingCapacityFrames, openDeviceSampleRate,
                      error))
        return false;
    preferredStart = keepPrefStart;
    preferredLength = keepPrefLen > 0 ? keepPrefLen : preferredLength;

    pendingSkipFrames.store(deviceFrame, std::memory_order_release);
    int guard = 0;
    while (pendingSkipFrames.load(std::memory_order_acquire) > 0
           && !sourceExhausted.load(std::memory_order_acquire)
           && guard++ < 1000000) {
        const int bpf = decoder.bytesPerFrame();
        int64_t skip = pendingSkipFrames.load(std::memory_order_acquire);
        if (skip <= 0 || bpf <= 0)
            break;
        skip = std::min(skip, kMaxSkipDeviceFrames);
        const double nativeWantedD =
            static_cast<double>(skip) * std::max(resampleRatio, 1e-12);
        const int64_t nativeFramesWanted =
            static_cast<int64_t>(std::max(nativeWantedD, 1.0) + 0.5);
        const size_t bytesToSkip = static_cast<size_t>(std::min(
            static_cast<uint64_t>(nativeFramesWanted) * static_cast<uint64_t>(bpf),
            static_cast<uint64_t>(std::numeric_limits<size_t>::max() / 4)));
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
        } else {
            sourceExhausted.store(true, std::memory_order_release);
            pendingSkipFrames.store(0, std::memory_order_release);
        }
    }
    if (pendingSkipFrames.load(std::memory_order_acquire) > 0
        && !sourceExhausted.load(std::memory_order_acquire)) {
        error = "hardSeekTo: skip did not complete for " + openArchivePath;
        return false;
    }

    readPosition.store(deviceFrame, std::memory_order_release);
    pendingSkipFrames.store(0, std::memory_order_release);
    return true;
}

bool StreamingTrackBuffer::refill() {
    if (residentActive.load(std::memory_order_acquire))
        return false;

    std::lock_guard<std::mutex> lock(diskIoMutex);
    if (residentActive.load(std::memory_order_relaxed))
        return false;

    ensureRingReadyUnlocked();

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

    // Cursor may have been closed after resident publish.
    if (!cursor.isValid())
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

    // Resident path: lock-free after publish (data immutable).
    if (residentActive.load(std::memory_order_acquire)) {
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

    // Streaming ring path (may race a just-published resident — then next
    // block takes the resident path; this block is still valid ring data).
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
