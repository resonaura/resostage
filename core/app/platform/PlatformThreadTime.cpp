#include "PlatformThreadTime.h"
#include "mac/MacThreadTime.h"
#include "win/WinThreadTime.h"
#include "linux/LinuxThreadTime.h"

namespace resostage {

PlatformThreadTime& PlatformThreadTime::getInstance() {
#if defined(__APPLE__)
    static MacThreadTime instance;
#elif defined(_WIN32)
    static WinThreadTime instance;
#else
    static LinuxThreadTime instance;
#endif
    return instance;
}

double currentThreadCpuMillis() {
    return PlatformThreadTime::getInstance().currentThreadCpuMillis();
}

} // namespace resostage
