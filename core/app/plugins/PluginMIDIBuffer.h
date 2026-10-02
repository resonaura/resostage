/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "plugins/PluginHostProtocol.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace resostage {

struct PluginMIDICopyResult {
    uint32_t copied = 0;
    uint32_t rejected = 0;
};

/**
 * Copies non-owning JUCE event views into prepared IPC storage on the audio
 * thread. In particular, reject long SysEx before constructing an owning
 * MidiMessage, which can allocate even when the packet is later discarded.
 * Entries after `copied` are untouched; the shared slot's count gates reads.
 */
inline PluginMIDICopyResult copyPluginMIDIEventsToHost(
    const juce::MidiBuffer& source, plugin_host::MidiEvent* destination,
    uint32_t destinationCapacity, int numSamples) noexcept {
    PluginMIDICopyResult result;
    for (const juce::MidiMessageMetadata metadata : source) {
        if (metadata.numBytes <= 0
            || metadata.numBytes > static_cast<int>(plugin_host::kMaximumMidiEventBytes)
            || metadata.samplePosition < 0 || metadata.samplePosition >= numSamples
            || destination == nullptr || result.copied >= destinationCapacity) {
            ++result.rejected;
            continue;
        }
        auto& event = destination[result.copied++];
        event.sampleOffset = static_cast<uint32_t>(metadata.samplePosition);
        event.size = static_cast<uint8_t>(metadata.numBytes);
        std::copy_n(metadata.data, metadata.numBytes, event.data);
    }
    return result;
}

/**
 * Callback-owned MIDI ingress with fixed prepared JUCE storage. It shares the
 * host's 512-event/16-byte-packet limits in Core and live host banks. Reject the
 * newest normal event before JUCE can grow its storage, and keep a lifetime
 * counter readable by non-realtime diagnostics. Vendor code may change the
 * helper's own MIDI buffer; this bound protects Core's ingress, not vendor DSP.
 * Offline workers may explicitly permit storage growth to preserve full SysEx
 * support; that mode must never be used by a live callback or live helper.
 */
class PluginMIDIBuffer final {
public:
    static constexpr uint32_t maximumEvents = plugin_host::kMaximumMidiEventsPerBlock;
    // The pinned JUCE MidiBuffer stores an int32 sample offset and a uint16
    // payload size per event. Test the full 512 x 16-byte case so a framework
    // framing change cannot silently make the callback's reservation too small.
    static constexpr size_t eventHeaderBytes = sizeof(juce::int32) + sizeof(juce::uint16);
    static constexpr size_t capacityBytes = maximumEvents
        * (eventHeaderBytes + plugin_host::kMaximumMidiEventBytes);

    explicit PluginMIDIBuffer(bool allowOfflineGrowth = false)
        : bounded(!allowOfflineGrowth) { midi.ensureSize(capacityBytes); }

    bool add(const uint8_t* data, int numBytes, int samplePosition) noexcept {
        if (data == nullptr || numBytes <= 0 || data[0] < 0x80 || samplePosition < 0
            || (bounded && (numBytes > static_cast<int>(plugin_host::kMaximumMidiEventBytes)
                || eventCount >= maximumEvents
                || static_cast<size_t>(midi.data.size())
                    + static_cast<size_t>(numBytes) + eventHeaderBytes > capacityBytes))) {
            recordRejected(1);
            return false;
        }
        const auto previousBytes = midi.data.size();
        if (!midi.addEvent(data, numBytes, samplePosition)
            || midi.data.size() == previousBytes) {
            recordRejected(1);
            return false;
        }
        ++eventCount;
        return true;
    }

    bool add(const juce::MidiMessage& message, int samplePosition) noexcept {
        return add(message.getRawData(), message.getRawDataSize(), samplePosition);
    }

    void clear() noexcept {
        midi.clear();
        eventCount = 0;
    }

    /**
     * Exchanges prepared MIDI storage without allocating. Used to give one
     * instrument a deferred event batch while preserving the current strip
     * batch for downstream processors.
     */
    void swapContents(PluginMIDIBuffer& other) noexcept {
        midi.swapWith(other.midi);
        std::swap(eventCount, other.eventCount);
    }

    /**
     * Panic messages outrank buffered music. Only discard existing events when
     * a complete channel-wide panic burst would not fit; never drop half a
     * Stop/All Sound Off burst because normal ingress exhausted its capacity.
     */
    void makeRoomForPanic(uint32_t panicEvents) noexcept {
        if (!bounded)
            return;
        if (panicEvents > maximumEvents || eventCount > maximumEvents - panicEvents) {
            recordRejected(eventCount);
            clear();
        }
    }

    juce::MidiBuffer& buffer() noexcept { return midi; }
    const juce::MidiBuffer& buffer() const noexcept { return midi; }
    uint32_t size() const noexcept { return eventCount; }
    uint64_t rejectedEvents() const noexcept {
        return rejectedEventCount.load(std::memory_order_relaxed);
    }
    void recordRejected(uint32_t count) noexcept {
        if (count != 0)
            rejectedEventCount.fetch_add(count, std::memory_order_relaxed);
    }

private:
    juce::MidiBuffer midi;
    const bool bounded;
    uint32_t eventCount = 0;
    std::atomic<uint64_t> rejectedEventCount{0};
};

/**
 * Fixed-capacity FIFO for MIDI that arrives while an instrument is paused
 * briefly for a plug-in state snapshot. Deferred timestamps are rebased to
 * sample zero when replayed in the next available block. If the bounded FIFO
 * overflows, discard its ambiguous note history and send a channel-wide panic
 * before later queued events; the loss counter is reported with the snapshot.
 */
class PluginMIDIDeferredQueue final {
public:
    static constexpr uint32_t capacity = PluginMIDIBuffer::maximumEvents;

    void capture(const juce::MidiBuffer& source) noexcept {
        for (const juce::MidiMessageMetadata metadata : source) {
            captureEvent(metadata);
        }
    }

    bool captureEvent(const juce::MidiMessageMetadata& metadata) noexcept {
        if (metadata.data == nullptr || metadata.numBytes <= 0
            || metadata.numBytes > static_cast<int>(plugin_host::kMaximumMidiEventBytes)) {
            droppedEvents.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        if (size == capacity) {
            droppedEvents.fetch_add(static_cast<uint64_t>(size) + 1,
                                    std::memory_order_relaxed);
            size = 0;
            readIndex = 0;
            writeIndex = 0;
            panicPending = true;
            return false;
        }
        auto& event = events[writeIndex];
        event.size = static_cast<uint8_t>(metadata.numBytes);
        std::copy_n(metadata.data, metadata.numBytes, event.data.begin());
        writeIndex = (writeIndex + 1) % capacity;
        ++size;
        return true;
    }

    uint32_t replayInto(PluginMIDIBuffer& destination) noexcept {
        uint32_t replayed = 0;
        if (panicPending) {
            for (int channel = 1; channel <= 16; ++channel) {
                const auto ch = static_cast<uint8_t>(channel - 1);
                const std::array<uint8_t, 3> allSoundOff{
                    static_cast<uint8_t>(0xb0 | ch), 120, 0};
                const std::array<uint8_t, 3> resetControllers{
                    static_cast<uint8_t>(0xb0 | ch), 121, 0};
                const std::array<uint8_t, 3> centeredPitch{
                    static_cast<uint8_t>(0xe0 | ch), 0, 64};
                if (!destination.add(allSoundOff.data(), 3, 0)
                    || !destination.add(resetControllers.data(), 3, 0)
                    || !destination.add(centeredPitch.data(), 3, 0))
                    return replayed;
                replayed += 3;
            }
            panicPending = false;
        }

        while (size != 0) {
            const auto& event = events[readIndex];
            if (!destination.add(event.data.data(), event.size, 0))
                break;
            readIndex = (readIndex + 1) % capacity;
            --size;
            ++replayed;
        }
        return replayed;
    }

    bool hasPending() const noexcept { return panicPending || size != 0; }
    uint64_t takeDroppedEvents() noexcept {
        return droppedEvents.exchange(0, std::memory_order_relaxed);
    }

private:
    struct Event {
        std::array<uint8_t, plugin_host::kMaximumMidiEventBytes> data{};
        uint8_t size = 0;
    };

    std::array<Event, capacity> events{};
    uint32_t readIndex = 0;
    uint32_t writeIndex = 0;
    uint32_t size = 0;
    bool panicPending = false;
    std::atomic<uint64_t> droppedEvents{0};
};

} // namespace resostage
