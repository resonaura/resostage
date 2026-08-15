#include "WinThreadTime.h"

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace resostage {

double WinThreadTime::currentThreadCpuMillis() {
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (GetThreadTimes(GetCurrentThread(), &creation, &exit, &kernel, &user) == 0)
        return 0.0;

    const auto toMillis = [](const FILETIME& ft) {
        const unsigned long long ticks =
            (static_cast<unsigned long long>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
        return static_cast<double>(ticks) / 10000.0;
    };
    return toMillis(kernel) + toMillis(user);
}

} // namespace resostage
#endif
