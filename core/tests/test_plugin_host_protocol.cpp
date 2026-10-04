/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#if defined(RESOSTAGE_TEST_PLUGIN_HOST)
#include "plugins/PluginHostProcess.h"
#include "plugins/PluginHostSharedMemory.h"
#include "plugins/PluginMIDIBuffer.h"
#include "plugins/PluginPaths.h"
#endif
#include "plugins/PluginHostProtocol.h"

#if defined(RESOSTAGE_TEST_PLUGIN_HOST) && JUCE_MAC
#include "project/ProjectLoader.h"
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <thread>

#if defined(_WIN32)
#include <windows.h>
#else
#include <unistd.h>
#endif

using namespace resostage::plugin_host;
using namespace resostage;

namespace {

#if defined(RESOSTAGE_TEST_PLUGIN_HOST)
juce::File pluginHostTestExecutable() {
    const char* overridePath = std::getenv("RESOSTAGE_TEST_PLUGIN_HOST_PATH");
    return overridePath != nullptr && overridePath[0] != '\0'
        ? juce::File(overridePath)
        : juce::File(RESOSTAGE_PLUGIN_HOST_PATH);
}

void exerciseHostPowerControls(PluginHostProcess& host, bool verifySuspension) {
    std::array<float, 512> left{};
    std::array<float, 512> right{};
    const TransportSnapshot transport{};
    const auto pump = [&](unsigned blocks) {
        for (unsigned block = 0; block < blocks; ++block) {
            left.fill(0.0f);
            right.fill(0.0f);
            const auto previous = host.completedBlocks();
            (void)host.processBlock(left.data(), right.data(), 512,
                                    nullptr, 0, nullptr, 0, transport, false);
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
            while (host.completedBlocks() <= previous
                   && std::chrono::steady_clock::now() < deadline)
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            REQUIRE(host.completedBlocks() > previous);
        }
    };
    REQUIRE(host.requestPowerControl(0, PluginPowerControl::Park));
    pump(3);
    CHECK(host.pluginSlotPowerState(0) == PluginPowerState::Parked);
    REQUIRE(host.requestPowerControl(0, PluginPowerControl::Wake));
    REQUIRE(host.requestPowerControl(0, PluginPowerControl::KeepAwakeEnable));
    host.requestChainPrewarm();
    pump(3);
    CHECK(host.pluginSlotPowerState(0) == PluginPowerState::Parked);
    REQUIRE(host.requestPowerControl(0, PluginPowerControl::Unpark));
    pump(3);
    CHECK(host.pluginSlotPowerState(0) != PluginPowerState::Parked);
    CHECK(host.pluginSlotPowerState(0) != PluginPowerState::Suspended);
    if (verifySuspension) {
        // MSED has no declared tail; its default guard time is five seconds.
        // Advance sample time (not wall time) through 6.8 seconds of silence.
        pump(640);
        CHECK(host.pluginSlotPowerState(0) != PluginPowerState::Suspended);
        REQUIRE(host.requestPowerControl(0, PluginPowerControl::KeepAwakeDisable));
        pump(640);
        CHECK(host.pluginSlotPowerState(0) == PluginPowerState::Suspended);
        host.requestChainPrewarm();
        pump(3);
        CHECK(host.pluginSlotPowerState(0) != PluginPowerState::Suspended);
        REQUIRE(host.requestPowerControl(0, PluginPowerControl::KeepAwakeEnable));
        pump(3);
        CHECK(host.pluginSlotPowerState(0) != PluginPowerState::Suspended);
    }
    CHECK(host.missedControlEvents() == 0);
}
#endif

void initialize(SharedArea& area, uint64_t generation, uint32_t blockSize) {
    area.magic = kMagic;
    area.protocolVersion = kProtocolVersion;
    area.byteSize = static_cast<uint32_t>(sizeof(SharedArea));
    area.configuredMaximumBlock = blockSize;
    area.generation = generation;
    area.hostState.store(static_cast<uint32_t>(HostState::Ready),
                         std::memory_order_release);
}

} // namespace

TEST_CASE("plug-in host shared frames have a validated versioned ABI") {
    SharedArea area{};
    initialize(area, 41, 512);

    CHECK(validate(area, 41, 512));
    CHECK_FALSE(validate(area, 40, 512));
    CHECK_FALSE(validate(area, 41, 256));
    area.protocolVersion++;
    CHECK_FALSE(validate(area, 41, 512));
}

TEST_CASE("isolated editor bypass requests are latest-wins and revision-fenced") {
    SharedArea area{};
    area.pluginSlotCount = 1;
    area.pluginSlotStatuses[0] = static_cast<uint8_t>(PluginSlotStatus::Loaded);
    publishInitialBypassState(area, 0, false);
    const uint64_t initialState = area.pluginSlotBypassStates[0]
        .load(std::memory_order_acquire);
    uint64_t lastSeen = 0;
    EditorBypassRequest request;

    CHECK_FALSE(consumeEditorBypassRequest(area, 0, lastSeen, request));
    CHECK(publishEditorBypassRequest(area, 0, initialState, true));
    REQUIRE(consumeEditorBypassRequest(area, 0, lastSeen, request));
    CHECK(request.baseState == initialState);
    CHECK(request.bypassed);
    CHECK(editorBypassRequestIsCurrent(area, 0, request));
    CHECK_FALSE(consumeEditorBypassRequest(area, 0, lastSeen, request));

    // Rapid toggles before Core polls collapse to the final intent instead of
    // replaying an obsolete click or mutating the processor from the helper.
    CHECK(publishEditorBypassRequest(area, 0, initialState, true));
    CHECK(publishEditorBypassRequest(area, 0, initialState, false));
    REQUIRE(consumeEditorBypassRequest(area, 0, lastSeen, request));
    CHECK_FALSE(request.bypassed);
    CHECK(editorBypassRequestIsCurrent(area, 0, request));

    publishCoreBypassState(area, 0, true);
    CHECK_FALSE(editorBypassRequestIsCurrent(area, 0, request));
    CHECK(publishEditorBypassRequest(area, 0, request.baseState, false));
    REQUIRE(consumeEditorBypassRequest(area, 0, lastSeen, request));
    CHECK_FALSE(editorBypassRequestIsCurrent(area, 0, request));
    CHECK_FALSE(publishEditorBypassRequest(area, 1, initialState, true));
}

TEST_CASE("plug-in host command completion releases the mailbox before Core reuses it") {
    auto area = std::make_unique<SharedArea>();
    constexpr uint64_t requests = 20000;
    std::atomic<bool> invalidCommand{false};
    std::atomic<bool> stop{false};
    std::thread helper([&] {
        uint64_t completed = 0;
        while (!stop.load(std::memory_order_acquire) && completed < requests) {
            const auto request = area->commandRequest.load(std::memory_order_acquire);
            if (request == completed) { std::this_thread::yield(); continue; }
            const auto expected = request % 2 == 0 ? HostCommand::CloseEditor : HostCommand::OpenEditor;
            if (area->command.load(std::memory_order_relaxed) != static_cast<uint32_t>(expected))
                invalidCommand.store(true, std::memory_order_relaxed);
            completeCommand(*area, request, true);
            completed = request;
        }
    });
    // Two non-realtime command owners reuse the single mailbox immediately.
    // Bound the diagnostic wait so a regression cannot hang the test suite.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    uint64_t completed = 0;
    for (uint64_t request = 1; request <= requests; ++request) {
        const auto command = request % 2 == 0 ? HostCommand::CloseEditor : HostCommand::OpenEditor;
        area->command.store(static_cast<uint32_t>(command), std::memory_order_relaxed);
        area->commandRequest.store(request, std::memory_order_release);
        while (area->commandComplete.load(std::memory_order_acquire) != request
               && std::chrono::steady_clock::now() < deadline)
            std::this_thread::yield();
        if (area->commandComplete.load(std::memory_order_acquire) != request) break;
        completed = request;
        CHECK(area->commandResult.load(std::memory_order_relaxed) == 1);
    }
    stop.store(true, std::memory_order_release);
    helper.join();
    CHECK(completed == requests);
    CHECK_FALSE(invalidCommand.load(std::memory_order_relaxed));
    CHECK(area->command.load(std::memory_order_relaxed) == static_cast<uint32_t>(HostCommand::None));
}

TEST_CASE("plug-in host never replays output that missed its deadline") {
    CHECK(outputCursorAfterDeadlineMiss(12, 12) == 13);
    CHECK(12 < outputCursorAfterDeadlineMiss(12, 12));
    CHECK(outputCursorAfterDeadlineMiss(15, 12) == 15);
    CHECK(outputCursorAfterDeadlineMiss(UINT64_MAX, UINT64_MAX) == UINT64_MAX);
}

TEST_CASE("plug-in host frames transfer ownership without waiting or overwriting") {
    SharedArea area{};
    initialize(area, 8, 4);

    AudioSlot* request = tryBeginWrite(area, 0);
    REQUIRE(request != nullptr);
    request->input[0] = 0.25f;
    request->input[1] = -0.5f;
    request->midiEvents[0].sampleOffset = 2;
    request->midiEvents[0].size = 3;
    request->midiEvents[0].data[0] = 0x90;
    request->parameterEvents[0] = {1, 0, 7, 0.75f};
    request->sidechainFeeds[0].pluginSlotIndex = 1;
    request->sidechainFeeds[0].inputBusIndex = 2;
    request->sidechainFeeds[0].channelMode = 3;
    request->sidechainFeeds[0].active = 1;
    request->sidechainFeeds[0].left[0] = 0.125f;
    request->sidechainFeeds[0].right[0] = -0.25f;
    REQUIRE(publishInput(*request, 4, 1, 1, 1));

    CHECK(tryBeginWrite(area, kSlotCount) == nullptr);
    CHECK(tryBeginProcess(area, 1) == nullptr);
    AudioSlot* processing = tryBeginProcess(area, 0);
    REQUIRE(processing == request);
    CHECK(processing->numSamples == 4);
    CHECK(processing->midiEventCount == 1);
    CHECK(processing->midiEvents[0].sampleOffset == 2);
    CHECK(processing->parameterEventCount == 1);
    CHECK(processing->parameterEvents[0].parameterIndex == 7);
    CHECK(processing->sidechainFeedCount == 1);
    CHECK(processing->sidechainFeeds[0].pluginSlotIndex == 1);
    CHECK(processing->sidechainFeeds[0].inputBusIndex == 2);
    CHECK(processing->sidechainFeeds[0].channelMode == 3);
    CHECK(processing->sidechainFeeds[0].left[0] == doctest::Approx(0.125f));
    CHECK(processing->sidechainFeeds[0].right[0] == doctest::Approx(-0.25f));

    processing->output[0] = processing->input[0] * 2.0f;
    processing->output[1] = processing->input[1] * 2.0f;
    CHECK(tryTakeOutput(area, 0) == nullptr);
    publishOutput(*processing);

    AudioSlot* response = tryTakeOutput(area, 0);
    REQUIRE(response == request);
    CHECK(response->output[0] == doctest::Approx(0.5f));
    CHECK(response->output[1] == doctest::Approx(-1.0f));
    releaseOutput(*response);

    AudioSlot* wrapped = tryBeginWrite(area, kSlotCount);
    REQUIRE(wrapped != nullptr);
    CHECK(wrapped == request);
    CHECK(wrapped->sequence == kSlotCount);
    CHECK(publishInput(*wrapped, 1, 0, 0));
}

TEST_CASE("plug-in host rejects malformed frames and releases their slot") {
    SharedArea area{};
    initialize(area, 12, 16);

    AudioSlot* slot = tryBeginWrite(area, 0);
    REQUIRE(slot != nullptr);
    CHECK_FALSE(publishInput(*slot, kMaximumBlockSamples + 1, 0, 0));
    CHECK(slot->state.load(std::memory_order_acquire)
          == static_cast<uint32_t>(SlotState::Empty));

    slot = tryBeginWrite(area, 0);
    REQUIRE(slot != nullptr);
    CHECK_FALSE(publishInput(*slot, 1, kMaximumMidiEventsPerBlock + 1, 0));
    CHECK(slot->state.load(std::memory_order_acquire)
          == static_cast<uint32_t>(SlotState::Empty));

    slot = tryBeginWrite(area, 0);
    REQUIRE(slot != nullptr);
    CHECK_FALSE(publishInput(*slot, 1, 0,
                             kMaximumParameterEventsPerBlock + 1));
    CHECK(slot->state.load(std::memory_order_acquire)
          == static_cast<uint32_t>(SlotState::Empty));

    slot = tryBeginWrite(area, 0);
    REQUIRE(slot != nullptr);
    CHECK_FALSE(publishInput(*slot, 1, 0, 0,
                             kMaximumSidechainFeedsPerChain + 1));
    CHECK(slot->state.load(std::memory_order_acquire)
          == static_cast<uint32_t>(SlotState::Empty));
}

TEST_CASE("plug-in host control queue is bounded and supports concurrent producers") {
    SharedArea area{};
    initialize(area, 19, 512);
    constexpr uint16_t producerCount = 4;
    constexpr uint16_t eventsPerProducer = 40;
    std::array<std::thread, producerCount> producers;
    for (uint16_t producer = 0; producer < producerCount; ++producer) {
        producers[producer] = std::thread([&area, producer] {
            for (uint16_t eventIndex = 0; eventIndex < eventsPerProducer;
                 ++eventIndex) {
                const ParameterEvent event{
                    producer, 0, static_cast<int32_t>(eventIndex),
                    static_cast<float>(eventIndex) / eventsPerProducer};
                while (!tryEnqueueControl(area, event))
                    std::this_thread::yield();
            }
        });
    }
    for (auto& producer : producers)
        producer.join();

    std::array<std::array<bool, eventsPerProducer>, producerCount> seen{};
    size_t drained = 0;
    ParameterEvent event;
    while (tryDequeueControl(area, event)) {
        REQUIRE(event.slotIndex < producerCount);
        REQUIRE(event.parameterIndex >= 0);
        REQUIRE(event.parameterIndex < eventsPerProducer);
        CHECK_FALSE(seen[event.slotIndex][static_cast<size_t>(event.parameterIndex)]);
        seen[event.slotIndex][static_cast<size_t>(event.parameterIndex)] = true;
        ++drained;
    }
    CHECK(drained == static_cast<size_t>(producerCount) * eventsPerProducer);
    for (const auto& producerEvents : seen)
        for (const bool received : producerEvents)
            CHECK(received);
    CHECK_FALSE(tryDequeueControl(area, event));
}

TEST_CASE("plug-in host control overflow is bounded and counted") {
    SharedArea area{};
    for (uint16_t i = 0; i < kControlEventQueueCapacity; ++i)
        REQUIRE(tryEnqueueControl(area, ParameterEvent{i, 0, 0, 0.5f}));
    CHECK_FALSE(tryEnqueueControl(area, ParameterEvent{0, 0, 1, 0.25f}));
    CHECK(area.missedControlEvents.load(std::memory_order_relaxed) == 1);
}

TEST_CASE("plug-in host power mailboxes coalesce independently of the parameter queue") {
    SharedArea area{};
    area.pluginSlotCount = kMaximumPluginSlotsPerChain;
    for (uint16_t index = 0; index < kControlEventQueueCapacity; ++index)
        REQUIRE(tryEnqueueControl(area, ParameterEvent{index, 0, 0, 0.5f}));
    const auto enqueueCursor = area.controlEnqueuePosition.load(std::memory_order_relaxed);
    for (uint32_t slotIndex = 0; slotIndex < kMaximumPluginSlotsPerChain; ++slotIndex) {
        for (unsigned repetition = 0; repetition < 100; ++repetition)
            REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::Wake));
        REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::KeepAwakeEnable));
        REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::KeepAwakeDisable));
        REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::Park));
        REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::Unpark));
        REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::BypassEnable));
        REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::BypassDisable));
        REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::RecordArmedEnable));
        REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::RecordArmedDisable));
        REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::InputMonitoringEnable));
        REQUIRE(publishPowerControl(area, slotIndex, PluginPowerControl::InputMonitoringDisable));
        const auto mask = area.pluginSlotPowerRequests[slotIndex].exchange(0);
        CHECK(hasPluginPowerControl(mask, PluginPowerControl::Wake));
        CHECK_FALSE(hasPluginPowerControl(mask, PluginPowerControl::KeepAwakeEnable));
        CHECK(hasPluginPowerControl(mask, PluginPowerControl::KeepAwakeDisable));
        CHECK_FALSE(hasPluginPowerControl(mask, PluginPowerControl::Park));
        CHECK(hasPluginPowerControl(mask, PluginPowerControl::Unpark));
        CHECK_FALSE(hasPluginPowerControl(mask, PluginPowerControl::BypassEnable));
        CHECK(hasPluginPowerControl(mask, PluginPowerControl::BypassDisable));
        CHECK_FALSE(hasPluginPowerControl(mask, PluginPowerControl::RecordArmedEnable));
        CHECK(hasPluginPowerControl(mask, PluginPowerControl::RecordArmedDisable));
        CHECK_FALSE(hasPluginPowerControl(mask, PluginPowerControl::InputMonitoringEnable));
        CHECK(hasPluginPowerControl(mask, PluginPowerControl::InputMonitoringDisable));
    }
    CHECK(area.controlEnqueuePosition.load(std::memory_order_relaxed) == enqueueCursor);
    CHECK(area.missedControlEvents.load(std::memory_order_relaxed) == 0);
    CHECK_FALSE(publishPowerControl(area, kMaximumPluginSlotsPerChain, PluginPowerControl::Wake));
    CHECK_FALSE(publishPowerControl(area, 0, static_cast<PluginPowerControl>(0xffffffffu)));
    CHECK(area.missedControlEvents.load(std::memory_order_relaxed) == 2);
}

TEST_CASE("plug-in host power mailbox retains independent requests from concurrent producers") {
    SharedArea area{};
    area.pluginSlotCount = 1;
    std::atomic<bool> start{false};
    std::array<std::thread, 5> producers;
    constexpr PluginPowerControl controls[] = {
        PluginPowerControl::Wake, PluginPowerControl::KeepAwakeEnable,
        PluginPowerControl::Park, PluginPowerControl::RecordArmedEnable,
        PluginPowerControl::InputMonitoringEnable};
    for (size_t index = 0; index < producers.size(); ++index)
        producers[index] = std::thread([&, index] {
            while (!start.load(std::memory_order_acquire))
                std::this_thread::yield();
            for (unsigned repetition = 0; repetition < 10000; ++repetition)
                (void)publishPowerControl(area, 0, controls[index]);
        });
    start.store(true, std::memory_order_release);
    for (auto& producer : producers)
        producer.join();
    const auto mask = area.pluginSlotPowerRequests[0].exchange(0);
    for (const auto control : controls)
        CHECK(hasPluginPowerControl(mask, control));
    CHECK(area.controlEnqueuePosition.load(std::memory_order_relaxed) == 0);
    CHECK(area.pluginSlotPowerRequests[0].load(std::memory_order_relaxed) == 0);
}

#if defined(RESOSTAGE_TEST_PLUGIN_HOST)
TEST_CASE("plug-in host MIDI ingress fits every maximum-sized packet without storage growth") {
    PluginMIDIBuffer midi;
    const auto* preparedStorage = midi.buffer().data.begin();
    std::array<uint8_t, kMaximumMidiEventBytes> message{};
    message[0] = 0xf0;
    message.back() = 0xf7;
    for (uint32_t index = 0; index < kMaximumMidiEventsPerBlock; ++index)
        REQUIRE(midi.add(message.data(), static_cast<int>(message.size()),
                         static_cast<int>(index)));

    CHECK(midi.size() == kMaximumMidiEventsPerBlock);
    CHECK(static_cast<size_t>(midi.buffer().data.size()) == PluginMIDIBuffer::capacityBytes);
    CHECK(midi.buffer().data.begin() == preparedStorage);
    CHECK_FALSE(midi.add(message.data(), static_cast<int>(message.size()), 0));
    CHECK(midi.rejectedEvents() == 1);
    CHECK(midi.buffer().data.begin() == preparedStorage);

    midi.clear();
    std::array<uint8_t, kMaximumMidiEventBytes + 1> oversized{};
    oversized.front() = 0xf0;
    oversized.back() = 0xf7;
    CHECK_FALSE(midi.add(oversized.data(), static_cast<int>(oversized.size()), 0));
    CHECK_FALSE(midi.add(nullptr, 3, 0));
    CHECK_FALSE(midi.add(message.data(), 0, 0));
    CHECK_FALSE(midi.add(message.data(), static_cast<int>(message.size()), -1));
    CHECK(midi.size() == 0);
    CHECK(midi.rejectedEvents() == 5);
    CHECK(midi.buffer().data.begin() == preparedStorage);

    // The next callback reuses exactly the same fully prepared reservation.
    for (uint32_t index = 0; index < kMaximumMidiEventsPerBlock; ++index)
        REQUIRE(midi.add(message.data(), static_cast<int>(message.size()), 0));
    CHECK(midi.buffer().data.begin() == preparedStorage);
}

TEST_CASE("plug-in host MIDI packet copy rejects oversized views and leaves unused storage untouched") {
    juce::MidiBuffer source;
    std::array<uint8_t, 1024> longSysEx{};
    longSysEx.front() = 0xf0;
    longSysEx.back() = 0xf7;
    REQUIRE(source.addEvent(longSysEx.data(), static_cast<int>(longSysEx.size()), 1));
    REQUIRE(source.addEvent(juce::MidiMessage::noteOn(1, 64, static_cast<uint8_t>(100)), 17));
    REQUIRE(source.addEvent(juce::MidiMessage::noteOff(1, 64), 512));
    std::array<MidiEvent, 2> output{};
    output[0].data[15] = 0x55;
    output[1].sampleOffset = 0xabcdef;
    output[1].size = 15;
    output[1].data[0] = 0x66;
    const auto result = copyPluginMIDIEventsToHost(
        source, output.data(), static_cast<uint32_t>(output.size()), 512);
    CHECK(result.copied == 1);
    CHECK(result.rejected == 2);
    CHECK(output[0].sampleOffset == 17);
    CHECK(output[0].size == 3);
    CHECK(output[0].data[0] == 0x90);
    CHECK(output[0].data[1] == 64);
    CHECK(output[0].data[2] == 100);
    CHECK(output[0].data[15] == 0x55);
    CHECK(output[1].sampleOffset == 0xabcdef);
    CHECK(output[1].size == 15);
    CHECK(output[1].data[0] == 0x66);

    REQUIRE(source.addEvent(juce::MidiMessage::controllerEvent(1, 64, 0), 18));
    const auto full = copyPluginMIDIEventsToHost(source, output.data(), 1, 512);
    CHECK(full.copied == 1);
    CHECK(full.rejected == 3);
}

TEST_CASE("plug-in host panic MIDI burst cannot be dropped by a full music buffer") {
    PluginMIDIBuffer midi;
    const auto* preparedStorage = midi.buffer().data.begin();
    for (uint32_t index = 0; index < kMaximumMidiEventsPerBlock; ++index)
        REQUIRE(midi.add(juce::MidiMessage::noteOn(1, 60, static_cast<uint8_t>(100)), 0));
    midi.makeRoomForPanic(16 * 3);
    CHECK(midi.size() == 0);
    CHECK(midi.rejectedEvents() == kMaximumMidiEventsPerBlock);
    for (int channel = 1; channel <= 16; ++channel) {
        REQUIRE(midi.add(juce::MidiMessage::allSoundOff(channel), 0));
        REQUIRE(midi.add(juce::MidiMessage::controllerEvent(channel, 121, 0), 0));
        REQUIRE(midi.add(juce::MidiMessage::pitchWheel(channel, 8192), 0));
    }
    CHECK(midi.size() == 48);
    CHECK(midi.buffer().data.begin() == preparedStorage);
    midi.makeRoomForPanic(32);
    CHECK(midi.size() == 48);
    CHECK(midi.rejectedEvents() == kMaximumMidiEventsPerBlock);
}

TEST_CASE("offline plug-in MIDI retains full SysEx support beyond the live packet cap") {
    PluginMIDIBuffer offlineMidi(true);
    std::array<uint8_t, 1024> sysEx{};
    sysEx.front() = 0xf0;
    sysEx.back() = 0xf7;
    REQUIRE(offlineMidi.add(sysEx.data(), static_cast<int>(sysEx.size()), 0));
    CHECK((*offlineMidi.buffer().begin()).numBytes == static_cast<int>(sysEx.size()));
    CHECK(offlineMidi.rejectedEvents() == 0);
}

TEST_CASE("instrument MIDI deferred during state capture is replayed in order without growth") {
    PluginMIDIBuffer captured;
    REQUIRE(captured.add(juce::MidiMessage::noteOn(1, 64,
                       static_cast<uint8_t>(100)), 17));
    REQUIRE(captured.add(juce::MidiMessage::noteOff(1, 64), 31));
    PluginMIDIDeferredQueue deferred;
    deferred.capture(captured.buffer());
    CHECK(deferred.hasPending());

    PluginMIDIBuffer replay;
    const auto* preparedStorage = replay.buffer().data.begin();
    CHECK(deferred.replayInto(replay) == 2);
    CHECK_FALSE(deferred.hasPending());
    REQUIRE(replay.size() == 2);
    auto iterator = replay.buffer().begin();
    const auto noteOn = *iterator++;
    const auto noteOff = *iterator;
    CHECK(noteOn.samplePosition == 0);
    CHECK(noteOn.data[0] == 0x90);
    CHECK(noteOn.data[1] == 64);
    CHECK(noteOff.samplePosition == 0);
    CHECK(noteOff.data[0] == 0x80);
    CHECK(noteOff.data[1] == 64);
    CHECK(replay.buffer().data.begin() == preparedStorage);
}

TEST_CASE("deferred MIDI overflow clears ambiguous history and replays channel panic") {
    juce::MidiBuffer input;
    for (uint32_t index = 0; index <= PluginMIDIDeferredQueue::capacity; ++index)
        REQUIRE(input.addEvent(juce::MidiMessage::noteOn(1, 60,
                           static_cast<uint8_t>(100)), static_cast<int>(index)));

    PluginMIDIDeferredQueue deferred;
    deferred.capture(input);
    CHECK(deferred.hasPending());
    CHECK(deferred.takeDroppedEvents() == PluginMIDIDeferredQueue::capacity + 1);

    PluginMIDIBuffer replay;
    CHECK(deferred.replayInto(replay) == 48);
    CHECK_FALSE(deferred.hasPending());
    REQUIRE(replay.size() == 48);
    int allSoundOffCount = 0;
    for (const juce::MidiMessageMetadata event : replay.buffer())
        if (event.numBytes == 3 && event.data[0] >= 0xb0
            && event.data[0] <= 0xbf && event.data[1] == 120)
            ++allSoundOffCount;
    CHECK(allSoundOffCount == 16);
}

TEST_CASE("dense sustain-release and panic traffic during deferred MIDI state capture preserves packets and panic recovery") {
    PluginMIDIDeferredQueue deferred;
    PluginMIDIBuffer input;

    // 1. Interleave active sustain pedal (CC 64), pitch bend, and notes across channels 1..4
    constexpr int kChannels = 4;
    for (int ch = 1; ch <= kChannels; ++ch) {
        const int base = (ch - 1) * 50;
        REQUIRE(input.add(juce::MidiMessage::controllerEvent(ch, 64, 127), base + 0));
        REQUIRE(input.add(juce::MidiMessage::pitchWheel(ch, 10000), base + 5));
        REQUIRE(input.add(juce::MidiMessage::noteOn(ch, 60, static_cast<uint8_t>(90)), base + 10));
        REQUIRE(input.add(juce::MidiMessage::noteOn(ch, 64, static_cast<uint8_t>(95)), base + 15));
        REQUIRE(input.add(juce::MidiMessage::controllerEvent(ch, 64, 0), base + 20));
        REQUIRE(input.add(juce::MidiMessage::noteOff(ch, 60), base + 25));
        REQUIRE(input.add(juce::MidiMessage::noteOff(ch, 64), base + 30));
    }

    // Capture into deferred queue during state capture window
    deferred.capture(input.buffer());
    CHECK(deferred.hasPending());
    CHECK(deferred.takeDroppedEvents() == 0);

    // Replay into destination buffer
    PluginMIDIBuffer replayed;
    const uint32_t replayedCount = deferred.replayInto(replayed);
    CHECK(replayedCount == kChannels * 7);
    CHECK_FALSE(deferred.hasPending());
    CHECK(replayed.size() == kChannels * 7);

    // Verify ordering and content
    int index = 0;
    for (const juce::MidiMessageMetadata event : replayed.buffer()) {
        const int ch = (index / 7) + 1;
        const int step = index % 7;
        if (step == 0) {
            // Sustain ON
            CHECK(event.data[0] == (0xb0 | (ch - 1)));
            CHECK(event.data[1] == 64);
            CHECK(event.data[2] == 127);
        } else if (step == 4) {
            // Sustain OFF
            CHECK(event.data[0] == (0xb0 | (ch - 1)));
            CHECK(event.data[1] == 64);
            CHECK(event.data[2] == 0);
        }
        ++index;
    }

    // 2. Now simulate heavy burst that exceeds capacity
    juce::MidiBuffer overflowBurst;
    for (uint32_t i = 0; i <= PluginMIDIDeferredQueue::capacity; ++i) {
        REQUIRE(overflowBurst.addEvent(
            juce::MidiMessage::controllerEvent(1, 64, static_cast<uint8_t>(i % 128)),
            static_cast<int>(i)));
    }
    deferred.capture(overflowBurst);
    CHECK(deferred.hasPending());
    CHECK(deferred.takeDroppedEvents() == PluginMIDIDeferredQueue::capacity + 1);

    // Replay after overflow: must emit 48-event panic (AllSoundOff, ResetControllers, CenterPitch across 16 channels)
    PluginMIDIBuffer panicReplay;
    const uint32_t panicCount = deferred.replayInto(panicReplay);
    CHECK(panicCount == 48);
    CHECK_FALSE(deferred.hasPending());

    // 3. Verify clean recovery: next incoming note is captured and replayed cleanly
    PluginMIDIBuffer postRecoveryInput;
    REQUIRE(postRecoveryInput.add(juce::MidiMessage::noteOn(1, 72, static_cast<uint8_t>(100)), 0));
    deferred.capture(postRecoveryInput.buffer());
    CHECK(deferred.hasPending());
    CHECK(deferred.takeDroppedEvents() == 0);

    PluginMIDIBuffer postRecoveryReplay;
    CHECK(deferred.replayInto(postRecoveryReplay) == 1);
    CHECK_FALSE(deferred.hasPending());
    CHECK(postRecoveryReplay.size() == 1);
    const auto finalEvent = *postRecoveryReplay.buffer().begin();
    CHECK(finalEvent.data[0] == 0x90);
    CHECK(finalEvent.data[1] == 72);
}
#endif

TEST_CASE("plug-in host shared memory opens a second process view and signals it") {
    uint64_t processId = 0;
#if defined(_WIN32)
    processId = GetCurrentProcessId();
    const std::string name = "Local\\ResoStagePluginHostTest-"
        + std::to_string(processId);
#else
    processId = static_cast<uint64_t>(getpid());
    const std::string name = "/rsph-" + std::to_string(processId);
#endif

    PluginHostSharedMemory owner;
    std::string error;
    const bool created = owner.create(name, 99, 512, error);
    INFO(error);
    REQUIRE(created);
    REQUIRE(owner.isOwner());

    PluginHostSharedMemory peer;
    REQUIRE(peer.open(name, 99, 512, error));
    CHECK_FALSE(peer.isOwner());
    REQUIRE(peer.area() != owner.area());
    CHECK(peer.area()->generation == 99);

    owner.area()->hostState.store(static_cast<uint32_t>(HostState::Ready),
                                  std::memory_order_release);
    CHECK(owner.signalWake());
    CHECK(owner.signalWake()); // binary edge: repeated requests coalesce
    CHECK(owner.area()->wakePending.load(std::memory_order_acquire) == 1);
    CHECK(peer.waitForWake());
    CHECK(owner.area()->wakePending.load(std::memory_order_acquire) == 0);
    CHECK(owner.signalWake()); // a later edge still wakes the worker
    CHECK(peer.waitForWake());

    CHECK(owner.signalControlWake());
    CHECK(owner.signalControlWake());
    CHECK(owner.area()->controlWakePending.load(std::memory_order_acquire) == 1);
    CHECK(peer.waitForControlWake());
    CHECK(owner.area()->controlWakePending.load(std::memory_order_acquire) == 0);

    CHECK_FALSE(peer.open(name, 98, 512, error));
    CHECK(peer.area() == nullptr);
}

#if defined(RESOSTAGE_TEST_PLUGIN_HOST)
TEST_CASE("isolated plug-in helper returns fixed blocks after two callback quanta") {
    using resostage::PluginHostProcess;
    using namespace resostage::plugin_host;

    PluginHostProcess host;
    std::string error;
    const auto executable = pluginHostTestExecutable();
    REQUIRE_MESSAGE(host.start(executable, 101, 512, error), error);
    CHECK(host.isRunning());
    CHECK(host.isReady());

    std::array<float, 512> left{};
    std::array<float, 512> right{};
    std::array<float, 512> originalLeft{};
    std::array<float, 512> originalRight{};
    for (size_t i = 0; i < left.size(); ++i) {
        left[i] = static_cast<float>(i) / 512.0f;
        right[i] = -left[i];
    }
    originalLeft = left;
    originalRight = right;
    const TransportSnapshot transport{};

    CHECK_FALSE(host.processBlock(left.data(), right.data(), 512,
                                  nullptr, 0, nullptr, 0, transport));
    for (const float sample : left) CHECK(sample == 0.0f);
    for (const float sample : right) CHECK(sample == 0.0f);

    const auto deadline = std::chrono::steady_clock::now()
        + std::chrono::seconds(2);
    while (host.completedBlocks() == 0
           && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() == 1);

    left.fill(0.125f);
    right.fill(-0.25f);
    CHECK_FALSE(host.processBlock(left.data(), right.data(), 512,
                                  nullptr, 0, nullptr, 0, transport));
    CHECK(std::all_of(left.begin(), left.end(), [](float value) { return value == 0.0f; }));
    CHECK(std::all_of(right.begin(), right.end(), [](float value) { return value == 0.0f; }));

    const auto secondDeadline = std::chrono::steady_clock::now()
        + std::chrono::seconds(2);
    while (host.completedBlocks() < 2
           && std::chrono::steady_clock::now() < secondDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() >= 2);
    left.fill(0.25f);
    right.fill(-0.5f);
    CHECK(host.processBlock(left.data(), right.data(), 512,
                            nullptr, 0, nullptr, 0, transport));
    CHECK(left == originalLeft);
    CHECK(right == originalRight);
    CHECK(host.missedOutputBlocks() == 0);

    const auto thirdDeadline = std::chrono::steady_clock::now()
        + std::chrono::seconds(2);
    while (host.completedBlocks() < 3
           && std::chrono::steady_clock::now() < thirdDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() >= 3);
    left.fill(0.5f);
    right.fill(-0.75f);
    CHECK(host.processBlock(left.data(), right.data(), 256,
                            nullptr, 0, nullptr, 0, transport));
    for (size_t i = 0; i < 256; ++i) {
        CHECK(left[i] == doctest::Approx(0.125f));
        CHECK(right[i] == doctest::Approx(-0.25f));
    }

    const auto fourthDeadline = std::chrono::steady_clock::now()
        + std::chrono::seconds(2);
    while (host.completedBlocks() < 4
           && std::chrono::steady_clock::now() < fourthDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() >= 4);
    left.fill(0.75f);
    right.fill(-1.0f);
    CHECK(host.processBlock(left.data(), right.data(), 256,
                            nullptr, 0, nullptr, 0, transport));
    for (size_t i = 0; i < 256; ++i) {
        CHECK(left[i] == doctest::Approx(0.25f));
        CHECK(right[i] == doctest::Approx(-0.5f));
    }
}
#endif

#if defined(RESOSTAGE_TEST_PLUGIN_HOST) && JUCE_MAC
TEST_CASE("isolated helper loads a real macOS Audio Unit and opens its editor") {
    using namespace resostage;
    using namespace resostage::plugin_host;

    const auto registry = pluginRegistryFile();
    if (!registry.existsAsFile()) {
        MESSAGE("Skipping real Audio Unit integration check: local AU registry is absent");
        return;
    }
    const auto registryText = registry.loadFileAsString();
    if (!registryText.contains("name=\"AUDelay\"")
        || !registryText.contains("file=\"AudioUnit:Effects/aufx,dely,appl\"")) {
        MESSAGE("Skipping real Audio Unit integration check: Apple AUDelay is not catalogued");
        return;
    }

    const auto projectDirectory = juce::File::getSpecialLocation(
        juce::File::tempDirectory).getChildFile(
            "resostage-au-host-test-" + juce::Uuid().toString().removeCharacters("{}-"));
    struct DirectoryCleanup final {
        juce::File directory;
        ~DirectoryCleanup() { if (directory.exists()) (void)directory.deleteRecursively(); }
    } cleanup{projectDirectory};
    ProjectLoader project;
    project.newProject("Isolated AU Host Test");
    project.project().tracks.clear();
    TrackDef track;
    track.id = "host::track:1";
    track.name = "AUDelay Test";
    track.kind = TrackKind::Audio;
    PluginSlot slot;
    slot.id = "test-au-slot";
    slot.plugin.identifier = "AudioUnit-AUDelay-60bc1b50-64607a6d";
    slot.plugin.format = "AudioUnit";
    slot.plugin.name = "AUDelay";
    slot.plugin.manufacturer = "Apple";
    slot.plugin.fileOrIdentifier = "AudioUnit:Effects/aufx,dely,appl";
    track.plugins.push_back(slot);
    project.project().tracks.push_back(std::move(track));

    std::string error;
    REQUIRE_MESSAGE(project.saveAs(projectDirectory.getFullPathName().toStdString(), error), error);

    PluginHostProcess host;
    const auto executable = pluginHostTestExecutable();
    REQUIRE_MESSAGE(host.start(executable, 20260929, 512, error, 48000.0,
                               projectDirectory, registry), error);
    INFO("AUDelay host status: " << static_cast<int>(host.pluginSlotStatus(0)));
    REQUIRE(host.pluginSlotStatus(0) == PluginSlotStatus::Loaded);

    std::array<float, 512> left{};
    std::array<float, 512> right{};
    for (size_t i = 0; i < left.size(); ++i) {
        left[i] = right[i] = 0.2f * std::sin(
            2.0 * 3.14159265358979323846 * 440.0 * static_cast<double>(i) / 48000.0);
    }
    const auto expectedPeak = *std::max_element(left.begin(), left.end());
    const TransportSnapshot transport{};
    CHECK_FALSE(host.processBlock(left.data(), right.data(), 512,
                                  nullptr, 0, nullptr, 0, transport));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (host.completedBlocks() == 0
           && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() == 1);
    left.fill(0.2f);
    right.fill(0.2f);
    CHECK_FALSE(host.processBlock(left.data(), right.data(), 512,
                                  nullptr, 0, nullptr, 0, transport));
    const auto secondDeadline = std::chrono::steady_clock::now()
        + std::chrono::seconds(2);
    while (host.completedBlocks() < 2
           && std::chrono::steady_clock::now() < secondDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() >= 2);
    left.fill(0.0f);
    right.fill(0.0f);
    REQUIRE(host.processBlock(left.data(), right.data(), 512,
                              nullptr, 0, nullptr, 0, transport));
    CHECK(*std::max_element(left.begin(), left.end()) > expectedPeak * 0.25f);
    CHECK(host.requestOpenEditor(0));
    CHECK(host.requestCloseEditor(0));

    std::vector<float> values;
    const auto metadata = host.parameterDescriptorsForSlot(0, &values);
    REQUIRE_FALSE(metadata.empty());
    REQUIRE(values.size() == metadata.size());
    const auto compactValues = host.parameterValuesForSlot(0);
    REQUIRE(compactValues.size() == metadata.size());
    CHECK_FALSE(host.parameterMetadataTruncated());
    for (size_t i = 0; i < metadata.size(); ++i) {
        CHECK(metadata[i].name[0] != '\0');
        CHECK(std::string_view(metadata[i].parameterId).starts_with("id:"));
        CHECK(std::isfinite(values[i]));
        CHECK(values[i] >= 0.0f);
        CHECK(values[i] <= 1.0f);
        CHECK(compactValues[i].index == metadata[i].parameterIndex);
        CHECK(compactValues[i].value == doctest::Approx(values[i]).epsilon(0.001f));
    }
    const auto continuous = std::find_if(metadata.begin(), metadata.end(),
        [](const ParameterDescriptor& parameter) {
            return parameter.automatable != 0 && parameter.steps > 128;
        });
    REQUIRE(continuous != metadata.end());
    const size_t index = static_cast<size_t>(continuous - metadata.begin());
    ParameterEvent changed;
    changed.slotIndex = 0;
    changed.parameterIndex = static_cast<int32_t>(continuous->parameterIndex);
    changed.normalizedValue = values[index] < 0.5f ? 0.75f : 0.25f;
    REQUIRE(host.enqueueParameterEvent(changed));
    const auto valueDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (std::chrono::steady_clock::now() < valueDeadline) {
        (void)host.parameterDescriptorsForSlot(0, &values);
        if (std::abs(values[index] - changed.normalizedValue) < 0.001f) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    CHECK(values[index] == doctest::Approx(changed.normalizedValue).epsilon(0.001f));
    const auto refreshedCompactValues = host.parameterValuesForSlot(0);
    const auto changedCompactValue = std::find_if(
        refreshedCompactValues.begin(), refreshedCompactValues.end(),
        [&](const PluginHostProcess::ParameterValue& value) {
            return value.index == static_cast<uint32_t>(continuous->parameterIndex);
        });
    REQUIRE(changedCompactValue != refreshedCompactValues.end());
    CHECK(changedCompactValue->value
        == doctest::Approx(changed.normalizedValue).epsilon(0.001f));

    exerciseHostPowerControls(host, false);
    host.stop();
}

TEST_CASE("isolated helper renders MIDI through an actual macOS Audio Unit instrument") {
    using namespace resostage;
    using namespace resostage::plugin_host;

    const auto registry = pluginRegistryFile();
    if (!registry.existsAsFile()) {
        MESSAGE("Skipping Audio Unit instrument check: local plug-in registry is absent");
        return;
    }
    auto registryXml = juce::XmlDocument(registry).getDocumentElement();
    if (registryXml == nullptr) {
        MESSAGE("Skipping Audio Unit instrument check: local plug-in registry is invalid");
        return;
    }
    bool foundInstrument = false;
    for (auto* item = registryXml->getFirstChildElement(); item != nullptr;
         item = item->getNextElement()) {
        if (item->getStringAttribute("name") == "DLSMusicDevice"
            && item->getStringAttribute("format") == "AudioUnit"
            && item->getStringAttribute("isInstrument") == "1"
            && item->getStringAttribute("file")
                == "AudioUnit:Synths/aumu,dls ,appl") {
            foundInstrument = true;
            break;
        }
    }
    if (!foundInstrument) {
        MESSAGE("Skipping Audio Unit instrument check: Apple's DLSMusicDevice is not catalogued");
        return;
    }

    const auto projectDirectory = juce::File::getSpecialLocation(
        juce::File::tempDirectory).getChildFile(
            "resostage-au-instrument-host-test-"
            + juce::Uuid().toString().removeCharacters("{}-"));
    struct DirectoryCleanup final {
        juce::File directory;
        ~DirectoryCleanup() { if (directory.exists()) (void)directory.deleteRecursively(); }
    } cleanup{projectDirectory};
    ProjectLoader project;
    project.newProject("Isolated AU Instrument Host Test");
    project.project().tracks.clear();
    TrackDef track;
    track.id = "host::track:1";
    track.name = "DLS MIDI Test";
    track.kind = TrackKind::Instrument;
    PluginSlot slot;
    slot.id = "test-au-instrument-slot";
    const juce::String instrumentFileId("AudioUnit:Synths/aumu,dls ,appl");
    slot.plugin.identifier = "AudioUnit-DLSMusicDevice-"
        + juce::String::toHexString(instrumentFileId.hashCode()).toStdString()
        + "-64696e39";
    slot.plugin.format = "AudioUnit";
    slot.plugin.name = "DLSMusicDevice";
    slot.plugin.manufacturer = "Apple";
    slot.plugin.fileOrIdentifier = instrumentFileId.toStdString();
    slot.plugin.instrument = true;
    track.plugins.push_back(slot);
    project.project().tracks.push_back(std::move(track));

    std::string error;
    REQUIRE_MESSAGE(project.saveAs(projectDirectory.getFullPathName().toStdString(), error), error);
    PluginHostProcess host;
    REQUIRE_MESSAGE(host.start(pluginHostTestExecutable(), 20260931, 512, error,
                               48000.0, projectDirectory, registry), error);
    INFO("DLSMusicDevice host status: "
         << static_cast<int>(host.pluginSlotStatus(0)));
    INFO("DLSMusicDevice load error: " << host.pluginSlotLoadError(0));
    REQUIRE(host.pluginSlotStatus(0) == PluginSlotStatus::Loaded);

    std::array<float, 512> left{};
    std::array<float, 512> right{};
    MidiEvent noteOn{};
    noteOn.sampleOffset = 32;
    noteOn.size = 3;
    noteOn.data[0] = 0x90;
    noteOn.data[1] = 60;
    noteOn.data[2] = 100;
    const TransportSnapshot transport{};
    CHECK_FALSE(host.processBlock(left.data(), right.data(), 512,
                                  &noteOn, 1, nullptr, 0, transport, true));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (host.completedBlocks() == 0
           && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() == 1);
    CHECK_FALSE(host.processBlock(left.data(), right.data(), 512,
                                  nullptr, 0, nullptr, 0, transport, true));
    const auto secondDeadline = std::chrono::steady_clock::now()
        + std::chrono::seconds(2);
    while (host.completedBlocks() < 2
           && std::chrono::steady_clock::now() < secondDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() >= 2);
    left.fill(0.0f);
    right.fill(0.0f);
    REQUIRE(host.processBlock(left.data(), right.data(), 512,
                              nullptr, 0, nullptr, 0, transport, true));
    const float peak = std::max(*std::max_element(left.begin(), left.end()),
                                *std::max_element(right.begin(), right.end()));
    CHECK(peak > 1.0e-6f);
    CHECK(host.requestOpenEditor(0));
    if (std::getenv("RESOSTAGE_TEST_HOLD_PLUGIN_EDITOR") != nullptr)
        std::this_thread::sleep_for(std::chrono::seconds(10));
    CHECK(host.requestCloseEditor(0));
    CHECK(host.missedOutputBlocks() == 0);
    host.stop();
}

TEST_CASE("isolated helper loads a real VST3 and opens its editor") {
    using namespace resostage;
    using namespace resostage::plugin_host;

    const auto registry = pluginRegistryFile();
    if (!registry.existsAsFile()) {
        MESSAGE("Skipping real VST3 integration check: local plug-in registry is absent");
        return;
    }
    const auto registryText = registry.loadFileAsString();
    if (!registryText.contains("name=\"MSED\" format=\"VST3\"")
        || !registryText.contains("file=\"/Library/Audio/Plug-Ins/VST3/MSED.vst3\"")) {
        MESSAGE("Skipping real VST3 integration check: Voxengo MSED is not catalogued");
        return;
    }

    const auto projectDirectory = juce::File::getSpecialLocation(
        juce::File::tempDirectory).getChildFile(
            "resostage-vst3-host-test-" + juce::Uuid().toString().removeCharacters("{}-"));
    struct DirectoryCleanup final {
        juce::File directory;
        ~DirectoryCleanup() { if (directory.exists()) (void)directory.deleteRecursively(); }
    } cleanup{projectDirectory};
    ProjectLoader project;
    project.newProject("Isolated VST3 Host Test");
    project.project().tracks.clear();
    TrackDef track;
    track.id = "host::track:1";
    track.name = "MSED Test";
    track.kind = TrackKind::Audio;
    PluginSlot slot;
    slot.id = "test-vst3-slot";
    slot.plugin.identifier = "VST3-MSED-69e2bb16-27054893";
    slot.plugin.format = "VST3";
    slot.plugin.name = "MSED";
    slot.plugin.manufacturer = "Voxengo";
    slot.plugin.fileOrIdentifier = "/Library/Audio/Plug-Ins/VST3/MSED.vst3";
    track.plugins.push_back(slot);
    project.project().tracks.push_back(std::move(track));

    std::string error;
    REQUIRE_MESSAGE(project.saveAs(projectDirectory.getFullPathName().toStdString(), error), error);
    PluginHostProcess host;
    const auto executable = pluginHostTestExecutable();
    REQUIRE_MESSAGE(host.start(executable, 20260930, 512, error, 48000.0,
                               projectDirectory, registry), error);
    INFO("MSED host status: " << static_cast<int>(host.pluginSlotStatus(0)));
    REQUIRE(host.pluginSlotStatus(0) == PluginSlotStatus::Loaded);

    std::array<float, 512> left{};
    std::array<float, 512> right{};
    for (size_t i = 0; i < left.size(); ++i)
        left[i] = right[i] = 0.2f * std::sin(
            2.0 * 3.14159265358979323846 * 440.0 * static_cast<double>(i) / 48000.0);
    const auto expectedPeak = *std::max_element(left.begin(), left.end());
    const TransportSnapshot transport{};
    CHECK_FALSE(host.processBlock(left.data(), right.data(), 512,
                                  nullptr, 0, nullptr, 0, transport));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (host.completedBlocks() == 0
           && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() == 1);
    left.fill(0.05f);
    right.fill(-0.05f);
    CHECK_FALSE(host.processBlock(left.data(), right.data(), 512,
                                  nullptr, 0, nullptr, 0, transport));
    const auto secondDeadline = std::chrono::steady_clock::now()
        + std::chrono::seconds(2);
    while (host.completedBlocks() < 2
           && std::chrono::steady_clock::now() < secondDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() >= 2);
    left.fill(0.0f);
    right.fill(0.0f);
    REQUIRE(host.processBlock(left.data(), right.data(), 512,
                              nullptr, 0, nullptr, 0, transport));
    CHECK(*std::max_element(left.begin(), left.end()) > expectedPeak * 0.25f);
    const auto thirdDeadline = std::chrono::steady_clock::now()
        + std::chrono::seconds(2);
    while (host.completedBlocks() < 3
           && std::chrono::steady_clock::now() < thirdDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() >= 3);
    CHECK(host.requestOpenEditor(0));
    CHECK(host.requestCloseEditor(0));

    const auto warmupDeadline = std::chrono::steady_clock::now()
        + std::chrono::seconds(2);
    while (host.completedBlocks() < 2
           && std::chrono::steady_clock::now() < warmupDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() >= 2);
    for (int block = 0; block < 64; ++block) {
        left.fill(0.05f);
        right.fill(-0.05f);
        INFO("VST3 live-pipeline block " << block);
        CHECK(host.processBlock(left.data(), right.data(), 512,
                                nullptr, 0, nullptr, 0, transport));
        std::this_thread::sleep_for(std::chrono::milliseconds(11));
    }
    CHECK(host.missedOutputBlocks() == 0);
    exerciseHostPowerControls(host, true);
    host.stop();

    // Small device buffers leave little room for cross-process wake latency.
    // Use a separate, correctly-prepared 64-sample helper (the device quantum
    // is stable during a run) to exercise the macOS adaptive polling path.
    PluginHostProcess smallBufferHost;
    REQUIRE_MESSAGE(smallBufferHost.start(executable, 20260932, 64, error,
                                          48000.0, projectDirectory, registry),
                    error);
    std::array<float, 64> smallLeft{};
    std::array<float, 64> smallRight{};
    for (int block = 0; block < 32; ++block) {
        smallLeft.fill(0.05f);
        smallRight.fill(-0.05f);
        INFO("VST3 64-sample live-pipeline block " << block);
        const bool returned = smallBufferHost.processBlock(
            smallLeft.data(), smallRight.data(), 64,
            nullptr, 0, nullptr, 0, transport);
        if (block < static_cast<int>(kAudioPipelineCallbacks))
            CHECK_FALSE(returned);
        else
            CHECK(returned);
        std::this_thread::sleep_for(std::chrono::microseconds(1333));
    }
    CHECK(smallBufferHost.missedOutputBlocks() == 0);
    smallBufferHost.stop();
}
#endif
