# Loading, history, and current acceptance evidence

Recorded 2026-10-01. Completed implementation plans were removed from
`docs/ai/tasks`; this reference preserves their findings and verification.

## Authoritative plug-in loading

`PluginLoadingSession` owns epoch/generation-scoped per-slot progress and
terminal states. Play/Record requests gate in Core and retain explicit pending
intent, cleared by Stop or project replacement. Partial/missing/timed-out vendor
loads require an explicit degraded continuation; retries are bounded. Healthy
compatible old banks may continue during an insert edit, but cannot impersonate
new selected slots or cross a project epoch.

Structural state publishes real loading status. Shared `PluginLoadingDialog`
offers Keep stopped, Retry loading and Continue with available. Slot controls
distinguish loading, loaded, bypassed and failure, rather than claiming that an
accepted Add command means the vendor has finished restoring state.

Completed native/UI tests cover generation supersession, failures, transport
intent, loading views and slot controls. See [hosting](../PLUGIN_HOSTING.md)
and [containment](../PLUGIN_FAILURE_CONTAINMENT.md) for current boundaries.

## Reliable shared history

Reproduced causes and fixes:

- Snapshot before destructive vector compaction; missing-ID deletes stay no-op.
- One owner for send transactions; close gesture IDs on history navigation so
  a later edit cannot coalesce into a replayed entry or keep its redo branch.
- HTTP queue admission is not mutation completion. `WHistoryAccepted` carries
  request/session IDs, and UI waits for a confirming authoritative revision.
- Reject out-of-order structural HTTP/WS snapshots, invalidate optimistic locks
  and drafts on history boundaries, and preserve explicit empty send arrays.

Core's message thread remains the history writer; the UI has no parallel
project history. Tests cover deletion round trips, branching, accepted/applied
correlation, draft invalidation, explicit empties and structural ordering.

## This pass

- A full optimized native run after the owned streaming-head-fill fix passed
  520 cases / 214,939 assertions, no skipped cases. This predates the subsequent
  PDC/MIDI activity changes; their acceptance must be reported separately.
- UI before the later routing-map/recording additions: 82 files / 513 tests.
  Electron: 31 tests plus 2 emitted-alias/runtime checks. These are dated suite
  results, not evidence for every subsequently edited feature.
- Production HTTP offline render produced and decoded non-silent files in
  WAV, AIFF, FLAC, ALAC/M4A, MP3, AAC/M4A, Opus, Ogg Vorbis and WMA. The private
  fixture has its own settings/project/export directory, not the user's rig.
- UI visual/export checks are available in `ui/scripts/dialogs-smoke.mjs`;
  production format acceptance in `scripts/media/acceptance.mjs`.
- Windows grouped-path discovery and Electron compilation are tested locally;
  the new `core/` package layout is not yet a live Windows runtime acceptance.

Do not infer arbitrary heavy-vendor dropout elimination, hardware support, or
sample-accurate vendor automation from these unit/synthetic tests. Remaining
work stays in current task files and explicitly dated benchmark reports.
