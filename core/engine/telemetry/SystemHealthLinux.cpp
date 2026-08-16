#include "SystemHealth.h"

#if !defined(__APPLE__) && !defined(_WIN32)
#include <sys/sysinfo.h>
#include <unistd.h>

#include <chrono>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>

namespace resostage {

SystemHealthSnapshot SystemHealth::sample() const {
    const auto now = std::chrono::steady_clock::now();
    const uint64_t wallNow = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(now.time_since_epoch()).count());

    if (lastWallNanos != 0 && wallNow >= lastWallNanos
        && (wallNow - lastWallNanos) < 1'000'000'000ull) {
        cachedSnapshot.underrunCount = underrunCount.load(std::memory_order_relaxed);
        cachedSnapshot.silentBlockCount = silentBlockCount.load(std::memory_order_relaxed);
        cachedSnapshot.pitchBlockCount = pitchBlockCount.load(std::memory_order_relaxed);
        cachedSnapshot.webClientCount = webClientCount.load(std::memory_order_relaxed);
        return cachedSnapshot;
    }

    SystemHealthSnapshot snap;
    ProcessHealthEntry mainProc;
    mainProc.pid = getpid();
    mainProc.name = "ResoStage";
    mainProc.rssBytes = 0;

    // Read RSS from /proc/self/statm
    std::ifstream statm("/proc/self/statm");
    if (statm) {
        long pages = 0, rssPages = 0;
        if (statm >> pages >> rssPages) {
            long pageSize = sysconf(_SC_PAGESIZE);
            mainProc.rssBytes = static_cast<uint64_t>(rssPages * pageSize);
        }
    }

    snap.processes.push_back(mainProc);
    snap.totalRssBytes = mainProc.rssBytes;

    struct sysinfo info;
    if (sysinfo(&info) == 0) {
        snap.systemFreeBytes = static_cast<uint64_t>(info.freeram) * info.mem_unit;
        snap.systemTotalBytes = static_cast<uint64_t>(info.totalram) * info.mem_unit;
    }

    snap.underrunCount = underrunCount.load(std::memory_order_relaxed);
    snap.silentBlockCount = silentBlockCount.load(std::memory_order_relaxed);
    snap.pitchBlockCount = pitchBlockCount.load(std::memory_order_relaxed);
    snap.webClientCount = webClientCount.load(std::memory_order_relaxed);
    snap.audioCallbackCount = audioCallbackCount.load(std::memory_order_relaxed);

    lastWallNanos = wallNow;
    cachedSnapshot = snap;
    return snap;
}

} // namespace resostage

#endif // !defined(__APPLE__) && !defined(_WIN32)
