#if defined(__APPLE__)
#include "MacKaishakuAdapter.h"
#include <cstdlib>
#include <cstdio>
#include <chrono>
#include <thread>
#include <unistd.h>
#include <signal.h>
#include <sys/types.h>

namespace resostage {

bool MacKaishakuAdapter::killPids(const std::vector<int>& pids) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    for (int pid : pids) {
        if (pid <= 0) continue;
        kill(static_cast<pid_t>(pid), SIGKILL);
    }
    return true;
}

bool MacKaishakuAdapter::isCliMode() const {
    return isatty(STDERR_FILENO) || isatty(STDOUT_FILENO);
}

void MacKaishakuAdapter::showNoPidAlert() const {
    if (isCliMode()) {
        std::fprintf(stderr, "[kaishaku] Error: No target Process IDs (PIDs) specified for executioner.\n");
        std::fprintf(stderr, "Usage: kaishaku <pid1> [pid2 ...]\n");
    } else {
        std::system("osascript -e 'display alert \"kaishaku Executioner Error\" message \"No target Process IDs (PIDs) specified for executioner.\\nUsage: kaishaku <pid1> [pid2 ...]\" as critical' >/dev/null 2>&1");
    }
}

KaishakuAdapter* createKaishakuAdapter() {
    return new MacKaishakuAdapter();
}

} // namespace resostage
#endif
