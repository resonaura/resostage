#include "WinProcessPriority.h"

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace resostage {

void WinProcessPriority::boostAppProcessPriority() {
#if defined(_WIN32)
    SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
#endif
}

void WinProcessPriority::boostStreamingIoThreadPriority() {
#if defined(_WIN32)
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
#endif
}

void WinProcessPriority::demoteBackgroundWorkerPriority() {
#if defined(_WIN32)
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_NORMAL);
#endif
}

void WinProcessPriority::setBackgroundWorkerIoYielding(bool /*yielding*/) {
}

} // namespace resostage
