#include "PluginHostSharedMemory.h"

#include <cerrno>
#include <chrono>
#include <cstring>
#include <new>
#include <thread>
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
#include <time.h>
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

} // namespace

struct PluginHostSharedMemory::Impl {
    std::string mappingName;
    bool owner = false;
    plugin_host::SharedArea* shared = nullptr;

#if defined(_WIN32)
    HANDLE mapping = nullptr;
    HANDLE wakeEvent = nullptr;
#else
    int descriptor = -1;
    sem_t* wakeSemaphore = SEM_FAILED;
#if defined(__APPLE__)
    std::chrono::steady_clock::time_point hotWakeUntil{};
#endif
#endif

    void close() noexcept {
#if defined(_WIN32)
        if (wakeEvent != nullptr) {
            CloseHandle(wakeEvent);
            wakeEvent = nullptr;
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
    if (impl->shared == nullptr || impl->wakeEvent == nullptr
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
    if (name.size() > 30 || wakeName(name).size() > 30) {
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
    if (impl->shared == nullptr || impl->wakeEvent == nullptr) {
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
    if (name.size() > 30 || wakeName(name).size() > 30) {
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

bool PluginHostSharedMemory::signalWake() noexcept {
#if defined(_WIN32)
    return impl->wakeEvent != nullptr && SetEvent(impl->wakeEvent) != 0;
#else
    return impl->wakeSemaphore != SEM_FAILED && sem_post(impl->wakeSemaphore) == 0;
#endif
}

bool PluginHostSharedMemory::waitForWake(uint32_t timeoutMilliseconds) noexcept {
#if defined(_WIN32)
    if (impl->wakeEvent == nullptr)
        return false;
    return WaitForSingleObject(impl->wakeEvent, timeoutMilliseconds) == WAIT_OBJECT_0;
#else
    if (impl->wakeSemaphore == SEM_FAILED)
        return false;
#if defined(__APPLE__)
    // Darwin does not expose sem_timedwait for named POSIX semaphores. The
    // semaphore remains the primary wake path. In idle, poll at a low rate so
    // each isolated chain does not burn CPU; after a wake, poll more quickly
    // for a short window because real-time audio blocks keep arriving. That
    // avoids paying a full millisecond of wake latency at small device buffers.
    const auto deadline = std::chrono::steady_clock::now()
        + std::chrono::milliseconds(timeoutMilliseconds);
    do {
        if (sem_trywait(impl->wakeSemaphore) == 0)
        {
            impl->hotWakeUntil = std::chrono::steady_clock::now()
                + std::chrono::milliseconds(40);
            return true;
        }
        if (errno == EINTR)
            continue;
        const auto now = std::chrono::steady_clock::now();
        if (errno != EAGAIN || now >= deadline)
            return false;
        const auto pollInterval = now < impl->hotWakeUntil
            ? std::chrono::microseconds(250)
            : std::chrono::milliseconds(1);
        std::this_thread::sleep_for(std::min(
            pollInterval,
            std::chrono::duration_cast<decltype(pollInterval)>(deadline - now)));
    } while (true);
#else
    struct timespec deadline {};
    if (clock_gettime(CLOCK_REALTIME, &deadline) != 0)
        return false;
    deadline.tv_sec += static_cast<time_t>(timeoutMilliseconds / 1000);
    deadline.tv_nsec += static_cast<long>((timeoutMilliseconds % 1000) * 1000000);
    if (deadline.tv_nsec >= 1000000000L) {
        ++deadline.tv_sec;
        deadline.tv_nsec -= 1000000000L;
    }
    int result;
    do {
        result = sem_timedwait(impl->wakeSemaphore, &deadline);
    } while (result != 0 && errno == EINTR);
    return result == 0;
#endif
#endif
}

} // namespace resostage
