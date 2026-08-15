#include "PlatformShellMode.h"
#include "MacShellMode.h"
#include "WinShellMode.h"
#include "LinuxShellMode.h"

namespace resostage {

PlatformShellMode& PlatformShellMode::getInstance() {
#if defined(__APPLE__)
    static MacShellMode instance;
#elif defined(_WIN32)
    static WinShellMode instance;
#else
    static LinuxShellMode instance;
#endif
    return instance;
}

} // namespace resostage
