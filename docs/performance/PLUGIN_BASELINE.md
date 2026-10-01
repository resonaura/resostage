# AU/VST3 packet preparation baseline

Date: 2026-09-30. These are recorded results from the first focused host
optimization pass, not a fresh end-to-end device benchmark or a guarantee for
all vendors/heavy projects.

## Environment and workload

- macOS Apple Silicon `MacBookPro17,1`, eight physical cores, 8 GiB RAM.
- Optimized `RelWithDebInfo` native build.
- Synthetic domain graph: eight audio tracks, two send buses, one main,
  48 kHz, 64/128/256/512/1024-frame trials.
- Packet microbenchmark: 20,000 prepared 512-frame iterations for each MIDI
  density, former and new algorithms in the same binary.

The renderer/domain baseline cost 1.264 / 2.269 / 4.696 / 8.566 / 16.967
microseconds at those five sizes. Eight synthetic inserts at 256 frames cost
3.951 microseconds. These values do not include arbitrary vendor DSP,
32-helper scheduling, callback p99, device underruns, or a heavy user project.

## Verified first-pass changes

- `PluginMIDIBuffer` prepares 11,264 JUCE bytes: 512 events × (16 payload bytes
  + six framing bytes). Live oversized/newest overflow events are rejected
  before storage growth and counted for the bank lifetime. Complete channel-wide
  panic bursts take precedence over queued musical events.
- Core and helper banks retain the fixed 512-event/16-byte live IPC limits.
  Offline non-realtime banks explicitly permit full SysEx/growing buffers;
  that mode is never a live callback policy.
- Strip-owned MIDI scratch uses non-owning JUCE metadata views and writes only
  accepted entries. Long SysEx is rejected before an owning `MidiMessage`
  could allocate. Sample positions, packet bounds, and unused padding remain
  count-gated by the protocol.
- Instrument presence is prepared once, rather than rescanning chain nodes in
  callback fallback/MIDI dispatch. Generator activity avoids irrelevant input
  scans; effects still observe preceding output when needed.
- The DSP worker no longer makes a parent-liveness OS call on every audio
  wake. Startup validation, independent 250-ms watchdog, and message-thread
  supervision remain intact.
- This pass did not change IPC ABI, nominal latency, PDC, vendor restore,
  audio/control queue semantics, or helper ownership.

## Packet preparation comparison

| Events per block | Former clear + owning iterator | Prepared non-owning views |
| --- | --- | --- |
| 0 | 0.1772 µs | 0.0021 µs |
| 4 | 0.1787 µs | 0.0216 µs |
| 512 | 4.6017 µs | 2.6206 µs |

Domain routing after the change remained consistent: 1.154 / 2.280 / 4.376 /
8.640 / 17.073 microseconds for the same five block sizes. The comparison
isolates packet preparation; it is not a measurement of acoustic dropout
elimination or host wake tail latency.

## Recorded verification

After the optimized host/test build finished, focused commands passed:

```sh
core/build/tests/resostage_engine_tests --test-suite='PluginPerformance,PluginPowerManager,PluginHardening' --no-colors=true
core/build/tests/resostage_engine_tests --test-case='plug-in host*,isolated*,offline plug-in MIDI*' --no-colors=true
```

Results: 16 cases / 873 assertions and 15 cases / 4,939 assertions respectively.
The actual local AU instrument/effect, Voxengo MSED VST3 output, and editor cases
ran without fixture-skip messages. Focused dense-MIDI tests cover fixed storage,
reuse, invalid packets, raw views/padding, panic priority, and offline SysEx.

Further work is owned by [the current performance task](../ai/tasks/performance.md):
cross-thread power intents, actual helper power state, indexed lookahead,
drop-counter UI telemetry, helper idle timers, and realistic dense/heavy
project measurements. The dated results above must not be silently promoted
to evidence for those later changes.
