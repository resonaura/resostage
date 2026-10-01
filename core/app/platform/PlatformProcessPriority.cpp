/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

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
