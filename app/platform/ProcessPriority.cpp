#include "ProcessPriority.h"

#include <pthread.h>
#include <sys/resource.h>

#if defined(__APPLE__)
#include <pthread/qos.h>
// setiopolicy_np lives in this header on Darwin.
#include <sys/resource.h>
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

void boostStreamingIoThreadPriority() {
#if defined(__APPLE__)
    // Streaming refill is latency-critical for continuous playback but not
    // the audio callback itself. USER_INITIATED beats Utility/Background
    // (Spotlight, Time Machine, Photos) without fighting the UI thread for
    // USER_INTERACTIVE cores the way a blanket Interactive would.
    (void)pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0);

    // Prefer this thread's disk reads over background throttled I/O so a
    // saturated SSD still services our WAV/zip refill first.
    // IOPOL_IMPORTANT: high priority, not the reserved REALTIME class.
#if defined(IOPOL_TYPE_DISK) && defined(IOPOL_SCOPE_THREAD) && defined(IOPOL_IMPORTANT)
    (void)setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_THREAD, IOPOL_IMPORTANT);
#endif
#else
    // Do NOT call setpriority(PRIO_PROCESS) here — that would renice the
    // whole process. Thread-level priority APIs differ by platform; leave
    // as best-effort no-op outside Darwin until we have a portable path.
    (void)0;
#endif
}

} // namespace resoset
