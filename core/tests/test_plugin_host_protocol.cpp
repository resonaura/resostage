#include "doctest.h"

#if defined(RESOSTAGE_TEST_PLUGIN_HOST)
#include "plugins/PluginHostProcess.h"
#include "plugins/PluginHostSharedMemory.h"
#endif
#include "plugins/PluginHostProtocol.h"

#include <chrono>
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
    REQUIRE(publishInput(*request, 4, 1, 1));

    CHECK(tryBeginWrite(area, kSlotCount) == nullptr);
    CHECK(tryBeginProcess(area, 1) == nullptr);
    AudioSlot* processing = tryBeginProcess(area, 0);
    REQUIRE(processing == request);
    CHECK(processing->numSamples == 4);
    CHECK(processing->midiEventCount == 1);
    CHECK(processing->midiEvents[0].sampleOffset == 2);
    CHECK(processing->parameterEventCount == 1);
    CHECK(processing->parameterEvents[0].parameterIndex == 7);

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
    CHECK(peer.waitForWake(50));
    CHECK_FALSE(peer.waitForWake(1));

    CHECK_FALSE(peer.open(name, 98, 512, error));
    CHECK(peer.area() == nullptr);
}

#if defined(RESOSTAGE_TEST_PLUGIN_HOST)
TEST_CASE("isolated plug-in helper returns fixed blocks one callback later") {
    using resostage::PluginHostProcess;
    using namespace resostage::plugin_host;

    PluginHostProcess host;
    std::string error;
    const juce::File executable(RESOSTAGE_PLUGIN_HOST_PATH);
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
    CHECK(host.processBlock(left.data(), right.data(), 512,
                            nullptr, 0, nullptr, 0, transport));
    CHECK(left == originalLeft);
    CHECK(right == originalRight);
    CHECK(host.missedOutputBlocks() == 0);

    const auto secondDeadline = std::chrono::steady_clock::now()
        + std::chrono::seconds(2);
    while (host.completedBlocks() < 2
           && std::chrono::steady_clock::now() < secondDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    REQUIRE(host.completedBlocks() >= 2);
    left.fill(0.25f);
    right.fill(-0.5f);
    CHECK(host.processBlock(left.data(), right.data(), 256,
                            nullptr, 0, nullptr, 0, transport));
    for (size_t i = 0; i < 256; ++i) {
        CHECK(left[i] == doctest::Approx(0.125f));
        CHECK(right[i] == doctest::Approx(-0.25f));
    }

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
}
#endif
