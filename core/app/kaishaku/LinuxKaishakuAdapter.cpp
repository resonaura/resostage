#if defined(__linux__)
#include "LinuxKaishakuAdapter.h"
#include <cstdlib>
#include <cstdio>
#include <chrono>
#include <thread>
#include <unistd.h>
#include <signal.h>
#include <sys/types.h>

namespace resostage {

bool LinuxKaishakuAdapter::killPids(const std::vector<int>& pids) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    for (int pid : pids) {
        if (pid <= 0) continue;
        kill(static_cast<pid_t>(pid), SIGKILL);
    }
    return true;
}

bool LinuxKaishakuAdapter::isCliMode() const {
    return isatty(STDERR_FILENO) || isatty(STDOUT_FILENO);
}

void LinuxKaishakuAdapter::showNoPidAlert() const {
    if (isCliMode()) {
        std::fprintf(stderr, "[kaishaku] Error: No target Process IDs (PIDs) specified for executioner.\n");
        std::fprintf(stderr, "Usage: kaishaku <pid1> [pid2 ...]\n");
    } else {
        if (std::system("zenity --error --title=\"kaishaku Executioner Error\" --text=\"No target Process IDs (PIDs) specified for kaishaku executioner.\\nUsage: kaishaku <pid1> [pid2 ...]\" >/dev/null 2>&1") != 0) {
            if (std::system("kdialog --error \"No target Process IDs (PIDs) specified for kaishaku executioner.\\nUsage: kaishaku <pid1> [pid2 ...]\" >/dev/null 2>&1") != 0) {
                std::system("notify-send -u critical \"kaishaku Executioner Error\" \"No target Process IDs (PIDs) specified for executioner.\\nUsage: kaishaku <pid1> [pid2 ...]\" >/dev/null 2>&1");
            }
        }
    }
}

KaishakuAdapter* createKaishakuAdapter() {
    return new LinuxKaishakuAdapter();
}

} // namespace resostage
#endif
