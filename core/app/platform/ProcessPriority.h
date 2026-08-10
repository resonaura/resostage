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

/**
 * Resident promoter, standing aside or resuming.
 *
 * `yielding` moves the calling thread's disk I/O between IOPOL_THROTTLE --
 * which the kernel actively defers behind other I/O, and will even pause
 * mid-transfer for -- and the IOPOL_UTILITY it normally runs at. Called when
 * the playing song's rings start draining; see engine/audio/IoPressurePolicy.h
 * for why a lower thread priority alone was not enough.
 *
 * QoS is deliberately left alone: this thread's problem is the disk queue, not
 * the CPU, and dropping it to BACKGROUND would also delay the check that lets
 * it come back.
 */
void setBackgroundWorkerIoYielding(bool yielding);

} // namespace resostage
