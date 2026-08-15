#include "PlatformThreadTime.h"
#include "MacThreadTime.h"
#include "WinThreadTime.h"
#include "LinuxThreadTime.h"

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
