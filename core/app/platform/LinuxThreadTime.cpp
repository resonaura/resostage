#include "LinuxThreadTime.h"
#include <ctime>

namespace resostage {

double LinuxThreadTime::currentThreadCpuMillis() {
#if !defined(__APPLE__) && !defined(_WIN32)
    timespec ts{};
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0)
        return 0.0;
    return static_cast<double>(ts.tv_sec) * 1000.0
           + static_cast<double>(ts.tv_nsec) / 1000000.0;
#else
    return 0.0;
#endif
}

} // namespace resostage
