#include "ThreadTime.h"

#if defined(__APPLE__)
#include <mach/mach.h>
#include <mach/thread_act.h>
#include <mach/thread_info.h>
#elif defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <ctime>
#endif

namespace resostage {

double currentThreadCpuMillis() {
#if defined(__APPLE__)
    // thread_info with THREAD_BASIC_INFO reads counters the kernel already
    // keeps for the thread; it does not allocate and does not block, which is
    // why this is safe from the render callback. mach_thread_self() returns an
    // owned send right, so it has to be released or the port leaks once per
    // call -- and this runs a few hundred times a second.
    mach_port_t thread = mach_thread_self();
    thread_basic_info_data_t info{};
    mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
    const kern_return_t kr =
        thread_info(thread, THREAD_BASIC_INFO, reinterpret_cast<thread_info_t>(&info), &count);
    mach_port_deallocate(mach_task_self(), thread);
    if (kr != KERN_SUCCESS)
        return 0.0;

    // User plus system: a callback blocked inside a syscall is still not
    // running our code, but a callback doing a lot of syscalls IS spending
    // CPU, and lumping that in with preemption would point the finger at the
    // scheduler for something we are doing to ourselves.
    const double userMs = static_cast<double>(info.user_time.seconds) * 1000.0
                          + static_cast<double>(info.user_time.microseconds) / 1000.0;
    const double systemMs = static_cast<double>(info.system_time.seconds) * 1000.0
                            + static_cast<double>(info.system_time.microseconds) / 1000.0;
    return userMs + systemMs;

#elif defined(_WIN32)
    FILETIME creation{};
    FILETIME exit{};
    FILETIME kernel{};
    FILETIME user{};
    if (GetThreadTimes(GetCurrentThread(), &creation, &exit, &kernel, &user) == 0)
        return 0.0;

    const auto toMillis = [](const FILETIME& ft) {
        // FILETIME counts 100-nanosecond intervals across two 32-bit halves.
        const unsigned long long ticks =
            (static_cast<unsigned long long>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
        return static_cast<double>(ticks) / 10000.0;
    };
    // GetThreadTimes has a ~15 ms quantum on some configurations, which is
    // coarser than an audio block -- so on Windows this classifies a RUN of
    // slow callbacks rather than a single one. Still the right signal; just
    // read the counts, not one sample.
    return toMillis(kernel) + toMillis(user);

#else
    // POSIX: Linux, and anything else with per-thread CPU clocks.
    timespec ts{};
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0)
        return 0.0;
    return static_cast<double>(ts.tv_sec) * 1000.0
           + static_cast<double>(ts.tv_nsec) / 1000000.0;
#endif
}

} // namespace resostage
