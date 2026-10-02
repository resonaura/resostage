/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "plugins/PluginPowerControl.h"

#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <type_traits>

namespace resostage::plugin_host {

// Shared-memory ABI between Core and the isolated live plug-in host. Keep this
// header free of JUCE, STL containers, pointers, and platform handles: the
// mapped area is a byte-level process boundary, not a shared object graph.
inline constexpr uint32_t kMagic = 0x52535048; // "RSPH"
inline constexpr uint32_t kProtocolVersion = 8;
inline constexpr size_t kSlotCount = 3;
inline constexpr uint32_t kMaximumBlockSamples = 8192;
inline constexpr uint32_t kMaximumMidiEventsPerBlock = 512;
inline constexpr uint32_t kMaximumMidiEventBytes = 16;
inline constexpr uint32_t kMaximumParameterEventsPerBlock = 256;
inline constexpr uint32_t kMaximumPluginSlotsPerChain = 128;
inline constexpr uint32_t kMaximumParameterDescriptorsPerChain = 2048;
inline constexpr uint32_t kControlEventQueueCapacity = 2048;
// One callback of asynchronous headroom was too fragile when macOS briefly
// deprioritized a background helper. Keep a second bounded quantum between
// submission and playout; MixGraph PDC includes the same delay.
inline constexpr uint32_t kAudioPipelineCallbacks = 2;

// A block that missed its audio callback deadline can never be played later
// without moving plug-in time relative to the DAW. The output cursor must be
// strictly past that request before its eventual completion is considered.
constexpr uint64_t outputCursorAfterDeadlineMiss(
    uint64_t currentCursor, uint64_t missedSequence) noexcept {
    const uint64_t afterMiss = missedSequence == UINT64_MAX
        ? UINT64_MAX : missedSequence + 1;
    return currentCursor < afterMiss ? afterMiss : currentCursor;
}

// All state transitions are one-way within a generation:
// Core: Empty -> Writing -> Ready -> Processing -> Complete -> Empty.
// If a helper dies in any intermediate state, Core retires the whole mapping
// and starts a fresh generation; it never tries to repair a slot in place.
enum class SlotState : uint32_t {
    Empty = 0,
    Writing,
    Ready,
    Processing,
    Complete,
};

enum class HostState : uint32_t {
    Initializing = 0,
    Ready,
    Failed,
    Stopping,
};

enum class HostCommand : uint32_t {
    None = 0,
    CaptureStates = 1,
    OpenEditor = 2,
    CloseEditor = 3,
    CloseAllEditors = 4,
};

enum class PluginSlotStatus : uint8_t {
    Unknown = 0,
    Loaded = 1,
    Missing = 2,
    Failed = 3,
};

struct TransportSnapshot {
    int64_t sample = 0;
    int64_t loopStartSample = 0;
    int64_t loopEndSample = 0;
    uint64_t hostTimeNanos = 0;
    double sampleRate = 48000.0;
    double bpm = 120.0;
    int32_t numerator = 4;
    int32_t denominator = 4;
    uint8_t playing = 0;
    uint8_t recording = 0;
    uint8_t looping = 0;
    uint8_t reserved[5]{};
};

struct MidiEvent {
    uint32_t sampleOffset = 0;
    uint8_t size = 0;
    uint8_t reserved[3]{};
    uint8_t data[kMaximumMidiEventBytes]{};
};
using MIDIEvent = MidiEvent;

struct ParameterEvent {
    uint16_t slotIndex = 0;
    uint16_t reserved = 0;
    int32_t parameterIndex = -1;
    float normalizedValue = 0.0f;
};

// Published once by the child before HostState::Ready. Core reads these only
// off the callback, so parameter discovery never calls vendor code in Core.
struct ParameterDescriptor {
    uint16_t slotIndex = 0;
    uint16_t automatable = 1;
    uint32_t parameterIndex = 0;
    float defaultValue = 0.0f;
    uint32_t steps = 0;
    char name[64]{};
    char label[16]{};
    char parameterId[128]{};
};

struct alignas(16) ControlEventCell {
    std::atomic<uint64_t> sequence{0};
    ParameterEvent event{};
};

struct alignas(64) AudioSlot {
    std::atomic<uint32_t> state{static_cast<uint32_t>(SlotState::Empty)};
    uint32_t numSamples = 0;
    uint32_t midiEventCount = 0;
    uint32_t parameterEventCount = 0;
    uint64_t sequence = 0;
    TransportSnapshot transport{};
    std::array<MidiEvent, kMaximumMidiEventsPerBlock> midiEvents{};
    std::array<ParameterEvent, kMaximumParameterEventsPerBlock> parameterEvents{};
    // Planar stereo arrays stay private to the helper's adapter; right begins
    // at configuredMaximumBlock in each array. Vendor code is always given
    // helper-owned JUCE buffers, never mapped shared memory.
    alignas(64) std::array<float, kMaximumBlockSamples * 2> input{};
    alignas(64) std::array<float, kMaximumBlockSamples * 2> output{};
};

struct alignas(64) SharedArea {
    SharedArea() noexcept {
        for (uint64_t i = 0; i < kControlEventQueueCapacity; ++i)
            controlEvents[static_cast<size_t>(i)].sequence.store(
                i, std::memory_order_relaxed);
    }

    uint32_t magic = kMagic;
    uint32_t protocolVersion = kProtocolVersion;
    uint32_t byteSize = 0;
    uint32_t configuredMaximumBlock = 0;
    double configuredSampleRate = 48000.0;
    uint64_t generation = 0;
    uint64_t ownerProcessId = 0;
    // Updated by the child at startup and when a live plug-in changes latency.
    // Core adds the nominal device callback quantum (not buffer capacity) to
    // this value for the asynchronous host pipe.
    std::atomic<uint32_t> processorLatencySamples{0};
    // Binary wake edge: multiple queued blocks coalesce into one OS wake so
    // a delayed helper cannot accumulate a semaphore backlog and spin after
    // it has drained the currently available slots.
    std::atomic<uint32_t> wakePending{0};
    // Control events use a separate OS wake so parameter/state work never
    // wakes the audio worker and idle command workers never need to poll.
    std::atomic<uint32_t> controlWakePending{0};
    double processorTailSeconds = 0.0;
    uint32_t pluginSlotCount = 0;
    std::array<uint8_t, kMaximumPluginSlotsPerChain> pluginSlotStatuses{};
    // Latest-wins fixed power mailboxes do not compete with sample/parameter
    // events. Core may publish from UI or lookahead; helper DSP alone consumes
    // requests and publishes actual power state. No extra polling worker/wake.
    std::atomic<bool> chainPrewarmRequested{false};
    std::array<std::atomic<uint32_t>, kMaximumPluginSlotsPerChain>
        pluginSlotPowerRequests{};
    std::array<std::atomic<uint8_t>, kMaximumPluginSlotsPerChain>
        pluginSlotPowerStates{};
    // Startup/slot diagnostics are written by the helper before publishing
    // HostState::Ready/Failed, then remain immutable for this generation.
    // Fixed-size text avoids a second IPC channel and preserves bounded reads.
    std::array<char, 512> startupError{};
    std::array<std::array<char, 256>, kMaximumPluginSlotsPerChain>
        pluginSlotErrors{};
    uint32_t parameterDescriptorCount = 0;
    uint8_t parameterMetadataTruncated = 0;
    std::array<ParameterDescriptor, kMaximumParameterDescriptorsPerChain>
        parameterDescriptors{};
    // Helper parameter listeners publish latest normalized values directly.
    // These are independent scalars, not a multi-field DSP snapshot; Core's
    // HTTP thread can read them without calling or blocking vendor code.
    std::array<std::atomic<float>, kMaximumParameterDescriptorsPerChain>
        parameterValues{};
    std::atomic<uint32_t> hostState{
        static_cast<uint32_t>(HostState::Initializing)};
    std::atomic<uint32_t> command{
        static_cast<uint32_t>(HostCommand::None)};
    std::atomic<uint32_t> commandSlotIndex{0};
    std::atomic<uint64_t> commandRequest{0};
    std::atomic<uint64_t> commandComplete{0};
    std::atomic<uint32_t> commandResult{0};
    std::atomic<uint32_t> activePluginIndex{
        std::numeric_limits<uint32_t>::max()};
    std::atomic<uint64_t> heartbeat{0};
    std::atomic<uint64_t> stateChangeCounter{0};
    std::atomic<uint64_t> latencyChangeCounter{0};
    std::atomic<uint64_t> missedInputBlocks{0};
    std::atomic<uint64_t> missedOutputBlocks{0};
    std::atomic<uint64_t> missedControlEvents{0};
    alignas(64) std::atomic<uint64_t> controlEnqueuePosition{0};
    alignas(64) std::atomic<uint64_t> controlDequeuePosition{0};
    std::array<ControlEventCell, kControlEventQueueCapacity> controlEvents{};
    std::array<AudioSlot, kSlotCount> slots{};
};

static_assert(std::atomic<uint32_t>::is_always_lock_free,
              "Plug-in host shared ABI requires lock-free 32-bit atomics");
static_assert(std::atomic<uint64_t>::is_always_lock_free,
              "Plug-in host shared ABI requires lock-free 64-bit atomics");
static_assert(std::atomic<uint8_t>::is_always_lock_free
              && std::atomic<bool>::is_always_lock_free,
              "Plug-in power mailboxes require lock-free small atomics");
static_assert(std::is_standard_layout_v<TransportSnapshot>);
static_assert(std::is_trivially_copyable_v<TransportSnapshot>);
static_assert(std::is_standard_layout_v<MidiEvent>);
static_assert(std::is_trivially_copyable_v<MidiEvent>);
static_assert(std::is_standard_layout_v<ParameterEvent>);
static_assert(std::is_trivially_copyable_v<ParameterEvent>);
static_assert(std::is_trivially_copyable_v<ParameterDescriptor>);
static_assert(std::is_standard_layout_v<ControlEventCell>);

/** Predictive wake is one coalesced chain edge, regardless of its insert count. */
inline void publishChainPrewarm(SharedArea& area) noexcept {
    if (!area.chainPrewarmRequested.load(std::memory_order_relaxed))
        area.chainPrewarmRequested.store(true, std::memory_order_release);
}

// Paired controls preserve their newest value; wakes coalesce. Eight CAS
// attempts bound concurrent UI/automation contention, with the existing
// shared control rejection counter accounting for the rejected newest intent.
inline bool publishPowerControl(SharedArea& area, uint32_t slotIndex,
                                PluginPowerControl control) noexcept {
    if (slotIndex >= area.pluginSlotCount
        || slotIndex >= kMaximumPluginSlotsPerChain) {
        area.missedControlEvents.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    uint32_t replaceMask = 0;
    switch (control) {
        case PluginPowerControl::Wake: break;
        case PluginPowerControl::Park:
        case PluginPowerControl::Unpark:
            replaceMask = pluginPowerControlMask(PluginPowerControl::Park)
                | pluginPowerControlMask(PluginPowerControl::Unpark);
            break;
        case PluginPowerControl::KeepAwakeEnable:
        case PluginPowerControl::KeepAwakeDisable:
            replaceMask = pluginPowerControlMask(PluginPowerControl::KeepAwakeEnable)
                | pluginPowerControlMask(PluginPowerControl::KeepAwakeDisable);
            break;
        case PluginPowerControl::BypassEnable:
        case PluginPowerControl::BypassDisable:
            replaceMask = pluginPowerControlMask(PluginPowerControl::BypassEnable)
                | pluginPowerControlMask(PluginPowerControl::BypassDisable);
            break;
        case PluginPowerControl::RecordArmedEnable:
        case PluginPowerControl::RecordArmedDisable:
            replaceMask = pluginPowerControlMask(PluginPowerControl::RecordArmedEnable)
                | pluginPowerControlMask(PluginPowerControl::RecordArmedDisable);
            break;
        case PluginPowerControl::InputMonitoringEnable:
        case PluginPowerControl::InputMonitoringDisable:
            replaceMask = pluginPowerControlMask(PluginPowerControl::InputMonitoringEnable)
                | pluginPowerControlMask(PluginPowerControl::InputMonitoringDisable);
            break;
        default:
            area.missedControlEvents.fetch_add(1, std::memory_order_relaxed);
            return false;
    }
    auto& mailbox = area.pluginSlotPowerRequests[slotIndex];
    auto previous = mailbox.load(std::memory_order_relaxed);
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        const auto next = (previous & ~replaceMask) | pluginPowerControlMask(control);
        if (previous == next
            || mailbox.compare_exchange_weak(previous, next, std::memory_order_release,
                                             std::memory_order_relaxed))
            return true;
    }
    area.missedControlEvents.fetch_add(1, std::memory_order_relaxed);
    return false;
}

// Bounded lock-free multi-producer/single-consumer controls. UI, automation,
// and transport producers may enqueue concurrently; the helper worker owns
// the sole consumer. Contention drops an event after eight CAS attempts.
inline bool tryEnqueueControl(SharedArea& area,
                              const ParameterEvent& event) noexcept {
    uint64_t position = area.controlEnqueuePosition.load(std::memory_order_relaxed);
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        auto& cell = area.controlEvents[static_cast<size_t>(
            position % kControlEventQueueCapacity)];
        const uint64_t sequence = cell.sequence.load(std::memory_order_acquire);
        const int64_t difference = static_cast<int64_t>(sequence)
            - static_cast<int64_t>(position);
        if (difference == 0) {
            if (area.controlEnqueuePosition.compare_exchange_weak(
                    position, position + 1, std::memory_order_relaxed)) {
                cell.event = event;
                cell.sequence.store(position + 1, std::memory_order_release);
                return true;
            }
        } else if (difference < 0) {
            area.missedControlEvents.fetch_add(1, std::memory_order_relaxed);
            return false;
        } else {
            position = area.controlEnqueuePosition.load(std::memory_order_relaxed);
        }
    }
    area.missedControlEvents.fetch_add(1, std::memory_order_relaxed);
    return false;
}

inline bool tryDequeueControl(SharedArea& area,
                              ParameterEvent& event) noexcept {
    uint64_t position = area.controlDequeuePosition.load(std::memory_order_relaxed);
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        auto& cell = area.controlEvents[static_cast<size_t>(
            position % kControlEventQueueCapacity)];
        const uint64_t sequence = cell.sequence.load(std::memory_order_acquire);
        const int64_t difference = static_cast<int64_t>(sequence)
            - static_cast<int64_t>(position + 1);
        if (difference == 0) {
            if (area.controlDequeuePosition.compare_exchange_weak(
                    position, position + 1, std::memory_order_relaxed)) {
                event = cell.event;
                cell.sequence.store(position + kControlEventQueueCapacity,
                                    std::memory_order_release);
                return true;
            }
        } else if (difference < 0) {
            return false;
        } else {
            position = area.controlDequeuePosition.load(std::memory_order_relaxed);
        }
    }
    return false;
}

/** Helper command owner only (message thread for editors, control worker for
 * capture). Clear the old mailbox before publishing completion: Core may reuse
 * it immediately after its acquire-load of commandComplete. A later None store
 * would overwrite the next command even though its request was accepted.
 */
inline void completeCommand(SharedArea& area, uint64_t request,
                            bool succeeded) noexcept {
    area.commandResult.store(succeeded ? 1u : 0u, std::memory_order_relaxed);
    area.command.store(static_cast<uint32_t>(HostCommand::None),
                       std::memory_order_relaxed);
    area.commandComplete.store(request, std::memory_order_release);
}

inline bool validate(const SharedArea& area, uint64_t expectedGeneration,
                     uint32_t maximumBlockSamples,
                     double sampleRate = 48000.0) noexcept {
    return area.magic == kMagic
        && area.protocolVersion == kProtocolVersion
        && area.byteSize == sizeof(SharedArea)
        && area.generation == expectedGeneration
        && maximumBlockSamples > 0
        && maximumBlockSamples <= kMaximumBlockSamples
        && area.configuredMaximumBlock == maximumBlockSamples
        && std::isfinite(sampleRate) && sampleRate > 0.0
        && std::abs(area.configuredSampleRate - sampleRate) <= 0.001;
}

// Core is the sole producer. Failure is immediate if a prior response has not
// been consumed; the callback must emit bounded silence and increment health,
// never wait for the child or overwrite an in-flight block.
inline AudioSlot* tryBeginWrite(SharedArea& area, uint64_t sequence) noexcept {
    AudioSlot& slot = area.slots[sequence % kSlotCount];
    uint32_t expected = static_cast<uint32_t>(SlotState::Empty);
    if (!slot.state.compare_exchange_strong(
            expected, static_cast<uint32_t>(SlotState::Writing),
            std::memory_order_acquire, std::memory_order_relaxed))
        return nullptr;
    slot.sequence = sequence;
    return &slot;
}

inline bool publishInput(AudioSlot& slot, uint32_t numSamples,
                         uint32_t midiEventCount,
                         uint32_t parameterEventCount) noexcept {
    if (numSamples == 0 || numSamples > kMaximumBlockSamples
        || midiEventCount > kMaximumMidiEventsPerBlock
        || parameterEventCount > kMaximumParameterEventsPerBlock) {
        slot.state.store(static_cast<uint32_t>(SlotState::Empty),
                         std::memory_order_release);
        return false;
    }
    slot.numSamples = numSamples;
    slot.midiEventCount = midiEventCount;
    slot.parameterEventCount = parameterEventCount;
    slot.state.store(static_cast<uint32_t>(SlotState::Ready),
                     std::memory_order_release);
    return true;
}

// The helper is the sole consumer and processes only the next sequence. This
// prevents a late or duplicated request from reordering audio/MIDI state.
inline AudioSlot* tryBeginProcess(SharedArea& area,
                                  uint64_t expectedSequence) noexcept {
    AudioSlot& slot = area.slots[expectedSequence % kSlotCount];
    if (slot.state.load(std::memory_order_acquire)
            != static_cast<uint32_t>(SlotState::Ready)
        || slot.sequence != expectedSequence)
        return nullptr;
    uint32_t expected = static_cast<uint32_t>(SlotState::Ready);
    if (!slot.state.compare_exchange_strong(
            expected, static_cast<uint32_t>(SlotState::Processing),
            std::memory_order_acquire, std::memory_order_relaxed))
        return nullptr;
    return &slot;
}

// The helper may skip sequence numbers when Core rejected a full ring slot.
// It claims the oldest remaining request and returns immediately if the ring
// has none ready; it never waits for a missing producer sequence.
inline AudioSlot* tryBeginNextProcess(SharedArea& area,
                                      uint64_t& nextSequence) noexcept {
    AudioSlot* oldest = nullptr;
    uint64_t oldestSequence = std::numeric_limits<uint64_t>::max();
    for (auto& slot : area.slots) {
        if (slot.state.load(std::memory_order_acquire)
                != static_cast<uint32_t>(SlotState::Ready))
            continue;
        const uint64_t sequence = slot.sequence;
        if (sequence < nextSequence) {
            uint32_t expected = static_cast<uint32_t>(SlotState::Ready);
            (void)slot.state.compare_exchange_strong(
                expected, static_cast<uint32_t>(SlotState::Empty),
                std::memory_order_acq_rel, std::memory_order_relaxed);
            continue;
        }
        if (sequence < oldestSequence) {
            oldest = &slot;
            oldestSequence = sequence;
        }
    }
    if (oldest == nullptr)
        return nullptr;
    uint32_t expected = static_cast<uint32_t>(SlotState::Ready);
    if (!oldest->state.compare_exchange_strong(
            expected, static_cast<uint32_t>(SlotState::Processing),
            std::memory_order_acquire, std::memory_order_relaxed))
        return nullptr;
    nextSequence = oldestSequence + 1;
    return oldest;
}

inline void publishOutput(AudioSlot& slot) noexcept {
    slot.state.store(static_cast<uint32_t>(SlotState::Complete),
                     std::memory_order_release);
}

// Core consumes exactly the requested sequence. A completed late block can be
// discarded by advancing its slot to Empty; stale audio is never replayed.
inline AudioSlot* tryTakeOutput(SharedArea& area,
                                uint64_t expectedSequence) noexcept {
    AudioSlot& slot = area.slots[expectedSequence % kSlotCount];
    if (slot.state.load(std::memory_order_acquire)
            != static_cast<uint32_t>(SlotState::Complete)
        || slot.sequence != expectedSequence)
        return nullptr;
    return &slot;
}

inline void releaseOutput(AudioSlot& slot) noexcept {
    slot.state.store(static_cast<uint32_t>(SlotState::Empty),
                     std::memory_order_release);
}

} // namespace resostage::plugin_host
