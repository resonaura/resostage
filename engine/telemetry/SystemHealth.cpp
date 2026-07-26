#include "SystemHealth.h"

#include <mach/mach.h>
#include <mach/mach_host.h>
#include <mach/task_info.h>
#include <sys/sysctl.h>

#include <chrono>

namespace resoset {

namespace {

uint64_t systemTotalMemoryBytes() {
    int mib[2] = {CTL_HW, HW_MEMSIZE};
    uint64_t mem = 0;
    size_t len = sizeof(mem);
    if (sysctl(mib, 2, &mem, &len, nullptr, 0) != 0)
        return 0;
    return mem;
}

uint64_t systemFreeMemoryBytes() {
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    vm_statistics64_data_t vmstat{};
    if (host_statistics64(mach_host_self(), HOST_VM_INFO64,
                          reinterpret_cast<host_info64_t>(&vmstat), &count) != KERN_SUCCESS)
        return 0;

    const uint64_t pageSize = static_cast<uint64_t>(vm_kernel_page_size);
    // free + inactive is the practical "available soon" pool for a live app.
    return (static_cast<uint64_t>(vmstat.free_count) + static_cast<uint64_t>(vmstat.inactive_count)) * pageSize;
}

uint64_t processRssBytes() {
    task_vm_info_data_t info{};
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    if (task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS)
        return 0;
    return static_cast<uint64_t>(info.phys_footprint);
}

// Returns cumulative user+system CPU time for this process, in nanoseconds.
uint64_t processCpuTimeNanos() {
    task_thread_times_info_data_t times{};
    mach_msg_type_number_t count = TASK_THREAD_TIMES_INFO_COUNT;
    if (task_info(mach_task_self(), TASK_THREAD_TIMES_INFO,
                  reinterpret_cast<task_info_t>(&times), &count) != KERN_SUCCESS)
        return 0;

    const uint64_t userNs = static_cast<uint64_t>(times.user_time.seconds) * 1'000'000'000ull
                          + static_cast<uint64_t>(times.user_time.microseconds) * 1000ull;
    const uint64_t sysNs = static_cast<uint64_t>(times.system_time.seconds) * 1'000'000'000ull
                         + static_cast<uint64_t>(times.system_time.microseconds) * 1000ull;
    return userNs + sysNs;
}

} // namespace

SystemHealthSnapshot SystemHealth::sample() const {
    SystemHealthSnapshot snap;
    snap.processRssBytes = processRssBytes();
    snap.systemFreeBytes = systemFreeMemoryBytes();
    snap.systemTotalBytes = systemTotalMemoryBytes();
    snap.underrunCount = underrunCount.load(std::memory_order_relaxed);
    snap.audioCallbackCount = audioCallbackCount.load(std::memory_order_relaxed);
    snap.webClientCount = webClientCount.load(std::memory_order_relaxed);

    const uint64_t cpuNow = processCpuTimeNanos();
    const auto wallNow = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count());
    if (lastWallNanos != 0 && wallNow > lastWallNanos && cpuNow >= lastCpuNanos) {
        const double dCpu = static_cast<double>(cpuNow - lastCpuNanos);
        const double dWall = static_cast<double>(wallNow - lastWallNanos);
        if (dWall > 0.0)
            snap.processCpuPercent = (dCpu / dWall) * 100.0;
    }
    lastCpuNanos = cpuNow;
    lastWallNanos = wallNow;

    return snap;
}

} // namespace resoset
