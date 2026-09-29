#include "doctest.h"

#if defined(RESOSTAGE_TEST_PLUGIN_HOST)
#include "plugins/PluginHostProcess.h"
#include "plugins/PluginHostSharedMemory.h"
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
