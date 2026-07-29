#pragma once

namespace resoset {

// Raise this process / main thread scheduling priority so the audio path is
// less likely to be preempted when the rest of the system is under load.
// Best-effort: fails soft if the OS denies the request (no root needed for
// the QoS path on macOS). Call once at app startup from the main thread.
void boostAppProcessPriority();

} // namespace resoset
