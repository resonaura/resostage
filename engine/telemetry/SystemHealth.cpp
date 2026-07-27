#include "SystemHealth.h"

#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_host.h>
#include <mach/task_info.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <unistd.h>

#include <chrono>
#include <unordered_map>

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
    return (static_cast<uint64_t>(vmstat.free_count) + static_cast<uint64_t>(vmstat.inactive_count)) * pageSize;
}

uint64_t processRssBytes() {
    task_vm_info_data_t info{};
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    if (task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS)
        return 0;
    return static_cast<uint64_t>(info.phys_footprint);
}

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

// --- Child-process discovery via libproc ---

struct ProcMetrics {
    std::string name;
    uint64_t rssBytes = 0;
    uint64_t cpuTimeNanos = 0;
};

// Get RSS + CPU time for an arbitrary PID via proc_pidinfo.
// Returns false if the process no longer exists or can't be inspected.
bool getProcMetrics(int pid, ProcMetrics& out) {
    // CPU times
    struct proc_taskinfo pti{};
    int ret = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &pti, sizeof(pti));
    if (ret != sizeof(pti))
        return false;

    out.cpuTimeNanos = static_cast<uint64_t>(pti.pti_total_user)
                     + static_cast<uint64_t>(pti.pti_total_system);
    out.rssBytes = static_cast<uint64_t>(pti.pti_resident_size);

    // Process name
    char nameBuf[256]{};
    proc_name(pid, nameBuf, sizeof(nameBuf));
    out.name = nameBuf;

    return true;
}

// Discover PIDs whose parent is our main process.
// Refreshed every ~10 seconds to pick up any spawned helpers.
std::vector<int> discoverChildPids(int mainPid) {
    std::vector<int> children;
    // proc_listpids returns the number of PIDs actually written.
    constexpr int kMaxPids = 4096;
    int pidBuf[kMaxPids]{};
    int numPids = proc_listpids(PROC_ALL_PIDS, 0, pidBuf, sizeof(pidBuf));
    if (numPids <= 0)
        return children;

    const int count = numPids / sizeof(int);
    for (int i = 0; i < count; ++i) {
        const int pid = pidBuf[i];
        if (pid <= 0 || pid == mainPid)
            continue;

        struct proc_bsdinfo bsd{};
        int ret = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd));
        if (ret != sizeof(bsd))
            continue;

        if (bsd.pbi_ppid == mainPid)
            children.push_back(pid);
    }
    return children;
}

} // namespace

SystemHealthSnapshot SystemHealth::sample() const {
    const auto wallNow = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count());

    // Throttle to 1 Hz.
    if (lastWallNanos != 0 && wallNow >= lastWallNanos && (wallNow - lastWallNanos) < 1'000'000'000ull) {
        cachedSnapshot.underrunCount = underrunCount.load(std::memory_order_relaxed);
        cachedSnapshot.audioCallbackCount = audioCallbackCount.load(std::memory_order_relaxed);
        cachedSnapshot.webClientCount = webClientCount.load(std::memory_order_relaxed);
        return cachedSnapshot;
    }

    // Refresh child PID list every 10 seconds.
    constexpr uint64_t kChildRefreshNanos = 10'000'000'000ull;
    if (lastChildRefreshNanos == 0 || (wallNow - lastChildRefreshNanos) >= kChildRefreshNanos) {
        childPids = discoverChildPids(getpid());
        lastChildRefreshNanos = wallNow;
    }

    // --- Collect metrics for main process + children ---
    const int mainPid = getpid();
    std::vector<ProcessHealthEntry> entries;
    entries.reserve(1 + childPids.size());

    // Main process
    {
        ProcessHealthEntry e;
        e.pid = mainPid;
        e.name = "resoset";
        e.rssBytes = processRssBytes();
        entries.push_back(std::move(e));
    }

    // Children
    for (int childPid : childPids) {
        ProcMetrics m;
        if (!getProcMetrics(childPid, m))
            continue;
        ProcessHealthEntry e;
        e.pid = childPid;
        e.name = std::move(m.name);
        e.rssBytes = m.rssBytes;
        entries.push_back(std::move(e));
    }

    // --- CPU percentage: per-process delta tracking ---
    // Collect current CPU time for each process.
    std::unordered_map<int, uint64_t> cpuNowByPid;
    double totalCpuPercent = 0.0;
    {
        uint64_t mainCpu = processCpuTimeNanos();
        cpuNowByPid[mainPid] = mainCpu;
        uint64_t totalCpuNow = mainCpu;
        for (size_t i = 1; i < entries.size(); ++i) {
            ProcMetrics m;
            if (getProcMetrics(entries[i].pid, m)) {
                cpuNowByPid[entries[i].pid] = m.cpuTimeNanos;
                totalCpuNow += m.cpuTimeNanos;
            }
        }

        // Per-process CPU% from delta.
        const double dWall = static_cast<double>(wallNow - lastWallNanos);
        if (lastWallNanos != 0 && dWall > 0.0) {
            for (auto& e : entries) {
                auto it = cpuNowByPid.find(e.pid);
                auto prev = prevCpuByPid.find(e.pid);
                if (it != cpuNowByPid.end() && prev != prevCpuByPid.end()
                    && it->second >= prev->second) {
                    const double dCpu = static_cast<double>(it->second - prev->second);
                    e.cpuPercent = (dCpu / dWall) * 100.0;
                }
            }
        }

        // Total CPU%.
        if (lastWallNanos != 0 && dWall > 0.0) {
            uint64_t totalPrevCpu = 0;
            for (const auto& [pid, prev] : prevCpuByPid)
                totalPrevCpu += prev;
            if (totalCpuNow >= totalPrevCpu) {
                const double dCpu = static_cast<double>(totalCpuNow - totalPrevCpu);
                totalCpuPercent = (dCpu / dWall) * 100.0;
            }
        }

        // Save for next sample.
        prevCpuByPid = std::move(cpuNowByPid);
        lastCpuNanos = totalCpuNow;
    }

    // --- Build snapshot ---
    SystemHealthSnapshot snap;
    snap.processes = std::move(entries);
    snap.totalCpuPercent = totalCpuPercent;

    uint64_t totalRss = 0;
    for (const auto& e : snap.processes)
        totalRss += e.rssBytes;
    snap.totalRssBytes = totalRss;

    snap.systemFreeBytes = systemFreeMemoryBytes();
    snap.systemTotalBytes = systemTotalMemoryBytes();
    snap.underrunCount = underrunCount.load(std::memory_order_relaxed);
    snap.audioCallbackCount = audioCallbackCount.load(std::memory_order_relaxed);
    snap.webClientCount = webClientCount.load(std::memory_order_relaxed);

    lastWallNanos = wallNow;
    cachedSnapshot = snap;

    return snap;
}

} // namespace resoset
