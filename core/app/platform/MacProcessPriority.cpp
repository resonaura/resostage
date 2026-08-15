#include "MacProcessPriority.h"

#if defined(__APPLE__)
#include <pthread.h>
#include <pthread/qos.h>
#include <sys/resource.h>
#include <unistd.h>
#endif

namespace resostage {

void MacProcessPriority::boostAppProcessPriority() {
#if defined(__APPLE__)
    (void)pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0);
    (void)setpriority(PRIO_PROCESS, 0, -5);
#endif
}

void MacProcessPriority::boostStreamingIoThreadPriority() {
#if defined(__APPLE__)
    (void)pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, -8);
#if defined(IOPOL_TYPE_DISK) && defined(IOPOL_SCOPE_THREAD) && defined(IOPOL_IMPORTANT)
    (void)setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_THREAD, IOPOL_IMPORTANT);
#endif
#endif
}

void MacProcessPriority::demoteBackgroundWorkerPriority() {
#if defined(__APPLE__)
    (void)pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
#if defined(IOPOL_TYPE_DISK) && defined(IOPOL_SCOPE_THREAD) && defined(IOPOL_UTILITY)
    (void)setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_THREAD, IOPOL_UTILITY);
#endif
#endif
}

void MacProcessPriority::setBackgroundWorkerIoYielding(bool yielding) {
#if defined(__APPLE__) && defined(IOPOL_TYPE_DISK) && defined(IOPOL_SCOPE_THREAD) \
    && defined(IOPOL_THROTTLE) && defined(IOPOL_UTILITY)
    (void)setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_THREAD,
                         yielding ? IOPOL_THROTTLE : IOPOL_UTILITY);
#else
    (void)yielding;
#endif
}

} // namespace resostage
