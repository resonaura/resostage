# Authoritative plug-in loading and transport readiness

## Goal

Project content must open immediately while AU/VST3 creation/restoration runs
off-thread. Display a shared themed loading modal and accurate slot states;
never start a newly opened project's transport before plug-ins reach a terminal
state. Missing/crashing/timed-out plug-ins must not leave a permanent spinner.

## Plan and ownership

1. Verify the preceding commits, focused UI/native tests and bundled FFmpeg
   paths; preserve their implementation and comments.
2. Add a bounded generation/epoch-scoped Core loading session. Workers report
   per-slot terminal progress without publishing partially built DSP banks.
   Newer requests supersede old progress; exceptions publish explicit failure.
3. Gate Play/Record in Core, not only React. Keep an explicit pending Play
   intent, cleared on Stop/project replacement. Degraded project loads require
   an explicit continue-with-available decision; retries use the existing host
   recovery and never create an unbounded restart loop.
4. Publish compact loading status through structural HTTP state and each slot's
   true state. Existing compatible live banks keep playing during ordinary
   insert edits; those edits show per-slot progress without a project modal.
5. Add the shell-owned modal using the shared HeroUI Modal/Button wrappers;
   handle disconnected Core, fresh project, no plug-ins, failure, retry, Stop,
   changed generation and failed state restoration. Never claim percentage of
   elapsed time: counts represent completed slots only.
6. Test state-machine transitions, stale workers, partial failures, transport
   intent cancellation, UI loading/failed/bypassed distinction, and complete
   optimized build/test matrix.

## Invariants

No vendor code or loading waits enter the message/audio threads. Bank publication
remains immutable and epoch/layout checked. Loading progress is bounded and
worker-owned; UI only views Core snapshots. Preserve shared history, reliable
command ordering, transparent failure and existing dry/silence fallback.

## Status

Complete. Verified 2026-10-01.
- `PluginLoadingSession` provides epoch- and generation-scoped progress and terminal state management.
- Transport Play and Record in `AudioEngineTransportControls.cpp` and `AudioEngineRecording.cpp` gate on `pluginLoadingSession.requestTransport()`, storing pending play intent when initiated while loading.
- `WebServerTelemetry` publishes `WPluginLoadingTelemetry` carrying epoch, generation, phase, slot counts, and error details.
- Slot UI (`PluginSlotControl`, `PluginInsertSlots`, `StripInputControls`, `PluginChainModal`) renders explicit loading states, spinners, and disabled open affordances until fully loaded.
- `PluginLoadingDialog` presents real-time progress modal with "Keep stopped", "Retry loading", and "Continue with available" options.
- Native test `test_plugin_loading_session.cpp` (5 cases / 2029 assertions passed); UI tests `loadingView.test.ts` (3 tests passed) and `pluginSlotControl.test.tsx` (3 tests passed).

