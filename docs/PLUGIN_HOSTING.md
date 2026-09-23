# Plug-in discovery and hosting status

ResoStage currently ships the safe discovery foundation for audio plug-ins.
The Settings → Plug-ins screen scans VST3 on every desktop platform and Audio
Units on macOS, shows progress, allows incremental or full rescans, and lists
the resulting catalog and quarantine count.

## Why scanning is a separate process

Enumerating a plug-in loads vendor code. A malformed binary can crash, hang,
allocate heavily, or initialize hardware before ResoStage has created a DSP
instance. The live Core therefore launches the packaged
`resostage-plugin-scanner` helper. A helper crash cannot stop audio, lighting,
or remote control. JUCE's dead-man's-pedal records the item being inspected;
the next scan quarantines it and proceeds with the remaining candidates.

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

## Current boundary

Discovery is implemented; inserting catalog entries into tracks/buses/master,
running vendor DSP, restoring serialized states, and compensating plug-in
latency are a separate stage. Until that processor-bank layer is complete,
the catalog is informational and no discovered plug-in is placed in the live
or offline signal path. This boundary is intentional: sharing a stateful live
`AudioPluginInstance` with the offline renderer or destroying one on the audio
callback would violate ResoStage's real-time contract.
