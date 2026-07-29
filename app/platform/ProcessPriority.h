#pragma once

namespace resostage {

// Raise this process / main thread scheduling priority so the audio path is
// less likely to be preempted when the rest of the system is under load.
// Best-effort: fails soft if the OS denies the request (no root needed for
// the QoS path on macOS). Call once at app startup from the main thread.
void boostAppProcessPriority();

// Call from the streaming I/O thread right after it starts: elevates CPU
// scheduling QoS and disk I/O priority so WAV refill keeps up when the
// machine is thrashing (Spotlight, Time Machine, Xcode, other apps).
// Best-effort; never throws.
void boostStreamingIoThreadPriority();

} // namespace resostage
