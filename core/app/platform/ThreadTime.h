#pragma once

namespace resostage {

/**
 * CPU time consumed by the CALLING thread, in milliseconds.
 *
 * Not wall time: this advances only while the thread is actually running on a
 * core. Comparing the two across one render callback is what separates "we did
 * too much work" from "we were not scheduled" -- see
 * engine/telemetry/CallbackTiming.h for why that distinction is the whole
 * diagnosis.
 *
 * Real-time safe on every platform below: one system call that reads a counter
 * the kernel already maintains, no allocation and no lock. It is called twice
 * per audio callback, so it has to be.
 *
 * Returns 0 when the platform cannot answer. Callers must treat 0 as "unknown"
 * rather than "the thread ran for no time at all" -- classifyCallback() does.
 */
double currentThreadCpuMillis();

} // namespace resostage
