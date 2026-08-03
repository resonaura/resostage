#pragma once

namespace resostage {

// App startup (main / message thread). Prefers a *balanced* elevated nice
// without claiming "UI-first" Darwin role or USER_INTERACTIVE QoS -- those
// fight CoreAudio's realtime workgroup for P-cores. Audio callback stays on
// CoreAudio realtime; streaming I/O gets its own boost. Best-effort.
void boostAppProcessPriority();

// Call from the streaming I/O thread right after it starts: elevates CPU
// scheduling QoS and disk I/O priority so WAV refill keeps up when the
// machine is thrashing (Spotlight, Time Machine, Xcode, other apps).
// Best-effort; never throws. Intentionally higher than the message thread.
void boostStreamingIoThreadPriority();

// Peak-decode / waveform-build workers: UTILITY QoS so heavy pyramid builds
// never starve the audio callback or streaming refill. Call once per worker
// thread at start.
void demoteBackgroundWorkerPriority();

} // namespace resostage
