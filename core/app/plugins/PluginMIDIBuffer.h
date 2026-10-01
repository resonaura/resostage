/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "plugins/PluginHostProtocol.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
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

} // namespace resostage
