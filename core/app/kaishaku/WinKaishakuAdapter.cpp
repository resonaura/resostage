#if defined(_WIN32)
#include "WinKaishakuAdapter.h"
#include <windows.h>
#include <tlhelp32.h>
#include <cwchar>
#include <cstdlib>
#include <cstdio>
#include <chrono>
#include <thread>

namespace resostage {

static void killPidWin(DWORD pid) {
    if (pid <= 0) return;
    HANDLE hProc = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
    if (hProc != NULL) {
        TerminateProcess(hProc, 0);
        CloseHandle(hProc);
    }
}

bool WinKaishakuAdapter::killPids(const std::vector<int>& pids) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    for (int pid : pids) {
        if (pid <= 0) continue;
        killPidWin(static_cast<DWORD>(pid));
    }
    return true;
}

bool WinKaishakuAdapter::isCliMode() const {
    if (GetConsoleWindow() != NULL) return true;
    if (AttachConsole(ATTACH_PARENT_PROCESS)) return true;
    return false;
}

void WinKaishakuAdapter::showNoPidAlert() const {
    if (isCliMode()) {
        std::fprintf(stderr, "[kaishaku] Error: No target Process IDs (PIDs) specified for executioner.\n");
        std::fprintf(stderr, "Usage: kaishaku <pid1> [pid2 ...]\n");
    } else {
        MessageBoxW(
            NULL,
            L"Error: No target Process IDs (PIDs) specified for kaishaku executioner.\nUsage: kaishaku <pid1> [pid2 ...]",
            L"kaishaku Executioner",
            MB_OK | MB_ICONERROR
        );
    }
}

KaishakuAdapter* createKaishakuAdapter() {
    return new WinKaishakuAdapter();
}

} // namespace resostage
#endif
