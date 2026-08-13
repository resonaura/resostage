#include "SystemHealth.h"

// Windows implementation of SystemHealth::sample().
//
// The macOS version (SystemHealth.cpp) reads process RSS / CPU / disk via
// libproc + mach; there is no equivalent single API on Windows, so this file
// assembles the same snapshot from the Win32 / Toolhelp / Performance helper
// APIs. It is only compiled on WIN32 (see engine/CMakeLists.txt) and the
// macOS sample() lives in SystemHealth.cpp under #if defined(__APPLE__).
//
// Accuracy notes (deliberate, matching the header's contract):
//  - CPU% is a wall-clock delta between samples, same shape as macOS. Process
//    CPU time comes from GetProcessTimes (100ns ticks).
//  - RSS comes from the PEB / Process Memory Counters; there is no "phys
//    footprint" concept, so WorkingSetSize is used -- the closest analogue to
//    what the macOS panel reported.
//  - Child-process discovery uses Toolhelp (the parent PID of every process),
//    walked up to a bounded depth like the macOS version.
//  - System-wide memory comes from GlobalMemoryStatusEx.
//  - Disk I/O counters come from GetProcessIoCounters.

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>

#include <algorithm>
#include <chrono>
#include <thread>
#include <unordered_map>
#include <vector>

namespace resostage {

namespace {

// CPU time across all processes belonging to the app, in nanoseconds.
uint64_t processCpuTimeNanos(HANDLE proc) {
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (proc == nullptr || proc == INVALID_HANDLE_VALUE)
        return 0;
    if (GetProcessTimes(proc, &creation, &exit, &kernel, &user) == 0)
        return 0;
    const auto toNanos = [](const FILETIME& ft) {
        const unsigned long long ticks =
            (static_cast<unsigned long long>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
        return ticks * 100ull; // 100ns -> ns
    };
    return toNanos(kernel) + toNanos(user);
}

uint64_t processRssBytes(HANDLE proc) {
    if (proc == nullptr || proc == INVALID_HANDLE_VALUE)
        return 0;
    PROCESS_MEMORY_COUNTERS pmc{};
    pmc.cb = sizeof(pmc);
    if (GetProcessMemoryInfo(proc, &pmc, sizeof(pmc)) == 0)
        return 0;
    return static_cast<uint64_t>(pmc.WorkingSetSize);
}

std::string processName(DWORD pid) {
    // GetProcessImageFileNameW needs the process handle with QUERY_LIMITED_INFORMATION.
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (h == nullptr)
        return {};
    wchar_t buf[MAX_PATH]{};
    DWORD size = MAX_PATH;
    std::string name;
    if (QueryFullProcessImageNameW(h, 0, buf, &size) != 0) {
        // Basename only -- strip any trailing path.
        std::wstring w(buf, size);
        const auto slash = w.find_last_of(L"\\/");
        if (slash != std::wstring::npos)
            w = w.substr(slash + 1);
        name.assign(w.begin(), w.end());
    }
    CloseHandle(h);
    return name;
}

std::vector<int> discoverRelatedPids(int mainPid) {
    std::vector<int> related;
    std::unordered_map<int, int> parentOf;

    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE)
        return related;

    PROCESSENTRY32W pe{};
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
        do {
            parentOf[static_cast<int>(pe.th32ProcessID)] = static_cast<int>(pe.th32ParentProcessID);
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);

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
    const auto nowWall = std::chrono::steady_clock::now();
    const uint64_t wallNow = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(nowWall.time_since_epoch()).count());

    // Throttle full sample to 1 Hz -- same policy as macOS (CPU% is a wall-time delta).
    if (lastWallNanos != 0 && wallNow >= lastWallNanos
        && (wallNow - lastWallNanos) < 1'000'000'000ull) {
        cachedSnapshot.underrunCount = underrunCount.load(std::memory_order_relaxed);
        cachedSnapshot.silentBlockCount = silentBlockCount.load(std::memory_order_relaxed);
        cachedSnapshot.pitchBlockCount = pitchBlockCount.load(std::memory_order_relaxed);
        cachedSnapshot.webClientCount = webClientCount.load(std::memory_order_relaxed);
        return cachedSnapshot;
    }

    constexpr uint64_t kChildRefreshNanos = 5'000'000'000ull;
    if (lastChildRefreshNanos == 0 || (wallNow - lastChildRefreshNanos) >= kChildRefreshNanos) {
        childPids = discoverRelatedPids(GetCurrentProcessId());
        lastChildRefreshNanos = wallNow;
    }

    const int mainPid = GetCurrentProcessId();
    const HANDLE self = GetCurrentProcess();
    std::vector<ProcessHealthEntry> entries;
    entries.reserve(1 + childPids.size());

    {
        ProcessHealthEntry e;
        e.pid = mainPid;
        e.name = processName(static_cast<DWORD>(mainPid));
        if (e.name.empty())
            e.name = "ResoStage";
        e.rssBytes = processRssBytes(self);
        entries.push_back(std::move(e));
    }

    for (int childPid : childPids) {
        HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_QUERY_INFORMATION, FALSE,
                               static_cast<DWORD>(childPid));
        ProcessHealthEntry e;
        e.pid = childPid;
        e.name = processName(static_cast<DWORD>(childPid));
        if (e.name.empty())
            e.name = "pid-" + std::to_string(childPid);
        e.rssBytes = processRssBytes(h);
        if (h != nullptr && h != INVALID_HANDLE_VALUE)
            CloseHandle(h);
        entries.push_back(std::move(e));
    }

    std::unordered_map<int, uint64_t> cpuNowByPid;
    double totalCpuPercent = 0.0;
    {
        const uint64_t mainCpu = processCpuTimeNanos(self);
        cpuNowByPid[mainPid] = mainCpu;
        uint64_t totalCpuNow = mainCpu;

        for (size_t i = 1; i < entries.size(); ++i) {
            HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_QUERY_INFORMATION,
                                   FALSE, static_cast<DWORD>(entries[i].pid));
            const uint64_t cpu = processCpuTimeNanos(h);
            if (h != nullptr && h != INVALID_HANDLE_VALUE)
                CloseHandle(h);
            cpuNowByPid[entries[i].pid] = cpu;
            totalCpuNow += cpu;
        }

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

    {
        MEMORYSTATUSEX mem{};
        mem.dwLength = sizeof(mem);
        if (GlobalMemoryStatusEx(&mem) != 0) {
            snap.systemFreeBytes = static_cast<uint64_t>(mem.ullAvailPhys);
            snap.systemTotalBytes = static_cast<uint64_t>(mem.ullTotalPhys);
        }
    }

    static const uint32_t kCores = std::max(1u, std::thread::hardware_concurrency());
    snap.cpuCoreCount = kCores;
    snap.underrunCount = underrunCount.load(std::memory_order_relaxed);
    snap.audioCallbackCount = audioCallbackCount.load(std::memory_order_relaxed);
    snap.silentBlockCount = silentBlockCount.load(std::memory_order_relaxed);
    snap.pitchBlockCount = pitchBlockCount.load(std::memory_order_relaxed);
    snap.webClientCount = webClientCount.load(std::memory_order_relaxed);

    {
        IO_COUNTERS io{};
        if (GetProcessIoCounters(self, &io) != 0) {
            const double elapsedSec =
                lastWallNanos != 0 && wallNow > lastWallNanos
                    ? static_cast<double>(wallNow - lastWallNanos) / 1e9
                    : 0.0;
            if (elapsedSec > 0.0) {
                const uint64_t dRead =
                    io.ReadTransferCount > prevDiskReadBytes ? io.ReadTransferCount - prevDiskReadBytes : 0;
                const uint64_t dWrite =
                    io.WriteTransferCount > prevDiskWriteBytes ? io.WriteTransferCount - prevDiskWriteBytes : 0;
                snap.diskReadBytesPerSec = static_cast<double>(dRead) / elapsedSec;
                snap.diskWriteBytesPerSec = static_cast<double>(dWrite) / elapsedSec;
            }
            prevDiskReadBytes = io.ReadTransferCount;
            prevDiskWriteBytes = io.WriteTransferCount;
        }
    }

    lastWallNanos = wallNow;
    cachedSnapshot = snap;

    return snap;
}

} // namespace resostage

#endif // _WIN32