#include "PluginHostProcess.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <thread>

namespace resostage {
namespace {

constexpr uint32_t kHostReadyTimeoutMilliseconds = 30000;

std::string makeSharedName() {
    juce::String token = juce::Uuid().toString().removeCharacters("{}-");
    token = token.substring(0, 24);
#if defined(_WIN32)
    return "Local\\rsph-" + token.toStdString();
#else
    return "/rsph-" + token.toStdString();
#endif
}

} // namespace

PluginHostProcess::PluginHostProcess() = default;
PluginHostProcess::~PluginHostProcess() { stop(); }

bool PluginHostProcess::start(const juce::File& executable,
                              uint64_t generation,
                              uint32_t maximumBlockSamples,
                              std::string& error,
                              double sampleRate,
                              const juce::File& projectDirectory,
                              const juce::File& registryFile) {
    stop();
    if (!executable.existsAsFile()) {
        error = "Live plug-in host executable is missing: "
                + executable.getFullPathName().toStdString();
        return false;
    }

    hostGeneration = generation;
    nextSequence = 0;
    maximumBlockSize = maximumBlockSamples;
    configuredSampleRate = sampleRate;
    missedOutputBlockCount.store(0, std::memory_order_relaxed);
    missedInputBlockCount.store(0, std::memory_order_relaxed);

    const std::string sharedName = makeSharedName();
    if (!sharedMemory.create(sharedName, generation, maximumBlockSamples,
                             error, sampleRate))
        return false;

    juce::StringArray arguments;
    arguments.add(executable.getFullPathName());
    arguments.add("--shared-memory");
    arguments.add(sharedName);
    arguments.add("--generation");
    arguments.add(juce::String(static_cast<juce::int64>(generation)));
    arguments.add("--block-size");
    arguments.add(juce::String(static_cast<int>(maximumBlockSamples)));
    arguments.add("--sample-rate");
    arguments.add(juce::String(sampleRate, 8));
    if (projectDirectory.isDirectory()) {
        arguments.add("--project-directory");
        arguments.add(projectDirectory.getFullPathName());
        arguments.add("--registry");
        arguments.add(registryFile.getFullPathName());
    }

    process = std::make_unique<juce::ChildProcess>();
    // The child is intentionally silent at the process boundary: leaving JUCE's
    // stdout pipe unread could eventually back-pressure a verbose plug-in and
    // stall its DSP thread. Startup diagnostics are carried by shared status.
    if (!process->start(arguments, 0)) {
        error = "Could not launch isolated live plug-in host";
        stop();
        return false;
    }

    const auto deadline = std::chrono::steady_clock::now()
        + std::chrono::milliseconds(kHostReadyTimeoutMilliseconds);
    while (std::chrono::steady_clock::now() < deadline) {
        const auto state = static_cast<plugin_host::HostState>(
            sharedMemory.area()->hostState.load(std::memory_order_acquire));
        if (state == plugin_host::HostState::Ready) {
            processAlive.store(true, std::memory_order_release);
            stopSupervisor.store(false, std::memory_order_release);
            supervisorThread = std::thread([this] { supervise(); });
            return true;
        }
        if (state == plugin_host::HostState::Failed || !process->isRunning()) {
            error = "Isolated live plug-in host failed during startup";
            if (const auto* area = sharedMemory.area()) {
                const uint32_t failureCode =
                    area->commandResult.load(std::memory_order_acquire);
                if (failureCode != 0)
                    error += " (host error " + std::to_string(failureCode) + ")";
            }
            if (process != nullptr && !process->isRunning())
                error += " (exit "
                    + std::to_string(process->getExitCode()) + ")";
            stop();
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    error = "Timed out starting isolated live plug-in host";
    stop();
    return false;
}

void PluginHostProcess::stop() noexcept {
    stopSupervisor.store(true, std::memory_order_release);
    if (supervisorThread.joinable())
        supervisorThread.join();
    if (sharedMemory.area() != nullptr) {
        sharedMemory.area()->hostState.store(
            static_cast<uint32_t>(plugin_host::HostState::Stopping),
            std::memory_order_release);
        (void)sharedMemory.signalWake();
    }
    if (process != nullptr) {
        if (process->isRunning())
            process->kill();
        process.reset();
    }
    processAlive.store(false, std::memory_order_release);
    // The helper has been terminated before the parent's mapping is unmapped.
    // Assigning an empty owner releases/unlinks the POSIX objects safely.
    sharedMemory = PluginHostSharedMemory{};
    hostGeneration = 0;
    nextSequence = 0;
    maximumBlockSize = 0;
    configuredSampleRate = 48000.0;
}

bool PluginHostProcess::isRunning() const noexcept {
    return processAlive.load(std::memory_order_acquire);
}

bool PluginHostProcess::isReady() const noexcept {
    return sharedMemory.area() != nullptr
        && sharedMemory.area()->hostState.load(std::memory_order_acquire)
            == static_cast<uint32_t>(plugin_host::HostState::Ready);
}

bool PluginHostProcess::enqueueParameterEvent(
    const plugin_host::ParameterEvent& event) noexcept {
    if (event.parameterIndex == -1 || event.parameterIndex < -2
        || !std::isfinite(event.normalizedValue)
        || event.normalizedValue < 0.0f || event.normalizedValue > 1.0f)
        return false;
    auto* area = sharedMemory.area();
    if (area == nullptr || area->hostState.load(std::memory_order_acquire)
            != static_cast<uint32_t>(plugin_host::HostState::Ready))
        return false;
    const bool enqueued = plugin_host::tryEnqueueControl(*area, event);
    if (enqueued)
        (void)sharedMemory.signalWake();
    return enqueued;
}

bool PluginHostProcess::requestStateSnapshot() noexcept {
    return requestCommand(plugin_host::HostCommand::CaptureStates, 0,
                          std::chrono::seconds(5));
}

bool PluginHostProcess::requestOpenEditor(uint32_t slotIndex) noexcept {
    return requestCommand(plugin_host::HostCommand::OpenEditor, slotIndex,
                          std::chrono::seconds(3));
}

bool PluginHostProcess::requestCloseEditor(uint32_t slotIndex) noexcept {
    return requestCommand(plugin_host::HostCommand::CloseEditor, slotIndex,
                          std::chrono::seconds(3));
}

bool PluginHostProcess::requestCloseAllEditors() noexcept {
    return requestCommand(plugin_host::HostCommand::CloseAllEditors, 0,
                          std::chrono::seconds(3));
}

bool PluginHostProcess::requestCommand(
    plugin_host::HostCommand command, uint32_t slotIndex,
    std::chrono::milliseconds timeout) noexcept {
    std::lock_guard lock(commandMutex);
    auto* area = sharedMemory.area();
    if (area == nullptr || !isRunning() || !isReady())
        return false;
    if (area->commandRequest.load(std::memory_order_acquire)
        != area->commandComplete.load(std::memory_order_acquire))
        return false;
    const uint64_t request = area->commandRequest.load(std::memory_order_relaxed) + 1;
    area->commandResult.store(0, std::memory_order_relaxed);
    area->commandSlotIndex.store(slotIndex, std::memory_order_relaxed);
    area->command.store(static_cast<uint32_t>(command), std::memory_order_relaxed);
    area->commandRequest.store(request, std::memory_order_release);
    if (!sharedMemory.signalWake())
        return false;

    const auto deadline = std::chrono::steady_clock::now()
        + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        if (area->commandComplete.load(std::memory_order_acquire) == request)
            return area->commandResult.load(std::memory_order_acquire) == 1;
        if (!isRunning())
            return false;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return false;
}

void PluginHostProcess::drainCompletedOutputs(
    plugin_host::SharedArea& area, uint64_t beforeSequence) noexcept {
    // At most the three shared slots can be retired per callback. Sequence
    // gaps are skipped in a bounded loop; callback cost cannot grow with a
    // child that has been stalled for minutes.
    for (size_t attempt = 0; attempt < plugin_host::kSlotCount
         && nextOutputSequence < beforeSequence; ++attempt) {
        plugin_host::AudioSlot* completed = nullptr;
        bool expectedSequenceStillOwned = false;
        for (auto& slot : area.slots) {
            const auto state = static_cast<plugin_host::SlotState>(
                slot.state.load(std::memory_order_acquire));
            if (slot.sequence != nextOutputSequence
                || state == plugin_host::SlotState::Empty)
                continue;
            expectedSequenceStillOwned = true;
            if (state == plugin_host::SlotState::Complete)
                completed = &slot;
            break;
        }
        if (completed == nullptr) {
            if (expectedSequenceStillOwned)
                break;
            ++nextOutputSequence;
            continue;
        }

        const uint32_t samples = completed->numSamples;
        if (samples > 0 && samples <= plugin_host::kMaximumBlockSamples) {
            const size_t overflow = outputFifoSize + samples > outputFifoCapacity
                ? outputFifoSize + samples - outputFifoCapacity : 0;
            if (overflow != 0) {
                outputFifoRead = (outputFifoRead + overflow) % outputFifoCapacity;
                outputFifoSize -= overflow;
                missedOutputBlockCount.fetch_add(1, std::memory_order_relaxed);
            }
            const size_t first = std::min<size_t>(
                samples, outputFifoCapacity - outputFifoWrite);
            std::memcpy(outputFifoLeft.data() + outputFifoWrite,
                        completed->output.data(), first * sizeof(float));
            std::memcpy(outputFifoRight.data() + outputFifoWrite,
                        completed->output.data() + maximumBlockSize,
                        first * sizeof(float));
            const size_t second = samples - first;
            if (second != 0) {
                std::memcpy(outputFifoLeft.data(),
                            completed->output.data() + first,
                            second * sizeof(float));
                std::memcpy(outputFifoRight.data(),
                            completed->output.data() + maximumBlockSize + first,
                            second * sizeof(float));
            }
            outputFifoWrite = (outputFifoWrite + samples) % outputFifoCapacity;
            outputFifoSize += samples;
            // Never let a late helper turn one short stall into unbounded
            // monitoring/playback delay. Keep at most one declared host quantum.
            if (outputFifoSize > maximumBlockSize) {
                const size_t excess = outputFifoSize - maximumBlockSize;
                outputFifoRead = (outputFifoRead + excess) % outputFifoCapacity;
                outputFifoSize -= excess;
                missedOutputBlockCount.fetch_add(1, std::memory_order_relaxed);
            }
        } else {
            missedOutputBlockCount.fetch_add(1, std::memory_order_relaxed);
        }
        plugin_host::releaseOutput(*completed);
        ++nextOutputSequence;
    }
}

bool PluginHostProcess::processBlock(
    float* left, float* right, uint32_t numSamples,
    const plugin_host::MidiEvent* midiEvents, uint32_t midiEventCount,
    const plugin_host::ParameterEvent* parameterEvents,
    uint32_t parameterEventCount,
    const plugin_host::TransportSnapshot& transport,
    bool muteOnMiss) noexcept {
    auto* area = sharedMemory.area();
    if (area == nullptr || left == nullptr || right == nullptr
        || numSamples == 0 || numSamples > maximumBlockSize
        || numSamples > plugin_host::kMaximumBlockSamples) {
        if (muteOnMiss && left != nullptr && right != nullptr) {
            std::fill(left, left + numSamples, 0.0f);
            std::fill(right, right + numSamples, 0.0f);
        }
        missedInputBlockCount.fetch_add(1, std::memory_order_relaxed);
        return false;
    }

    const uint64_t inputSequence = nextSequence;
    if (area->hostState.load(std::memory_order_acquire)
            == static_cast<uint32_t>(plugin_host::HostState::Ready)) {
        drainCompletedOutputs(*area, inputSequence);
    } else {
        // Failed means the helper is already gone (or never became ready), so
        // its abandoned ownership states may be safely reclaimed in this new
        // terminal generation. Never repair a slot while vendor code can run.
        for (auto& slot : area->slots)
            slot.state.store(static_cast<uint32_t>(plugin_host::SlotState::Empty),
                             std::memory_order_release);
        nextOutputSequence = inputSequence;
        outputFifoRead = outputFifoWrite = outputFifoSize = 0;
    }

    const bool eventCountsValid =
        midiEventCount <= plugin_host::kMaximumMidiEventsPerBlock
        && parameterEventCount <= plugin_host::kMaximumParameterEventsPerBlock
        && (midiEventCount == 0 || midiEvents != nullptr)
        && (parameterEventCount == 0 || parameterEvents != nullptr);

    bool inputPublished = false;
    if (eventCountsValid && area->hostState.load(std::memory_order_acquire)
            == static_cast<uint32_t>(plugin_host::HostState::Ready)) {
        plugin_host::AudioSlot* input =
            plugin_host::tryBeginWrite(*area, inputSequence);
        if (input != nullptr) {
            input->transport = transport;
            if (midiEventCount != 0)
                std::copy_n(midiEvents, midiEventCount,
                            input->midiEvents.data());
            uint32_t totalParameterEvents = parameterEventCount;
            if (parameterEventCount != 0)
                std::copy_n(parameterEvents, parameterEventCount,
                             input->parameterEvents.data());
            const size_t count = static_cast<size_t>(numSamples);
            std::copy_n(left, count, input->input.data());
            std::copy_n(right, count,
                        input->input.data() + maximumBlockSize);
            inputPublished = plugin_host::publishInput(
                *input, numSamples, midiEventCount, totalParameterEvents);
            if (inputPublished)
                inputPublished = sharedMemory.signalWake();
            if (!inputPublished) {
                missedInputBlockCount.fetch_add(1, std::memory_order_relaxed);
                area->missedInputBlocks.fetch_add(1, std::memory_order_relaxed);
            }
        } else {
            missedInputBlockCount.fetch_add(1, std::memory_order_relaxed);
            area->missedInputBlocks.fetch_add(1, std::memory_order_relaxed);
        }
    } else {
        missedInputBlockCount.fetch_add(1, std::memory_order_relaxed);
        area->missedInputBlocks.fetch_add(1, std::memory_order_relaxed);
    }

    const bool outputAvailable = outputFifoSize >= numSamples;
    if (outputAvailable) {
        const size_t first = std::min<size_t>(
            numSamples, outputFifoCapacity - outputFifoRead);
        std::memcpy(left, outputFifoLeft.data() + outputFifoRead,
                    first * sizeof(float));
        std::memcpy(right, outputFifoRight.data() + outputFifoRead,
                    first * sizeof(float));
        const size_t second = numSamples - first;
        if (second != 0) {
            std::memcpy(left + first, outputFifoLeft.data(),
                        second * sizeof(float));
            std::memcpy(right + first, outputFifoRight.data(),
                        second * sizeof(float));
        }
        outputFifoRead = (outputFifoRead + numSamples) % outputFifoCapacity;
        outputFifoSize -= numSamples;
    } else {
        if (muteOnMiss) {
            std::fill(left, left + numSamples, 0.0f);
            std::fill(right, right + numSamples, 0.0f);
        }
        if (inputSequence != 0) {
            missedOutputBlockCount.fetch_add(1, std::memory_order_relaxed);
            area->missedOutputBlocks.fetch_add(1, std::memory_order_relaxed);
        }
    }

    ++nextSequence;
    return outputAvailable;
}

void PluginHostProcess::supervise() noexcept {
    using Clock = std::chrono::steady_clock;
    uint64_t previousHeartbeat = 0;
    uint64_t observedCommand = 0;
    auto lastProgress = Clock::now();
    auto commandStarted = Clock::now();
    while (!stopSupervisor.load(std::memory_order_acquire)) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        if (stopSupervisor.load(std::memory_order_acquire))
            break;
        auto* area = sharedMemory.area();
        if (area == nullptr || process == nullptr)
            break;
        const auto state = area->hostState.load(std::memory_order_acquire);
        if (state == static_cast<uint32_t>(plugin_host::HostState::Stopping))
            break;
        if (!process->isRunning()) {
            area->hostState.store(
                static_cast<uint32_t>(plugin_host::HostState::Failed),
                std::memory_order_release);
            processAlive.store(false, std::memory_order_release);
            break;
        }

        bool outstanding = area->commandRequest.load(std::memory_order_acquire)
            != area->commandComplete.load(std::memory_order_acquire);
        for (const auto& slot : area->slots) {
            const auto slotState = slot.state.load(std::memory_order_acquire);
            if (slotState == static_cast<uint32_t>(plugin_host::SlotState::Ready)
                || slotState == static_cast<uint32_t>(plugin_host::SlotState::Processing)) {
                outstanding = true;
                break;
            }
        }
        const uint64_t heartbeat = area->heartbeat.load(std::memory_order_acquire);
        const uint64_t commandRequest =
            area->commandRequest.load(std::memory_order_acquire);
        const uint64_t commandComplete =
            area->commandComplete.load(std::memory_order_acquire);
        if (commandRequest != commandComplete) {
            outstanding = true;
            if (commandRequest != observedCommand) {
                observedCommand = commandRequest;
                commandStarted = Clock::now();
            } else if (Clock::now() - commandStarted > std::chrono::seconds(15)) {
                area->hostState.store(
                    static_cast<uint32_t>(plugin_host::HostState::Failed),
                    std::memory_order_release);
                if (process->isRunning())
                    process->kill();
                processAlive.store(false, std::memory_order_release);
                break;
            }
        } else {
            observedCommand = commandRequest;
        }
        if (heartbeat != previousHeartbeat) {
            previousHeartbeat = heartbeat;
            lastProgress = Clock::now();
        } else if (!outstanding) {
            lastProgress = Clock::now();
        } else {
            const auto timeout = outstanding
                && area->commandRequest.load(std::memory_order_relaxed)
                    != area->commandComplete.load(std::memory_order_relaxed)
                ? std::chrono::seconds(6) : std::chrono::milliseconds(300);
            if (Clock::now() - lastProgress <= timeout)
                continue;
            // A plug-in can hang indefinitely in native code. Kill only the
            // isolated helper; Core's callback has already been emitting
            // bounded silence for missed responses.
            area->hostState.store(
                static_cast<uint32_t>(plugin_host::HostState::Failed),
                std::memory_order_release);
            if (process->isRunning())
                process->kill();
            processAlive.store(false, std::memory_order_release);
            break;
        }
    }
}

} // namespace resostage
