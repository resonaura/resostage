# Reliable project history

## Scope and ownership

Core's JUCE message thread remains the only project/history writer. Audio sees
prepared routing, MIDI, and streaming snapshots; React displays authoritative
state and does not apply its own independent project history. Keep reliable
history commands distinct from high-rate latest-wins telemetry.

## Reproduced causes

- Audio/MIDI region, section, and lighting-cue deletion compacts vectors with
  `std::remove_if` before capturing the before-snapshot. Undo therefore restores
  a partially moved vector instead of the original ordered entities.
- Track-send commands create history both in the dispatcher and the validated
  handler. This creates redundant entries and commits onto the wrong entry.
- Replayed history entries retain their open gesture IDs; a later edit can
  coalesce into a replayed step without invalidating the redo branch.
- HTTP command replies acknowledge queue admission, not application. An
  immediate UI refetch can occur before the message thread applies Undo/Redo.
- Concurrent HTTP polls can resolve out of order. The state merger also treats
  an authoritative empty sends array as omitted, undoing send deletion visually.

## Implementation plan

1. Snapshot before every destructive vector mutation; retain missing-ID no-op.
2. Remove duplicate ownership of send transactions and close gesture boundaries
   on history navigation. Test multi-edit branching and deletion round trips.
3. Make Undo/Redo completion observable through the reliable state/control path;
   never pretend queue admission is completed history application.
4. Order structural fetches, preserve explicit empty values, and invalidate
   optimistic locks/drafts on history navigation so old gestures cannot win.
5. Verify focused native/UI tests, typecheck, and application build. Report
   any integration limits without marking unfinished behavior complete.

## Status

Complete. Verified 2026-10-01.
- Vector mutations in `AudioEngineTimeline.cpp` capture full deep snapshots before mutations, with ID resolution via `HistoryRestore.h`.
- Duplicate send transaction creation removed; gesture boundaries properly cleared on undo/redo navigation in `ProjectHistory.cpp`.
- HTTP command returns `WHistoryAccepted` with `historyRequestId` and `stateSessionId`; UI awaits confirmed snapshot where `lastHistoryRequestId >= accepted.historyRequestId`.
- Optimistic locks and pending drafts are invalidated upon history navigation via `boundaryListeners` in `historyNavigation.ts` and `optimistic.ts`.
- `mergeState.ts` preserves authoritative empty sends arrays; `StructuralSnapshotOrder` enforces monotonic revision sequencing across HTTP/WS.
- Native tests `test_project_history.cpp` (11 cases / 76 assertions passed); UI tests `historyNavigation.test.ts` (7 tests passed), `mergeState.test.ts` (2 tests passed), `structuralOrder.test.ts` (4 tests passed).

