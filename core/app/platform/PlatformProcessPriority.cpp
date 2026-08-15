#include "PlatformProcessPriority.h"
#include "WinProcessPriority.h"
#include "MacProcessPriority.h"
#include "LinuxProcessPriority.h"

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
