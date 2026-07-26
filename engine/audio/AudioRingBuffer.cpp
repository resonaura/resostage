#include "AudioRingBuffer.h"

#include <algorithm>

namespace resoset {

void AudioRingBuffer::prepare(int channels, int64_t capacityFrames) {
    channelCount = std::max(0, channels);
    capacityFramesValue = std::max<int64_t>(0, capacityFrames);
    storage.assign(static_cast<size_t>(channelCount), std::vector<float>(static_cast<size_t>(capacityFramesValue), 0.0f));
    writeIndex.store(0, std::memory_order_relaxed);
    readIndex.store(0, std::memory_order_relaxed);
}

int64_t AudioRingBuffer::push(const float* const* inChannels, int64_t numFrames) {
    if (capacityFramesValue == 0 || numFrames <= 0)
        return 0;

    const int64_t w = writeIndex.load(std::memory_order_relaxed);
    const int64_t r = readIndex.load(std::memory_order_acquire);
    const int64_t free = capacityFramesValue - (w - r);
    const int64_t toWrite = std::min(numFrames, std::max<int64_t>(0, free));

    for (int64_t i = 0; i < toWrite; ++i) {
        const int64_t slot = (w + i) % capacityFramesValue;
        for (int ch = 0; ch < channelCount; ++ch)
            storage[static_cast<size_t>(ch)][static_cast<size_t>(slot)] = inChannels[ch][i];
    }

    writeIndex.store(w + toWrite, std::memory_order_release);
    return toWrite;
}

int64_t AudioRingBuffer::pop(float* const* outChannels, int64_t numFrames) {
    if (capacityFramesValue == 0 || numFrames <= 0)
        return 0;

    const int64_t r = readIndex.load(std::memory_order_relaxed);
    const int64_t w = writeIndex.load(std::memory_order_acquire);
    const int64_t available = w - r;
    const int64_t toRead = std::min(numFrames, std::max<int64_t>(0, available));

    for (int64_t i = 0; i < toRead; ++i) {
        const int64_t slot = (r + i) % capacityFramesValue;
        for (int ch = 0; ch < channelCount; ++ch)
            outChannels[ch][i] = storage[static_cast<size_t>(ch)][static_cast<size_t>(slot)];
    }

    readIndex.store(r + toRead, std::memory_order_release);
    return toRead;
}

int64_t AudioRingBuffer::discard(int64_t numFrames) {
    if (capacityFramesValue == 0 || numFrames <= 0)
        return 0;

    const int64_t r = readIndex.load(std::memory_order_relaxed);
    const int64_t w = writeIndex.load(std::memory_order_acquire);
    const int64_t available = w - r;
    const int64_t toDiscard = std::min(numFrames, std::max<int64_t>(0, available));

    readIndex.store(r + toDiscard, std::memory_order_release);
    return toDiscard;
}

int64_t AudioRingBuffer::framesAvailable() const {
    const int64_t w = writeIndex.load(std::memory_order_acquire);
    const int64_t r = readIndex.load(std::memory_order_acquire);
    return std::max<int64_t>(0, w - r);
}

void AudioRingBuffer::reset() {
    readIndex.store(writeIndex.load(std::memory_order_acquire), std::memory_order_release);
}

} // namespace resoset
