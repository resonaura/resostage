#include "PlatformProcessPriority.h"
#include "win/WinProcessPriority.h"
#include "mac/MacProcessPriority.h"
#include "linux/LinuxProcessPriority.h"

namespace resostage {

PlatformProcessPriority& PlatformProcessPriority::getInstance() {
#if defined(__APPLE__)
    static MacProcessPriority instance;
#elif defined(_WIN32)
    static WinProcessPriority instance;
#else
    static LinuxProcessPriority instance;
#endif
    return instance;
}

void boostAppProcessPriority() {
    PlatformProcessPriority::getInstance().boostAppProcessPriority();
}

void boostStreamingIoThreadPriority() {
    PlatformProcessPriority::getInstance().boostStreamingIoThreadPriority();
}

void demoteBackgroundWorkerPriority() {
    PlatformProcessPriority::getInstance().demoteBackgroundWorkerPriority();
}

void setBackgroundWorkerIoYielding(bool yielding) {
    PlatformProcessPriority::getInstance().setBackgroundWorkerIoYielding(yielding);
}

} // namespace resostage
