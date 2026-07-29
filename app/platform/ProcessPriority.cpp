#include "ProcessPriority.h"

#include <pthread.h>
#include <sys/resource.h>

#if defined(__APPLE__)
#include <pthread/qos.h>
#endif

namespace resoset {

void boostAppProcessPriority() {
#if defined(__APPLE__)
    // Prefer user-interactive QoS for the main thread (AppKit / message loop).
    // Audio IO and workgroup-joined threads already sit at realtime/high QoS
    // via CoreAudio + AudioWorkgroup; this keeps UI + timer callbacks from
    // being demoted to E-cores under thermal pressure.
    (void)pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
#endif

    // Best-effort nice boost. May fail without privileges -- ignore errno.
    (void)setpriority(PRIO_PROCESS, 0, -10);

#if defined(__APPLE__)
    // Ask for continuous high-performance behavior while the app is frontmost.
    // (No-op on older SDKs if the SPI is unavailable.)
#if defined(PRIO_DARWIN_ROLE)
    (void)setpriority(PRIO_DARWIN_ROLE, 0, PRIO_DARWIN_ROLE_UI_FOCAL);
#endif
#endif
}

} // namespace resoset
