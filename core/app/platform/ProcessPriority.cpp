#include "ProcessPriority.h"

#include <pthread.h>
#include <sys/resource.h>

#if defined(__APPLE__)
#include <pthread/qos.h>
// setiopolicy_np lives in this header on Darwin.
#include <sys/resource.h>
#endif

namespace resostage {

void boostAppProcessPriority() {
#if defined(__APPLE__)
    // Message thread (timers, WS publish, peak JSON): USER_INITIATED — not
    // USER_INTERACTIVE. Graphics live in the Electron shell process; elevating
    // Core's message loop to Interactive made it compete with CoreAudio's
    // realtime workgroup for P-cores under load ("audio should beat graphics").
    (void)pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0);
#endif

    // Mild process-wide nice boost (helps streaming + callback relatives).
    // May fail without privileges -- ignore errno. Avoid -10: that also
    // elevates peak-build workers before they demote themselves.
    (void)setpriority(PRIO_PROCESS, 0, -5);

#if defined(__APPLE__)
    // Do NOT set PRIO_DARWIN_ROLE_UI_FOCAL — that marks the process as
    // UI-first. Leave Darwin role default so the scheduler keeps favoring
    // realtime audio + workgroup-joined refill over UI work.
#endif
}

void boostStreamingIoThreadPriority() {
#if defined(__APPLE__)
    // Above message-thread UI work, below CoreAudio realtime. USER_INITIATED
    // with a relative offset so refill wins against peak-build UTILITY and
    // against the Electron shell's own interactive threads on shared cores.
    (void)pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, -8);

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

void demoteBackgroundWorkerPriority() {
#if defined(__APPLE__)
    // Peak/waveform decode is heavy and parallel — must not steal P-cores
    // from the audio callback or streaming refill while a project loads.
    (void)pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
#if defined(IOPOL_TYPE_DISK) && defined(IOPOL_SCOPE_THREAD) && defined(IOPOL_UTILITY)
    (void)setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_THREAD, IOPOL_UTILITY);
#endif
#else
    (void)0;
#endif
}

void setBackgroundWorkerIoYielding(bool yielding) {
#if defined(__APPLE__) && defined(IOPOL_TYPE_DISK) && defined(IOPOL_SCOPE_THREAD) \
    && defined(IOPOL_THROTTLE) && defined(IOPOL_UTILITY)
    (void)setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_THREAD,
                         yielding ? IOPOL_THROTTLE : IOPOL_UTILITY);
#else
    (void)yielding;
#endif
}

} // namespace resostage
