# Plug-in discovery and hosting status

ResoStage ships separate discovery and live-host process boundaries for audio plug-ins.
The Settings → Plug-ins screen scans VST3 on every desktop platform and Audio
Units on macOS, shows progress, allows incremental or full rescans, and lists
the resulting catalog and quarantine count.

## Why scanning is a separate process

Enumerating a plug-in loads vendor code. A malformed binary can crash, hang,
allocate heavily, or initialize hardware before ResoStage has created a DSP
instance. The live Core therefore launches the packaged
platform-branded plug-in scanner helper. A helper crash cannot stop audio, lighting,
or remote control. JUCE's dead-man's-pedal records the item being inspected;
the next scan quarantines it and proceeds with the remaining candidates.
Core also enforces a 60-second no-progress watchdog, so a plug-in that hangs
rather than crashes cannot leave discovery running forever; the same
dead-man entry identifies it on the next scan.

Catalog files live in the platform application-data directory under
`ResoStage/Plugins`. The XML registry is JUCE's canonical discovery data. The
JSON catalog and scan-state file are read-only projections for the application
and UI. Completed files replace their predecessors atomically, so a crash does
not publish a half-written registry.

## Control API

- `GET /api/v1/plugins/list` returns `{ scan, catalog }`. The catalog contains
  plug-in identity, vendor, format, category, version, channel counts, and the
  dead-man blacklist.
- `POST /api/v1/plugins/scan` with `{ "rescanAll": false }` scans only new or
  changed binaries. Set it to `true` for a full rescan.
- `POST /api/v1/plugins/scan/cancel` requests cooperative scan cancellation.
- `POST /api/v1/plugins/enabled` updates device-local catalog enable preferences.

Scanning begins only on an explicit operator request, not application startup.

Only one scan may run at a time. Core stops its helper on shutdown. Catalog
data is deliberately absent from live telemetry because it can be large and
does not change at frame rate.

## Live hosting boundary

Core owns routing and publishes a graph-facing asynchronous
`PluginProcessorBank`; actual live AU/VST3 instances run in the packaged
platform-branded plug-in host, one helper per serial strip chain (up to 32). Empty
chains do not launch helpers. Same-project rebuilds reuse unchanged healthy
helpers, while whole-project replacement invalidates all prior helpers by
project epoch. Native plug-in editors run in their owning helper. State capture
is requested off the callback and the resulting bounded blobs are copied back
into the normal project save. Offline renders continue to use a separate
in-process bank and do not share live instances.

Audio crosses version-6 shared-memory ABI with three ownership-tracked audio
slots, a fixed-capacity audio plane, and a bounded MIDI/control protocol. The
Core callback never waits for the host or does process/filesystem work. The
two-callback pipe is included in PDC using nominal device block quanta plus
reported plug-in latency. If a response is missing, effects fall back to their
dry input and instruments output silence for that block. A non-realtime
watchdog detects dead/stalled helpers and allows one automatic restart per
chain/document; further retries are explicit.
Runtime latency changes are sent back through shared atomics and rebuild only
the delay-compensation plan; sample-rate or shared-buffer-capacity changes
prepare a new helper.

Fixed per-slot power/bypass mailboxes and helper-owned state atomics carry keep-awake,
park/unpark, wake, and On/Off without filling the parameter queue. Bypass edits
reuse healthy helpers instead of recreating vendors. Predictive prewarm
is coalesced at chain scope. Power state is consumed/published by helper DSP;
explicit parking skips processing but does not unload the instance.

This is crash/hang containment, not a security sandbox: the helper has the
user's normal OS permissions. The scanner process remains a separate discovery
boundary. Offline renderer failures are also not contained by this live-host
guarantee. Protocol limits, lifecycle details, verification coverage, and
remaining integration tests are documented in
[PLUGIN_FAILURE_CONTAINMENT.md](PLUGIN_FAILURE_CONTAINMENT.md).

## Project loading and slot readiness

Opening a document exposes its content immediately, but Core keeps its new
transport stopped while the generation-scoped processor bank is prepared.
`pluginLoading` in `/api/v1/state` carries project epoch, build generation,
`idle`/`loading`/`ready`/`degraded`/`failed` phase, playback/dialog flags, pending
Play intent, completed/total/failed slot counts, current name, and a bounded
error string. These are runtime state, not project-file fields. Completion
counts measure prepared slots, not elapsed-time percentages. A matching final
bank publication, not partial vendor progress, releases the fresh document.

Play requests made during loading are held by Core and may start after readiness;
Stop clears that intent. Record is blocked and is not automatically resumed as
a queued recording. Missing vendors, startup timeouts, restoration errors, or
bank-build exceptions produce terminal failure information instead of an
indefinite spinner. The modal offers retry, keep stopped, or explicit continue
with available plug-ins. Keeping stopped dismisses the current modal without
authorizing playback; a later Play request exposes it again if the gate remains
closed. Continue uses the ordinary unavailable-effect dry/instrument-silence
fallback. Retry is an operator decision, not an unlimited automatic respawn.

`POST /api/v1/plugins/loading/decision` receives `{ epoch, generation, decision }`
with `continue`, `stop`, or `retry`. Stale decisions/progress cannot dismiss or
unlock another document/generation. The shared shell modal is keyed by the same
identity and disables decisions while disconnected. The audio callback never
reads the loading session's mutex or waits on vendor initialization.

Each slot separately exposes `loading`, `loaded`, `missing`, or `failed`, plus
its load error; persisted bypass and actual power state are distinct. Loading
slots show a spinner, unavailable slots show a warning, and only loaded slots
allow opening an editor. Same-project insert edits retain a compatible old bank
for continuity and report per-slot progress without reopening the fresh-document
modal. A continuity-only old bank is not presented as the new slot's ready
processor. Project epoch or incompatible layout/rate/capacity rejects that bank.

Focused state-machine, stale-generation, and slot-presentation tests are being
run with the current changes; real heavy-project/vendor acceptance is separate.

## Prepared MIDI and performance evidence

Live ingress reserves 11,264 JUCE bytes for the fixed 512-event/16-byte protocol.
Newest oversized/overflow events are rejected before growth; full channel-wide
panic bursts take precedence over music. Raw event views avoid temporary owning
SysEx allocations. Offline non-realtime banks deliberately retain larger
SysEx/growing buffers. Generator presence and packet scratch are prepared with
the chain rather than rebuilt/scanned every callback.

See [the dated packet benchmark](performance/PLUGIN_BASELINE.md) for measured
scope, local AU/VST3 fixtures, and limits. Power ownership/remote state and
realistic heavy-project verification remain distinct from that microbenchmark.
