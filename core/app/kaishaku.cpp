#include <cstdlib>
#include <cstdio>
#include <chrono>
#include <thread>
#include <vector>
#include <string>

#if defined(_WIN32)
#include <windows.h>
#include <tlhelp32.h>
#include <cwchar>

static void killPidWin32(DWORD pid) {
    if (pid <= 0) return;
    HANDLE hProc = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
    if (hProc != NULL) {
        TerminateProcess(hProc, 0);
        CloseHandle(hProc);
    }
}

static bool isCliMode() {
    if (GetConsoleWindow() != NULL) return true;
    if (AttachConsole(ATTACH_PARENT_PROCESS)) return true;
    return false;
}
#else
#include <unistd.h>
#include <signal.h>
#include <sys/types.h>

static bool isCliMode() {
    return isatty(STDERR_FILENO) || isatty(STDOUT_FILENO);
}
#endif

// kaishaku (介錯) -- Precise PID Executioner of ResoStage
// Liquidates ONLY the exact target processes passed via command-line PIDs.

static int runKaishakuWithPids(const std::vector<int>& pids) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    for (int pid : pids) {
        if (pid <= 0) continue;
#if defined(_WIN32)
        killPidWin32(static_cast<DWORD>(pid));
#else
        kill(static_cast<pid_t>(pid), SIGKILL);
#endif
    }
    return 0;
}

static int showNoPidAlert() {
    if (isCliMode()) {
        std::fprintf(stderr, "[kaishaku] Error: No target Process IDs (PIDs) specified for executioner.\n");
        std::fprintf(stderr, "Usage: kaishaku <pid1> [pid2 ...]\n");
    } else {
#if defined(_WIN32)
        MessageBoxW(
            NULL,
            L"Error: No target Process IDs (PIDs) specified for kaishaku executioner.\nUsage: kaishaku <pid1> [pid2 ...]",
            L"kaishaku Executioner",
            MB_OK | MB_ICONERROR
        );
#elif defined(__APPLE__)
        std::system("osascript -e 'display alert \"kaishaku Executioner Error\" message \"No target Process IDs (PIDs) specified for executioner.\\nUsage: kaishaku <pid1> [pid2 ...]\" as critical' >/dev/null 2>&1");
#else // Linux GUI (GNOME zenity, KDE kdialog, notify-send fallback)
        if (std::system("zenity --error --title=\"kaishaku Executioner Error\" --text=\"No target Process IDs (PIDs) specified for kaishaku executioner.\\nUsage: kaishaku <pid1> [pid2 ...]\" >/dev/null 2>&1") != 0) {
            if (std::system("kdialog --error \"No target Process IDs (PIDs) specified for kaishaku executioner.\\nUsage: kaishaku <pid1> [pid2 ...]\" >/dev/null 2>&1") != 0) {
                std::system("notify-send -u critical \"kaishaku Executioner Error\" \"No target Process IDs (PIDs) specified for executioner.\\nUsage: kaishaku <pid1> [pid2 ...]\" >/dev/null 2>&1");
            }
        }
#endif
    }
    return 1;
}

#if defined(_WIN32)
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    int argc = 0;
    LPWSTR* argvW = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::vector<int> pids;
    if (argvW && argc > 1) {
        for (int i = 1; i < argc; ++i) {
            int pid = _wtoi(argvW[i]);
            if (pid > 0) pids.push_back(pid);
        }
        LocalFree(argvW);
    }

    if (!pids.empty()) {
        return runKaishakuWithPids(pids);
    }
    return showNoPidAlert();
}
#else
int main(int argc, char* argv[]) {
    std::vector<int> pids;
    for (int i = 1; i < argc; ++i) {
        int pid = std::atoi(argv[i]);
        if (pid > 0) pids.push_back(pid);
    }

    if (!pids.empty()) {
        return runKaishakuWithPids(pids);
    }
    return showNoPidAlert();
}
#endif
