#include "MacThreadTime.h"

#if defined(__APPLE__)
#include <mach/mach.h>
#include <mach/thread_act.h>
#include <mach/thread_info.h>

namespace resostage {

double MacThreadTime::currentThreadCpuMillis() {
    mach_port_t thread = mach_thread_self();
    thread_basic_info_data_t info{};
    mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
    const kern_return_t kr =
        thread_info(thread, THREAD_BASIC_INFO, reinterpret_cast<thread_info_t>(&info), &count);
    mach_port_deallocate(mach_task_self(), thread);
    if (kr != KERN_SUCCESS)
        return 0.0;

    const double userMs = static_cast<double>(info.user_time.seconds) * 1000.0
                          + static_cast<double>(info.user_time.microseconds) / 1000.0;
    const double systemMs = static_cast<double>(info.system_time.seconds) * 1000.0
                            + static_cast<double>(info.system_time.microseconds) / 1000.0;
    return userMs + systemMs;
}

} // namespace resostage
#endif
