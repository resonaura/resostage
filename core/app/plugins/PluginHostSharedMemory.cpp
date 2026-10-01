/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "PluginHostSharedMemory.h"

#include <cerrno>
#include <cstring>
#include <new>
#include <utility>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <semaphore.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace resostage {
namespace {

std::string wakeName(const std::string& name) {
#if defined(_WIN32)
    return name + "-wake";
#else
    // POSIX shm/semaphore names have a short implementation-defined limit on
    // Darwin. Derive distinct, compact names from the same random identifier.
    const size_t separator = name.find('-');
    return "/rswe-" + (separator == std::string::npos
        ? name.substr(name.find_last_of('/') + 1)
        : name.substr(separator + 1));
#endif
}

std::string controlWakeName(const std::string& name) {
#if defined(_WIN32)
    return name + "-control";
#else
    const size_t separator = name.find('-');
    return "/rswc-" + (separator == std::string::npos
        ? name.substr(name.find_last_of('/') + 1)
        : name.substr(separator + 1));
#endif
}

} // namespace

struct PluginHostSharedMemory::Impl {
    std::string mappingName;
    bool owner = false;
    plugin_host::SharedArea* shared = nullptr;

#if defined(_WIN32)
    HANDLE mapping = nullptr;
    HANDLE wakeEvent = nullptr;
    HANDLE controlWakeEvent = nullptr;
#else
    int descriptor = -1;
    sem_t* wakeSemaphore = SEM_FAILED;
    sem_t* controlWakeSemaphore = SEM_FAILED;
#endif

    void close() noexcept {
#if defined(_WIN32)
        if (wakeEvent != nullptr) {
            CloseHandle(wakeEvent);
            wakeEvent = nullptr;
        }
        if (controlWakeEvent != nullptr) {
            CloseHandle(controlWakeEvent);
            controlWakeEvent = nullptr;
        }
        if (shared != nullptr) {
            UnmapViewOfFile(shared);
            shared = nullptr;
        }
        if (mapping != nullptr) {
            CloseHandle(mapping);
            mapping = nullptr;
        }
#else
        if (wakeSemaphore != SEM_FAILED) {
            sem_close(wakeSemaphore);
            wakeSemaphore = SEM_FAILED;
        }
        if (controlWakeSemaphore != SEM_FAILED) {
            sem_close(controlWakeSemaphore);
            controlWakeSemaphore = SEM_FAILED;
        }
        if (shared != nullptr) {
            munmap(shared, sizeof(plugin_host::SharedArea));
            shared = nullptr;
        }
        if (descriptor >= 0) {
            ::close(descriptor);
            descriptor = -1;
        }
        if (owner && !mappingName.empty()) {
            sem_unlink(wakeName(mappingName).c_str());
            sem_unlink(controlWakeName(mappingName).c_str());
            shm_unlink(mappingName.c_str());
        }
#endif
        owner = false;
        mappingName.clear();
    }

    ~Impl() { close(); }
};

PluginHostSharedMemory::PluginHostSharedMemory() : impl(std::make_unique<Impl>()) {}
PluginHostSharedMemory::~PluginHostSharedMemory() = default;
PluginHostSharedMemory::PluginHostSharedMemory(PluginHostSharedMemory&&) noexcept = default;
PluginHostSharedMemory& PluginHostSharedMemory::operator=(PluginHostSharedMemory&&) noexcept = default;

bool PluginHostSharedMemory::create(const std::string& name, uint64_t generation,
                                    uint32_t maximumBlockSamples,
                                    std::string& error, double sampleRate) {
    impl->close();
    if (name.empty() || maximumBlockSamples == 0
        || maximumBlockSamples > plugin_host::kMaximumBlockSamples
        || !std::isfinite(sampleRate) || sampleRate <= 0.0) {
        error = "Invalid plug-in host shared-memory parameters";
        return false;
    }

#if defined(_WIN32)
    impl->mappingName = name;
    SetLastError(ERROR_SUCCESS);
    impl->mapping = CreateFileMappingA(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
        0, static_cast<DWORD>(sizeof(plugin_host::SharedArea)), name.c_str());
    if (impl->mapping == nullptr || GetLastError() == ERROR_ALREADY_EXISTS) {
        error = "Could not create a unique plug-in host mapping";
        impl->close();
        return false;
    }
    impl->shared = static_cast<plugin_host::SharedArea*>(MapViewOfFile(
        impl->mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(plugin_host::SharedArea)));
    SetLastError(ERROR_SUCCESS);
    impl->wakeEvent = CreateEventA(nullptr, FALSE, FALSE, wakeName(name).c_str());
    impl->controlWakeEvent = CreateEventA(nullptr, FALSE, FALSE,
                                          controlWakeName(name).c_str());
    if (impl->shared == nullptr || impl->wakeEvent == nullptr
        || impl->controlWakeEvent == nullptr
        || GetLastError() == ERROR_ALREADY_EXISTS) {
        error = "Could not initialize plug-in host shared-memory handles";
        impl->close();
        return false;
    }
#else
    if (name.front() != '/') {
        error = "POSIX plug-in host mapping names must begin with '/'";
        return false;
    }
#if defined(__APPLE__)
    if (name.size() > 30 || wakeName(name).size() > 30
        || controlWakeName(name).size() > 30) {
        error = "macOS plug-in host shared-memory names must not exceed 30 bytes";
        return false;
    }
#endif
    impl->mappingName = name;
    impl->descriptor = shm_open(name.c_str(), O_CREAT | O_EXCL | O_RDWR, 0600);
    if (impl->descriptor < 0) {
        error = "Could not create plug-in host shared memory: "
                + std::string(std::strerror(errno));
        impl->mappingName.clear();
        return false;
    }
    impl->owner = true;
    if (ftruncate(impl->descriptor,
                  static_cast<off_t>(sizeof(plugin_host::SharedArea))) != 0) {
        error = "Could not size plug-in host shared memory: "
                + std::string(std::strerror(errno));
        impl->close();
        return false;
    }
    void* mapped = mmap(nullptr, sizeof(plugin_host::SharedArea),
                        PROT_READ | PROT_WRITE, MAP_SHARED, impl->descriptor, 0);
    if (mapped == MAP_FAILED) {
        error = "Could not map plug-in host shared memory: "
                + std::string(std::strerror(errno));
        impl->close();
        return false;
    }
    impl->shared = static_cast<plugin_host::SharedArea*>(mapped);
    impl->wakeSemaphore = sem_open(wakeName(name).c_str(), O_CREAT | O_EXCL,
                                   0600, 0);
    if (impl->wakeSemaphore == SEM_FAILED) {
        error = "Could not create plug-in host wake semaphore: "
                + std::string(std::strerror(errno));
        impl->close();
        return false;
    }
    impl->controlWakeSemaphore = sem_open(controlWakeName(name).c_str(),
        O_CREAT | O_EXCL, 0600, 0);
    if (impl->controlWakeSemaphore == SEM_FAILED) {
        error = "Could not create plug-in host control semaphore: "
                + std::string(std::strerror(errno));
        impl->close();
        return false;
    }
#endif

    new (impl->shared) plugin_host::SharedArea{};
    impl->shared->magic = plugin_host::kMagic;
    impl->shared->protocolVersion = plugin_host::kProtocolVersion;
    impl->shared->byteSize = static_cast<uint32_t>(sizeof(plugin_host::SharedArea));
    impl->shared->configuredMaximumBlock = maximumBlockSamples;
    impl->shared->configuredSampleRate = sampleRate;
    impl->shared->generation = generation;
#if defined(_WIN32)
    impl->shared->ownerProcessId = GetCurrentProcessId();
#else
    impl->shared->ownerProcessId = static_cast<uint64_t>(getpid());
#endif
    impl->shared->hostState.store(
        static_cast<uint32_t>(plugin_host::HostState::Initializing),
        std::memory_order_release);
    impl->owner = true;
    return true;
}

bool PluginHostSharedMemory::open(const std::string& name, uint64_t generation,
                                  uint32_t maximumBlockSamples,
                                  std::string& error, double sampleRate) {
    impl->close();
    if (name.empty() || maximumBlockSamples == 0
        || maximumBlockSamples > plugin_host::kMaximumBlockSamples
        || !std::isfinite(sampleRate) || sampleRate <= 0.0) {
        error = "Invalid plug-in host shared-memory parameters";
        return false;
    }
    impl->mappingName = name;

#if defined(_WIN32)
    impl->mapping = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, name.c_str());
    if (impl->mapping != nullptr) {
        impl->shared = static_cast<plugin_host::SharedArea*>(MapViewOfFile(
            impl->mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(plugin_host::SharedArea)));
    }
    impl->wakeEvent = OpenEventA(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE,
                                 wakeName(name).c_str());
    impl->controlWakeEvent = OpenEventA(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE,
                                        controlWakeName(name).c_str());
    if (impl->shared == nullptr || impl->wakeEvent == nullptr
        || impl->controlWakeEvent == nullptr) {
        error = "Could not open plug-in host shared-memory handles";
        impl->close();
        return false;
    }
#else
    if (name.front() != '/') {
        error = "POSIX plug-in host mapping names must begin with '/'";
        impl->mappingName.clear();
        return false;
    }
#if defined(__APPLE__)
    if (name.size() > 30 || wakeName(name).size() > 30
        || controlWakeName(name).size() > 30) {
        error = "macOS plug-in host shared-memory names must not exceed 30 bytes";
        impl->mappingName.clear();
        return false;
    }
#endif
    impl->descriptor = shm_open(name.c_str(), O_RDWR, 0600);
    if (impl->descriptor < 0) {
        error = "Could not open plug-in host shared memory: "
                + std::string(std::strerror(errno));
        impl->mappingName.clear();
        return false;
    }
    struct stat status {};
    if (fstat(impl->descriptor, &status) != 0
        || status.st_size < 0
        || static_cast<uintmax_t>(status.st_size)
            < sizeof(plugin_host::SharedArea)) {
        error = "Plug-in host shared-memory size does not match this protocol (got "
            + std::to_string(static_cast<uint64_t>(status.st_size)) + ", expected "
            + std::to_string(sizeof(plugin_host::SharedArea)) + ")";
        impl->close();
        return false;
    }
    void* mapped = mmap(nullptr, sizeof(plugin_host::SharedArea),
                        PROT_READ | PROT_WRITE, MAP_SHARED, impl->descriptor, 0);
    if (mapped == MAP_FAILED) {
        error = "Could not map plug-in host shared memory: "
                + std::string(std::strerror(errno));
        impl->close();
        return false;
    }
    impl->shared = static_cast<plugin_host::SharedArea*>(mapped);
    impl->wakeSemaphore = sem_open(wakeName(name).c_str(), 0);
    if (impl->wakeSemaphore == SEM_FAILED) {
        error = "Could not open plug-in host wake semaphore: "
                + std::string(std::strerror(errno));
        impl->close();
        return false;
    }
    impl->controlWakeSemaphore = sem_open(controlWakeName(name).c_str(), 0);
    if (impl->controlWakeSemaphore == SEM_FAILED) {
        error = "Could not open plug-in host control semaphore: "
                + std::string(std::strerror(errno));
        impl->close();
        return false;
    }
#endif

    if (!plugin_host::validate(*impl->shared, generation, maximumBlockSamples,
                               sampleRate)) {
        error = "Plug-in host shared-memory protocol or generation mismatch";
        impl->close();
        return false;
    }
    return true;
}

plugin_host::SharedArea* PluginHostSharedMemory::area() noexcept {
    return impl->shared;
}

const plugin_host::SharedArea* PluginHostSharedMemory::area() const noexcept {
    return impl->shared;
}

const std::string& PluginHostSharedMemory::name() const noexcept {
    return impl->mappingName;
}

bool PluginHostSharedMemory::isOwner() const noexcept {
    return impl->owner;
}

void PluginHostSharedMemory::unlinkNamespace() noexcept {
#if !defined(_WIN32)
    if (impl && impl->owner && !impl->mappingName.empty()) {
        sem_unlink(wakeName(impl->mappingName).c_str());
        sem_unlink(controlWakeName(impl->mappingName).c_str());
        shm_unlink(impl->mappingName.c_str());
        impl->mappingName.clear();
    }
#endif
}

bool PluginHostSharedMemory::signalWake() noexcept {
    if (impl->shared == nullptr)
        return false;
    uint32_t expected = 0;
    if (!impl->shared->wakePending.compare_exchange_strong(
            expected, 1, std::memory_order_acq_rel, std::memory_order_relaxed)) {
        return true; // a wake is already pending; the worker drains all slots
    }
#if defined(_WIN32)
    const bool signalled = impl->wakeEvent != nullptr && SetEvent(impl->wakeEvent) != 0;
#else
    const bool signalled = impl->wakeSemaphore != SEM_FAILED
        && sem_post(impl->wakeSemaphore) == 0;
#endif
    if (!signalled)
        impl->shared->wakePending.store(0, std::memory_order_release);
    return signalled;
}

bool PluginHostSharedMemory::waitForWake() noexcept {
#if defined(_WIN32)
    if (impl->wakeEvent == nullptr)
        return false;
    const bool signalled = WaitForSingleObject(impl->wakeEvent, INFINITE) == WAIT_OBJECT_0;
    if (signalled && impl->shared != nullptr)
        impl->shared->wakePending.store(0, std::memory_order_release);
    return signalled;
#else
    if (impl->wakeSemaphore == SEM_FAILED)
        return false;
    do {
        // Audio requests and shutdown both post this process-shared semaphore.
        // Blocking here avoids the old macOS 250-us polling loop, which spent
        // worker CPU while adding scheduler-dependent wake latency. Parent
        // death is handled by the independent helper watchdog.
        if (sem_wait(impl->wakeSemaphore) == 0) {
            if (impl->shared != nullptr)
                impl->shared->wakePending.store(0, std::memory_order_release);
            return true;
        }
    } while (true);
#endif
    return false;
}

bool PluginHostSharedMemory::signalControlWake() noexcept {
    if (impl->shared == nullptr)
        return false;
    uint32_t expected = 0;
    if (!impl->shared->controlWakePending.compare_exchange_strong(
            expected, 1, std::memory_order_acq_rel, std::memory_order_relaxed))
        return true;
#if defined(_WIN32)
    const bool signalled = impl->controlWakeEvent != nullptr
        && SetEvent(impl->controlWakeEvent) != 0;
#else
    const bool signalled = impl->controlWakeSemaphore != SEM_FAILED
        && sem_post(impl->controlWakeSemaphore) == 0;
#endif
    if (!signalled)
        impl->shared->controlWakePending.store(0, std::memory_order_release);
    return signalled;
}

bool PluginHostSharedMemory::waitForControlWake() noexcept {
#if defined(_WIN32)
    if (impl->controlWakeEvent == nullptr)
        return false;
    const bool signalled = WaitForSingleObject(impl->controlWakeEvent, INFINITE)
        == WAIT_OBJECT_0;
    if (signalled && impl->shared != nullptr)
        impl->shared->controlWakePending.store(0, std::memory_order_release);
    return signalled;
#else
    if (impl->controlWakeSemaphore == SEM_FAILED)
        return false;
    int result;
    do {
        result = sem_wait(impl->controlWakeSemaphore);
    } while (result != 0 && errno == EINTR);
    if (result != 0)
        return false;
    if (impl->shared != nullptr)
        impl->shared->controlWakePending.store(0, std::memory_order_release);
    return true;
#endif
}

} // namespace resostage
