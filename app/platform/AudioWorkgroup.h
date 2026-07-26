#pragma once

namespace resoset {

// Joins the calling thread to the current default CoreAudio output device's
// real-time IO workgroup (kAudioDevicePropertyIOThreadOSWorkgroup), so
// macOS's scheduler treats it as sharing a deadline with the audio render
// thread and is much less likely to demote it to an Efficiency core on
// Apple Silicon. Call once from the thread itself, near the top of its run
// loop.
//
// IMPORTANT: every thread that calls this MUST call
// leaveCurrentThreadWorkgroupIfJoined() from the SAME thread before that
// thread exits. macOS's pthread TSD cleanup hits a hard breakpoint
// (SIGTRAP in _os_workgroup_tsd_cleanup) if a thread terminates while still
// joined to a workgroup -- this bit us for real on a restartable thread
// (StreamingEngine's I/O thread, torn down and recreated on every
// newProject()/loadProject()/saveProject()) that joined once and never left.
// Join state is tracked in thread-local storage so both calls can be made
// from ordinary free functions without threading a token object across the
// engine/app boundary (StreamingEngine et al. must stay CoreAudio-free).
//
// Limitation: queries the SYSTEM DEFAULT output device's workgroup rather
// than JUCE's actual selected device, because JUCE's cross-platform
// AudioIODevice does not expose the underlying CoreAudio AudioDeviceID /
// os_workgroup_t. This joins the correct workgroup for the common case
// (default device selected) but not necessarily when the user has
// explicitly picked a non-default audio interface -- a real limitation,
// not silently assumed away. Not verified against real E-core-demotion
// measurements in this environment (no practical way to observe scheduler
// core placement from here); this implements the documented API correctly
// but its real-world benefit hasn't been measured on real hardware.
//
// Returns false (harmlessly) if no workgroup could be obtained/joined --
// callers should treat this as a soft optimization, not a correctness requirement.
bool joinCurrentThreadToDefaultOutputWorkgroup();

// Leaves the workgroup joined by joinCurrentThreadToDefaultOutputWorkgroup()
// on this same thread, if any. Safe to call even if join was never called or
// failed (no-op in that case). MUST be called before the thread returns/exits.
void leaveCurrentThreadWorkgroupIfJoined();

} // namespace resoset
