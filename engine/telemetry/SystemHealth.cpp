#include "SystemHealth.h"

#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_host.h>
#include <mach/mach_time.h>
#include <mach/task_info.h>
#include <mach/thread_act.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <unistd.h>

#include <chrono>
#include <unordered_map>

namespace resoset {

namespace {

// rusage_info ri_user_time / ri_system_time are mach *absolute time* ticks
// (not nanoseconds). Without timebase conversion CPU% is under-reported by
// ~numer/denom (often ~40× on Apple Silicon) — that was the Activity
// Monitor mismatch. Verified empirically against a busy loop.
uint64_t absTimeToNanos(uint64_t abs) {
    static mach_timebase_info_data_t tb{};
    static bool inited = false;
    if (!inited) {
        mach_timebase_info(&tb);
        inited = true;
    }
    if (tb.denom == 0)
        return abs;
    // abs * numer / denom, avoid overflow where possible.
    return (abs / tb.denom) * tb.numer + ((abs % tb.denom) * tb.numer) / tb.denom;
}

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
    // free + inactive + speculative ≈ "Memory Available" style figure.
    return (static_cast<uint64_t>(vmstat.free_count)
            + static_cast<uint64_t>(vmstat.inactive_count)
            + static_cast<uint64_t>(vmstat.speculative_count))
           * pageSize;
}

// Activity Monitor "Memory" column ≈ phys_footprint.
uint64_t processPhysFootprintBytes() {
    task_vm_info_data_t info{};
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    if (task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count)
        != KERN_SUCCESS)
        return 0;
    return static_cast<uint64_t>(info.phys_footprint);
}

struct ProcMetrics {
    std::string name;
    uint64_t rssBytes = 0;
    uint64_t cpuTimeNanos = 0;
};

// Sum of all live threads (time_value is wall clock seconds+µs — already real time).
uint64_t sumLiveThreadCpuNanos() {
    thread_act_array_t threads = nullptr;
    mach_msg_type_number_t threadCount = 0;
    if (task_threads(mach_task_self(), &threads, &threadCount) != KERN_SUCCESS)
        return 0;
    uint64_t total = 0;
    for (mach_msg_type_number_t i = 0; i < threadCount; ++i) {
        thread_basic_info_data_t info{};
        mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
        if (thread_info(threads[i], THREAD_BASIC_INFO, reinterpret_cast<thread_info_t>(&info),
                        &count)
            == KERN_SUCCESS) {
            total += static_cast<uint64_t>(info.user_time.seconds) * 1'000'000'000ull
                     + static_cast<uint64_t>(info.user_time.microseconds) * 1'000ull;
            total += static_cast<uint64_t>(info.system_time.seconds) * 1'000'000'000ull
                     + static_cast<uint64_t>(info.system_time.microseconds) * 1'000ull;
        }
        mach_port_deallocate(mach_task_self(), threads[i]);
    }
    vm_deallocate(mach_task_self(), reinterpret_cast<vm_address_t>(threads),
                  sizeof(thread_t) * threadCount);
    return total;
}

uint64_t selfTaskCpuTimeNanos() {
    struct rusage_info_v6 ru{};
    if (proc_pid_rusage(getpid(), RUSAGE_INFO_V6, reinterpret_cast<rusage_info_t*>(&ru)) == 0) {
        return absTimeToNanos(ru.ri_user_time) + absTimeToNanos(ru.ri_system_time);
    }
    // Fallback: live threads only (under-counts terminated-but-billed time).
    return sumLiveThreadCpuNanos();
}

bool getProcMetrics(int pid, ProcMetrics& out) {
    struct rusage_info_v6 ru{};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V6, reinterpret_cast<rusage_info_t*>(&ru)) == 0) {
        out.cpuTimeNanos =
            absTimeToNanos(ru.ri_user_time) + absTimeToNanos(ru.ri_system_time);
        out.rssBytes = static_cast<uint64_t>(ru.ri_phys_footprint);
        if (out.rssBytes == 0)
            out.rssBytes = static_cast<uint64_t>(ru.ri_resident_size);
    } else {
        struct proc_taskinfo pti{};
        if (proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &pti, sizeof(pti)) != sizeof(pti))
            return false;
        // pti_total_* are also absolute-time ticks.
        out.cpuTimeNanos =
            absTimeToNanos(static_cast<uint64_t>(pti.pti_total_user))
            + absTimeToNanos(static_cast<uint64_t>(pti.pti_total_system));
        out.rssBytes = static_cast<uint64_t>(pti.pti_resident_size);
    }

    char nameBuf[256]{};
    proc_name(pid, nameBuf, sizeof(nameBuf));
    out.name = nameBuf;
    return true;
}

std::vector<int> discoverRelatedPids(int mainPid) {
    std::vector<int> related;
    constexpr int kMaxPids = 4096;
    int pidBuf[kMaxPids]{};
    int numPids = proc_listpids(PROC_ALL_PIDS, 0, pidBuf, sizeof(pidBuf));
    if (numPids <= 0)
        return related;

    std::unordered_map<int, int> parentOf;
    const int count = numPids / static_cast<int>(sizeof(int));
    for (int i = 0; i < count; ++i) {
        const int pid = pidBuf[i];
        if (pid <= 0)
            continue;
        struct proc_bsdinfo bsd{};
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd)) != sizeof(bsd))
            continue;
        parentOf[pid] = static_cast<int>(bsd.pbi_ppid);
    }

    auto isDescendant = [&](int pid) {
        for (int depth = 0; depth < 6 && pid > 0; ++depth) {
            auto it = parentOf.find(pid);
            if (it == parentOf.end())
                return false;
            if (it->second == mainPid)
                return true;
            pid = it->second;
        }
        return false;
    };

    for (const auto& [pid, ppid] : parentOf) {
        (void)ppid;
        if (pid == mainPid)
            continue;
        if (isDescendant(pid))
            related.push_back(pid);
    }
    return related;
}

} // namespace

SystemHealthSnapshot SystemHealth::sample() const {
    // Wall time: prefer mach_absolute_time (same clock domain as process times
    // after conversion) for stable deltas under clock adjustments.
    static mach_timebase_info_data_t tb{};
    static bool tbInited = false;
    if (!tbInited) {
        mach_timebase_info(&tb);
        tbInited = true;
    }
    const uint64_t wallAbs = mach_absolute_time();
    const uint64_t wallNow = absTimeToNanos(wallAbs);

    // Throttle full sample to ~2 Hz.
    if (lastWallNanos != 0 && wallNow >= lastWallNanos
        && (wallNow - lastWallNanos) < 500'000'000ull) {
        cachedSnapshot.underrunCount = underrunCount.load(std::memory_order_relaxed);
        cachedSnapshot.audioCallbackCount = audioCallbackCount.load(std::memory_order_relaxed);
        cachedSnapshot.webClientCount = webClientCount.load(std::memory_order_relaxed);
        return cachedSnapshot;
    }

    constexpr uint64_t kChildRefreshNanos = 5'000'000'000ull;
    if (lastChildRefreshNanos == 0 || (wallNow - lastChildRefreshNanos) >= kChildRefreshNanos) {
        childPids = discoverRelatedPids(getpid());
        lastChildRefreshNanos = wallNow;
    }

    const int mainPid = getpid();
    std::vector<ProcessHealthEntry> entries;
    entries.reserve(1 + childPids.size());

    {
        ProcessHealthEntry e;
        e.pid = mainPid;
        ProcMetrics m;
        if (getProcMetrics(mainPid, m)) {
            e.name = m.name.empty() ? "ResoStage" : m.name;
            e.rssBytes = processPhysFootprintBytes();
            if (e.rssBytes == 0)
                e.rssBytes = m.rssBytes;
        } else {
            e.name = "ResoStage";
            e.rssBytes = processPhysFootprintBytes();
        }
        entries.push_back(std::move(e));
    }

    for (int childPid : childPids) {
        ProcMetrics m;
        if (!getProcMetrics(childPid, m))
            continue;
        ProcessHealthEntry e;
        e.pid = childPid;
        e.name = m.name.empty() ? ("pid-" + std::to_string(childPid)) : std::move(m.name);
        e.rssBytes = m.rssBytes;
        entries.push_back(std::move(e));
    }

    std::unordered_map<int, uint64_t> cpuNowByPid;
    double totalCpuPercent = 0.0;
    {
        const uint64_t mainCpu = selfTaskCpuTimeNanos();
        cpuNowByPid[mainPid] = mainCpu;
        uint64_t totalCpuNow = mainCpu;

        for (size_t i = 1; i < entries.size(); ++i) {
            ProcMetrics m;
            if (getProcMetrics(entries[i].pid, m)) {
                cpuNowByPid[entries[i].pid] = m.cpuTimeNanos;
                totalCpuNow += m.cpuTimeNanos;
            }
        }

        const double dWall = static_cast<double>(wallNow - lastWallNanos);
        if (lastWallNanos != 0 && dWall > 0.0) {
            for (auto& e : entries) {
                auto it = cpuNowByPid.find(e.pid);
                auto prev = prevCpuByPid.find(e.pid);
                if (it != cpuNowByPid.end() && prev != prevCpuByPid.end()
                    && it->second >= prev->second) {
                    const double dCpu = static_cast<double>(it->second - prev->second);
                    // 100% = one full logical core (Activity Monitor style).
                    e.cpuPercent = (dCpu / dWall) * 100.0;
                }
            }

            uint64_t prevSumAlive = 0;
            for (const auto& e : entries) {
                auto prev = prevCpuByPid.find(e.pid);
                if (prev != prevCpuByPid.end())
                    prevSumAlive += prev->second;
            }
            if (totalCpuNow >= prevSumAlive && prevSumAlive > 0) {
                const double dCpu = static_cast<double>(totalCpuNow - prevSumAlive);
                totalCpuPercent = (dCpu / dWall) * 100.0;
            }
        }

        prevCpuByPid = std::move(cpuNowByPid);
        lastCpuNanos = totalCpuNow;
    }

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
