/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "PluginHostSharedMemory.h"
#include "PluginHostRuntime.h"

#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <chrono>
#include <iostream>
#include <limits>
#include <string>
#include <thread>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <cerrno>
#include <signal.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <pthread.h>
#include <pthread/qos.h>
#endif
#endif

namespace {

void prioritizePluginAudioWorker() noexcept {
#if defined(__APPLE__)
    // Elevate helper DSP to USER_INTERACTIVE so Darwin schedules it on Performance (P)
    // cores rather than demoting to Efficiency (E) cores during heavy live playback.
    (void)pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
#elif defined(_WIN32)
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
#elif defined(__unix__)
    struct sched_param param{};
    param.sched_priority = 50;
    (void)pthread_setschedparam(pthread_self(), SCHED_RR, &param);
#endif
}

juce::String argumentValue(const juce::StringArray& arguments,
                           const juce::String& name) {
    const int index = arguments.indexOf(name);
    return index >= 0 && index + 1 < arguments.size()
        ? arguments[index + 1] : juce::String{};
}

bool parseUnsigned(const juce::String& value, uint64_t& out) {
    const std::string text = value.toStdString();
    if (text.empty())
        return false;
    uint64_t parsed = 0;
    const auto result = std::from_chars(text.data(), text.data() + text.size(), parsed);
    if (result.ec != std::errc{} || result.ptr != text.data() + text.size())
        return false;
    out = parsed;
    return true;
}

bool parentAlive(uint64_t parentProcessId) noexcept {
#if defined(_WIN32)
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE,
                                static_cast<DWORD>(parentProcessId));
    if (parent == nullptr)
        return false;
    const bool alive = WaitForSingleObject(parent, 0) == WAIT_TIMEOUT;
    CloseHandle(parent);
    return alive;
#else
    if (parentProcessId == 0
        || parentProcessId > static_cast<uint64_t>(std::numeric_limits<pid_t>::max()))
        return false;
    if (::kill(static_cast<pid_t>(parentProcessId), 0) == 0)
        return true;
    return errno == EPERM;
#endif
}

uint64_t observedParentProcessId() noexcept {
#if defined(_WIN32)
    return 0;
#else
    return static_cast<uint64_t>(getppid());
#endif
}

void armParentDeathWatchdog(uint64_t parentProcessId) {
    std::thread([parentProcessId] {
        for (;;) {
            std::this_thread::sleep_for(std::chrono::milliseconds(250));
            if (!parentAlive(parentProcessId)) {
                std::cerr << "live plug-in host parent-watch ended: owner="
                          << parentProcessId << " ppid="
                          << observedParentProcessId() << '\n';
                std::_Exit(0);
            }
        }
    }).detach();
}

bool validFrame(const resostage::plugin_host::AudioSlot& slot,
                uint32_t maximumBlockSamples) noexcept {
    if (slot.numSamples == 0 || slot.numSamples > maximumBlockSamples
        || slot.midiEventCount > resostage::plugin_host::kMaximumMidiEventsPerBlock
        || slot.parameterEventCount
            > resostage::plugin_host::kMaximumParameterEventsPerBlock)
        return false;
    for (uint32_t i = 0; i < slot.midiEventCount; ++i) {
        const auto& event = slot.midiEvents[i];
        if (event.size == 0 || event.size > resostage::plugin_host::kMaximumMidiEventBytes
            || event.sampleOffset >= slot.numSamples)
            return false;
    }
    for (uint32_t i = 0; i < slot.parameterEventCount; ++i) {
        const auto& event = slot.parameterEvents[i];
        if (event.parameterIndex == -1 || event.parameterIndex < -2
            || !std::isfinite(event.normalizedValue)
            || event.normalizedValue < 0.0f || event.normalizedValue > 1.0f)
            return false;
        if (event.parameterIndex == -2
            && event.normalizedValue != 0.0f
            && event.normalizedValue != 1.0f)
            return false;
    }
    return true;
}

class MainThreadControlTimer final : private juce::Timer {
public:
    MainThreadControlTimer(resostage::plugin_host::SharedArea& sharedArea,
                           resostage::PluginHostRuntime* pluginRuntime,
                           uint64_t parentPid)
        : area(sharedArea), runtime(pluginRuntime), parentProcessId(parentPid) {}

    void start() { startTimer(kActiveIntervalMs); }

    void triggerImmediateEvaluation() {
        if (juce::MessageManager::getInstance()->isThisTheMessageThread())
            timerCallback();
    }

private:
    static constexpr int kActiveIntervalMs = 8;
    static constexpr int kIdleIntervalMs = 50;

    void timerCallback() override {
        if (area.hostState.load(std::memory_order_acquire)
            == static_cast<uint32_t>(resostage::plugin_host::HostState::Stopping)) {
            juce::JUCEApplicationBase::quit();
            return;
        }

        const auto now = std::chrono::steady_clock::now();
        if (now - lastParentCheck >= std::chrono::milliseconds(250)) {
            lastParentCheck = now;
            if (!parentAlive(parentProcessId)) {
                area.hostState.store(
                    static_cast<uint32_t>(resostage::plugin_host::HostState::Stopping),
                    std::memory_order_release);
                juce::JUCEApplicationBase::quit();
                return;
            }
        }

        if (runtime != nullptr) {
            if (runtime->consumeStateChange())
                area.stateChangeCounter.fetch_add(1, std::memory_order_release);
            if (runtime->consumeLatencyChange()) {
                area.processorLatencySamples.store(static_cast<uint32_t>(
                    std::max(0, runtime->processorLatencySamples())),
                    std::memory_order_release);
                area.latencyChangeCounter.fetch_add(1, std::memory_order_release);
            }
        }

        const uint64_t request =
            area.commandRequest.load(std::memory_order_acquire);
        const bool commandPending = (request != area.commandComplete.load(std::memory_order_acquire));

        if (commandPending) {
            const auto command = static_cast<resostage::plugin_host::HostCommand>(
                area.command.load(std::memory_order_acquire));
            const uint32_t slotIndex =
                area.commandSlotIndex.load(std::memory_order_relaxed);
            bool succeeded = false;
            if (runtime != nullptr) {
                if (command == resostage::plugin_host::HostCommand::OpenEditor)
                    succeeded = runtime->openEditor(slotIndex);
                else if (command == resostage::plugin_host::HostCommand::CloseEditor)
                    succeeded = runtime->closeEditor(slotIndex);
                else if (command == resostage::plugin_host::HostCommand::CloseAllEditors) {
                    runtime->closeAllEditors();
                    succeeded = true;
                }
            }

            if (command == resostage::plugin_host::HostCommand::OpenEditor
                || command == resostage::plugin_host::HostCommand::CloseEditor
                || command == resostage::plugin_host::HostCommand::CloseAllEditors) {
                area.commandResult.store(succeeded ? 1u : 0u,
                                         std::memory_order_relaxed);
                area.commandComplete.store(request, std::memory_order_release);
                area.command.store(
                    static_cast<uint32_t>(resostage::plugin_host::HostCommand::None),
                    std::memory_order_release);
            }
        }

        // Adaptive polling: when an editor is visible or a command was just processed,
        // run at 8 ms for responsive UI and parameter tracking. When completely idle,
        // relax to 50 ms to eliminate unnecessary wakeups and background CPU draw.
        const bool active = (runtime != nullptr && runtime->hasVisibleEditors()) || commandPending;
        const int targetInterval = active ? kActiveIntervalMs : kIdleIntervalMs;
        if (getTimerInterval() != targetInterval)
            startTimer(targetInterval);
    }

    resostage::plugin_host::SharedArea& area;
    resostage::PluginHostRuntime* runtime;
    uint64_t parentProcessId;
    std::chrono::steady_clock::time_point lastParentCheck =
        std::chrono::steady_clock::now();
};

} // namespace

class PluginHostApplication final : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "ResoStage Plug-in Host"; }
    const juce::String getApplicationVersion() override { return "1"; }
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise(const juce::String&) override {
        const auto arguments = juce::JUCEApplicationBase::getCommandLineParameterArray();
        const juce::String sharedName = argumentValue(arguments, "--shared-memory");
        const juce::String projectDirectory = argumentValue(arguments, "--project-directory");
        const juce::String registryPath = argumentValue(arguments, "--registry");
        uint64_t generation = 0;
        uint64_t blockSizeArg = 0;
        const double sampleRate =
            argumentValue(arguments, "--sample-rate").getDoubleValue();
        if (sharedName.isEmpty()
            || !parseUnsigned(argumentValue(arguments, "--generation"), generation)
            || !parseUnsigned(argumentValue(arguments, "--block-size"), blockSizeArg)
            || blockSizeArg == 0
            || blockSizeArg > resostage::plugin_host::kMaximumBlockSamples
            || !std::isfinite(sampleRate) || sampleRate <= 0.0) {
            fail(2, "invalid live plug-in host launch arguments");
            return;
        }

        std::string error;
        const auto blockSize = static_cast<uint32_t>(blockSizeArg);
        if (!sharedMemory.open(sharedName.toStdString(), generation, blockSize,
                               error, sampleRate)) {
            fail(3, error);
            return;
        }
        auto* area = sharedMemory.area();
        parentProcessId = area->ownerProcessId;
        if (parentProcessId == 0 || !parentAlive(parentProcessId)) {
            fail(4, "live plug-in host could not verify its Core parent");
            return;
        }
        armParentDeathWatchdog(parentProcessId);

        if (projectDirectory.isNotEmpty() && registryPath.isNotEmpty()) {
            std::atomic<bool> initDone{false};
            std::thread initWatchdog([area, &initDone] {
                const auto deadline = std::chrono::steady_clock::now()
                    + std::chrono::seconds(25);
                while (std::chrono::steady_clock::now() < deadline) {
                    if (initDone.load(std::memory_order_acquire))
                        return;
                    std::this_thread::sleep_for(std::chrono::milliseconds(200));
                }
                if (!initDone.load(std::memory_order_acquire)) {
                    const char msg[] = "Plug-in initialization timed out (modal dialog or authorization freeze)";
                    if (area != nullptr) {
                        juce::String::fromUTF8(msg).copyToUTF8(
                            area->startupError.data(), area->startupError.size());
                        area->commandResult.store(5, std::memory_order_relaxed);
                        area->hostState.store(
                            static_cast<uint32_t>(resostage::plugin_host::HostState::Failed),
                            std::memory_order_release);
                    }
                    std::cerr << msg << '\n';
                    std::_Exit(5);
                }
            });

            runtime = std::make_unique<resostage::PluginHostRuntime>();
            bool prepared = false;
            try {
                prepared = runtime->prepare(
                    juce::File(projectDirectory), juce::File(registryPath),
                    sampleRate, static_cast<int>(blockSize),
                    &area->activePluginIndex, error);
            } catch (const std::exception& e) {
                error = e.what();
                prepared = false;
            } catch (...) {
                error = "Unknown exception during plug-in host runtime preparation";
                prepared = false;
            }
            initDone.store(true, std::memory_order_release);
            if (initWatchdog.joinable())
                initWatchdog.join();

            if (!prepared) {
                fail(5, error);
                return;
            }
            area->processorLatencySamples.store(static_cast<uint32_t>(
                std::max(0, runtime->processorLatencySamples())),
                std::memory_order_relaxed);
            area->processorTailSeconds = runtime->bank()->tailSeconds();
            runtime->publishSlotStatuses(*area);
            runtime->publishParameterDescriptors(*area);
        }

        area->hostState.store(
            static_cast<uint32_t>(resostage::plugin_host::HostState::Ready),
            std::memory_order_release);
        ready = true;

        commandWorker = std::thread([this, area] { runCommandWorker(*area); });
        audioWorker = std::thread([this, area, blockSize] {
            runAudioWorker(*area, blockSize);
        });
        controlTimer = std::make_unique<MainThreadControlTimer>(
            *area, runtime.get(), parentProcessId);
        controlTimer->start();
    }

    void shutdown() override {
        auto* area = sharedMemory.area();
        if (ready && area != nullptr) {
            area->hostState.store(
                static_cast<uint32_t>(resostage::plugin_host::HostState::Stopping),
                std::memory_order_release);
            (void)sharedMemory.signalWake();
        }
        stopAudioWorker.store(true, std::memory_order_release);
        if (audioWorker.joinable())
            audioWorker.join();
        stopCommandWorker.store(true, std::memory_order_release);
        (void)sharedMemory.signalControlWake();
        if (commandWorker.joinable())
            commandWorker.join();
        controlTimer.reset();
        if (runtime != nullptr) {
            runtime->closeAllEditors();
            runtime.reset();
        }
        sharedMemory = resostage::PluginHostSharedMemory{};
    }

    void anotherInstanceStarted(const juce::String&) override {}
    void systemRequestedQuit() override { quit(); }

private:
    void fail(int code, const std::string& message) {
        std::cerr << message << '\n';
        if (auto* area = sharedMemory.area()) {
            juce::String::fromUTF8(message.c_str()).copyToUTF8(
                area->startupError.data(), area->startupError.size());
            area->commandResult.store(static_cast<uint32_t>(code),
                                      std::memory_order_relaxed);
            area->hostState.store(
                static_cast<uint32_t>(resostage::plugin_host::HostState::Failed),
                std::memory_order_release);
        }
        setApplicationReturnValue(code);
        quit();
    }

    void runCommandWorker(resostage::plugin_host::SharedArea& area) {
        uint64_t lastRequest = 0;
        while (!stopCommandWorker.load(std::memory_order_acquire)) {
            if (area.hostState.load(std::memory_order_acquire)
                != static_cast<uint32_t>(resostage::plugin_host::HostState::Ready))
                break;
            (void)sharedMemory.waitForControlWake();
            if (stopCommandWorker.load(std::memory_order_acquire)
                || area.hostState.load(std::memory_order_acquire)
                    != static_cast<uint32_t>(resostage::plugin_host::HostState::Ready))
                break;

            resostage::plugin_host::ParameterEvent controlEvent;
            for (unsigned i = 0; i < resostage::plugin_host::kControlEventQueueCapacity
                 && resostage::plugin_host::tryDequeueControl(area, controlEvent);
                 ++i) {
                if (runtime != nullptr)
                    runtime->applyControlEvent(controlEvent);
            }
            const uint64_t request =
                area.commandRequest.load(std::memory_order_acquire);
            const auto command = static_cast<resostage::plugin_host::HostCommand>(
                area.command.load(std::memory_order_acquire));
            if (request != lastRequest
                && request != area.commandComplete.load(std::memory_order_acquire)) {
                if (command == resostage::plugin_host::HostCommand::CaptureStates) {
                    lastRequest = request;
                    std::string commandError;
                    const bool succeeded = runtime != nullptr
                        && runtime->captureStateFiles(commandError);
                    if (!commandError.empty())
                        std::cerr << commandError << '\n';
                    area.commandResult.store(succeeded ? 1u : 0u,
                                             std::memory_order_relaxed);
                    area.commandComplete.store(request, std::memory_order_release);
                    area.command.store(
                        static_cast<uint32_t>(resostage::plugin_host::HostCommand::None),
                        std::memory_order_release);
                } else if (command == resostage::plugin_host::HostCommand::OpenEditor
                           || command == resostage::plugin_host::HostCommand::CloseEditor
                           || command == resostage::plugin_host::HostCommand::CloseAllEditors) {
                    lastRequest = request;
                    juce::MessageManager::callAsync([this]() {
                        if (controlTimer != nullptr) {
                            controlTimer->triggerImmediateEvaluation();
                        }
                    });
                }
            }
        }
    }

    void runAudioWorker(resostage::plugin_host::SharedArea& area,
                        uint32_t blockSize) {
        prioritizePluginAudioWorker();
        uint64_t nextSequence = 0;
        while (!stopAudioWorker.load(std::memory_order_acquire)) {
            if (area.hostState.load(std::memory_order_acquire)
                != static_cast<uint32_t>(resostage::plugin_host::HostState::Ready))
                break;
            (void)sharedMemory.waitForWake();
            // The independent parent watchdog also covers idle/blocked DSP.
            // Do not repeat process-handle/syscall work on every audio wake.

            while (area.hostState.load(std::memory_order_acquire)
                       == static_cast<uint32_t>(resostage::plugin_host::HostState::Ready)) {
                auto* slot = resostage::plugin_host::tryBeginNextProcess(
                    area, nextSequence);
                if (slot == nullptr)
                    break;
                area.activePluginIndex.store(
                    std::numeric_limits<uint32_t>::max(), std::memory_order_release);

                if (!validFrame(*slot, blockSize)) {
                    std::fill_n(slot->output.data(), blockSize, 0.0f);
                    std::fill_n(slot->output.data() + blockSize,
                                blockSize, 0.0f);
                } else if (runtime != nullptr) {
                    runtime->applyPowerRequests(area);
                    if (!runtime->process(*slot)) {
                        std::fill_n(slot->output.data(), slot->numSamples, 0.0f);
                        std::fill_n(slot->output.data() + blockSize,
                                    slot->numSamples, 0.0f);
                    }
                    runtime->publishPowerStates(area);
                } else {
                    std::copy_n(slot->input.data(), slot->numSamples,
                                slot->output.data());
                    std::copy_n(slot->input.data() + blockSize, slot->numSamples,
                                slot->output.data() + blockSize);
                }
                area.heartbeat.fetch_add(1, std::memory_order_release);
                resostage::plugin_host::publishOutput(*slot);
            }
        }
    }

    resostage::PluginHostSharedMemory sharedMemory;
    std::unique_ptr<resostage::PluginHostRuntime> runtime;
    std::unique_ptr<MainThreadControlTimer> controlTimer;
    std::thread commandWorker;
    std::thread audioWorker;
    std::atomic<bool> stopCommandWorker{false};
    std::atomic<bool> stopAudioWorker{false};
    uint64_t parentProcessId = 0;
    bool ready = false;
};

static juce::JUCEApplicationBase* createPluginHostApplication() {
    return new PluginHostApplication();
}

int main(int argc, char** argv) {
    juce::JUCEApplicationBase::createInstance = &createPluginHostApplication;
    return juce::JUCEApplicationBase::main(argc,
        const_cast<const char**>(argv));
}
