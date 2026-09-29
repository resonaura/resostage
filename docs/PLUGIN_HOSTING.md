# Plug-in discovery and hosting status

ResoStage currently ships the safe discovery foundation for audio plug-ins.
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

Audio crosses a versioned shared-memory ABI with three ownership-tracked audio
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

This is crash/hang containment, not a security sandbox: the helper has the
user's normal OS permissions. The scanner process remains a separate discovery
boundary. Offline renderer failures are also not contained by this live-host
guarantee. Protocol limits, lifecycle details, verification coverage, and
remaining integration tests are documented in
[PLUGIN_FAILURE_CONTAINMENT.md](PLUGIN_FAILURE_CONTAINMENT.md).
