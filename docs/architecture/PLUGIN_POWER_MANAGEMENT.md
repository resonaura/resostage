# Conservative plug-in power management

Status: tracker/isolated-host ownership hardening is implemented, with indexed
all-song lookahead added on 2026-10-01. Heavy-project acoustic acceptance remains
broader work; synthetic timings must not be promoted to vendor guarantees.

## Purpose

Inactive chains should avoid unnecessary DSP without unloading live vendors,
cutting tails, resetting sampler state, or making the device callback wait.
Correctness and stable ownership take priority over average CPU savings.

The implementation is in `core/engine/plugins/PluginPowerManager.h/.cpp`, with
graph-facing integration in `core/app/plugins/PluginProcessorBank.cpp` and
lookahead in `core/app/engine/AudioEngineEventDispatch.cpp`. The isolated helper
owns live vendor DSP. Mutating a Core proxy's tracker alone must not be treated
as control of the corresponding remote vendor instance.

## Current tracker behavior

| State | Meaning in the tracker |
| --- | --- |
| `Active` | Input/MIDI activity requests processing and resets decay accounting. |
| `Quiescent` | No input/event activity; processing continues while the output envelope/tail is observed. |
| `Suspended` | Processing may be skipped after quiet output remains below the configured threshold for the required tail interval. The vendor instance stays allocated. |
| `Parked` | Explicit processing-disabled state. This implementation does **not** serialize/unload the vendor instance. |

The defaults are a -90 dBFS silence threshold and a five-second fallback tail.
Actual vendor tail information and guard flags determine eligibility. The
tracker enters quiescence when input/events disappear; an eight-bar idle delay
is not implemented by the tracker even though a configuration field exists.

Keep-awake, never-suspend, infinite-tail, armed-track, and live-monitor flags
guard automatic suspension. Do not infer vendor noise-generation heuristics or
arrangement readiness solely from catalog names. Waking a retained instance is
a state edge, not a verified numerical latency guarantee.

## Ownership and live-host boundary

The tracker now keeps follower/quiet-sample accounting and published state on
the DSP writer. Any-thread controls publish atomic guard values and coalesced
intents; they do not touch ordinary DSP counters. Explicit park survives input
or prewarm and requires explicit unpark. No blocking lock was added.

Host ABI v7 adds 128 fixed per-slot latest-wins power mailboxes and helper-owned
power-state atomics, separate from the parameter queue. Keep-awake/park/unpark/
wake and paired record-arm/input-monitor/bypass controls reach the owning child;
predictive prewarm uses one coalesced chain flag. Core track setters update the
active proxy bank immediately, while new isolated chains receive the initial
R/I guards through their private project snapshot. These control changes do not
recreate a healthy vendor instance.
The helper consumes intentions at its next DSP block and publishes actual state.
There is no extra poll worker or OS wake for power control. Mailbox producers
cap concurrent CAS attempts at eight and count a rejected newest intention.
Paired bypass, record-arm and input-monitor enable/disable share these mailboxes:
normal On/Off and R/I changes do not compete with parameter events. Reuse
identity ignores these mutable guards and synchronizes their requested values
to a reused healthy helper, so history or routing edits do not reload its vendor
chain. Existing JUCE
`processBlockBypassed` semantics remain the DSP policy.
Read the matching current `PluginHostProtocol.h`; old helpers fail ABI validation.

The current ABI is8. In addition to the version7 power mailboxes, it publishes
bounded latest parameter values for reliable automation discovery. This does not
move vendor parameter enumeration or state capture onto the Core audio callback.

These are source-verified ownership/protocol changes, not a completed
performance/device validation claim. The current task records focused results.

The standalone manager's lookahead helper still walks project regions/lanes
and uses dynamic containers; it is not suitable for a device callback. The live
engine instead prepares `ProjectActivityIndex` off audio: merged half-open
intervals, prebound strip IDs, and an owned TempoMap per song. Callback work
queries only hosted chains and never traverses raw regions. Preparation limits
are 4096 songs, 1,048,576 audio/MIDI regions, 65,536 plans and 65,536 tempo points.
A rejected/missing index conservatively keeps all admitted live chains awake,
without a fallback scan. These are item-count limits, not a fixed byte-budget.

Faders/pans, processor-only edits and locator drags reuse the publication;
content/history/tempo, epoch, routing layout and device-rate changes prepare a
replacement. Gapless song hops take a row/map from that same all-song owner.
Retirement checks both publication references and nested map readers; separate
message-thread owners cover standalone maps when preparation is unavailable.
The active map is rebound on replacement, not only song selection.

Repeated predictive wake requests remain deliberate. Wake-on-entry alone can
let a short-tail vendor suspend again before a long lookahead horizon ends.
One coalesced request per intersecting hosted strip preserves current timing
without a project-size scan. Future lease/edge protocol changes need tests.

## Future work, not shipped guarantees

- True parking with bounded state capture, instance unload, and background
  reload requires a separate lifecycle design. Current `Parked` only skips DSP.
- Predicted warm-up/priming must be tested against AU/VST3 samplers, generators,
  and effects; “two bars ahead” is a policy, not proof that every vendor is ready.
- Idle helper timers and dense helper scheduling need measured weak-machine
  workloads. Do not promise a fixed resume time or percentage CPU saving.
- UI/telemetry should expose remote power state and packet-drop diagnostics,
  not only an intent kept in a proxy object.

## Verification

`core/tests/test_plugin_power_manager.cpp` covers tracker guards, decay,
suspension, and lookahead foundations. Host/processor tests cover the separate
IPC boundary. Add concurrent control/DSP tests and real helper transitions when
changing ownership. Record actual helper count, sample rate, nominal block
size, vendor chain, callback wall/CPU distributions, misses, and idle CPU before
making performance claims.

See [PLUGIN_HOSTING.md](../PLUGIN_HOSTING.md),
[PLUGIN_FAILURE_CONTAINMENT.md](../PLUGIN_FAILURE_CONTAINMENT.md), and the
current [performance task](../ai/tasks/performance.md).
