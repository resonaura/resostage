# ResoStage Engineering Guide for AI Agents

This file is the architectural contract for the repository. Read it before
changing code. It describes the system that exists, the reasons behind its
real-time behaviour, and the invariants a change must preserve. Prefer the
implementation and tests when they disagree with prose, then update this file
as part of the same change.

Any AI agent may update this file at any time, but only for a material change:
a real change to architecture, ownership, thread or process boundaries,
real-time invariants, protocols, persisted schema, build/deployment topology,
or the verification workflow required to keep those guarantees. Do not churn
`AGENTS.md` for routine implementation details, local refactors, renamed
private helpers, formatting, or speculative future designs. Every edit must
describe behaviour that is already implemented in the same change and is
important for the next agent to work safely.

## 1. Product and deployment model

ResoStage is a live-show playback, routing, metering, MIDI/event, and lighting
system. It is deliberately split into three layers:

1. **Core** (`core/`) owns authoritative state and all time-critical work:
   audio devices, transport, streaming, mixing, project data, MIDI, DMX,
   lighting, HTTP control, and telemetry production.
2. **Electron shell** (`electron/`) owns the desktop window and native OS
   integration. It launches or connects to Core, proxies reliable commands,
   receives UDP telemetry, and exposes a narrow preload API to React.
3. **React UI** (`ui/`) edits and visualizes state. It is never the transport
   authority and must not be required for audio, events, or lighting to keep
   running.

The normal local application is still two processes:

```text
ResoStage Electron shell
  |-- HTTP/TCP commands ----------> local Core :2899
  |-- UDP telemetry <------------- local Core
  `-- renders ui/dist

Core
  |-- audio callback -> physical outputs
  |-- streaming workers -> bounded audio rings
  |-- event worker -> MIDI / HTTP / Art-Net DMX
  `-- lighting worker -> resolved lighting frames
```

The primary remote mode uses the same API with Core on another computer:

```text
controller computer                         playback computer
Electron + React -- HTTP/TCP :2899 --------> Core (authoritative state)
                 <---- UDP selected port --- Core (live telemetry)
                 <---- UDP :28991 ---------- discovery announcements
                                               |-- audio hardware
                                               `-- MIDI / DMX / lighting
```

The playback computer is authoritative. A controller must not start a local
Core while attached remotely. Browser control remains a fallback, but native
desktop remote is the performance target. “Telemetry over UDP” means sampled,
latest-wins live state. Commands such as Stop, Save, routing edits, and fader
changes intentionally use HTTP/TCP because delivery and ordering matter.

UI production builds write into `ui/.dist-staging`, copy newly generated assets
into `ui/dist`, then atomically replace `ui/dist/index.html` last. Do not clear
the live `ui/dist/assets` directory during a build: an already-open Electron
renderer can still be requesting content-hashed chunks referenced by its
previous HTML document. Old hashed assets are retained so those requests can
finish while Core serves the new entry point. Electron also watches its own
static asset responses and performs at most two delayed cache-bypassing
reloads after same-origin 404s; this is a recovery path, not a substitute for
publishing a complete UI build.

On macOS the assembled Electron shell, nested Core app, helpers, frameworks,
and native modules are signed bottom-up with one named identity. This stable
designated requirement is required for persistent microphone/TCC consent;
installer scripts must never re-sign the installed app. Publish/release probes
the identity and fails if it cannot really sign or if deep verification fails.
Local `app`/`dev` assembly first accepts the repo-private self-signed identity
created by `pnpm codesign:setup-local`; its key and keychain remain under the
ignored `.resostage-local-signing/` directory and require no Apple account.
If neither that identity nor another usable identity exists, development
falls back to ad-hoc signing with a visible warning; microphone consent is not
expected to survive those ad-hoc rebuilds. Publish/release remains strict
because a self-signed identity is not a distributable Gatekeeper identity.
Setting `RESOSTAGE_CODESIGN_IDENTITY=-` requests the ad-hoc fallback explicitly.

See `docs/REMOTE_CONTROL.md` for operator setup and the two-machine test.

## 2. Repository map

| Path | Responsibility |
| --- | --- |
| `core/engine/` | Mostly JUCE-free domain and DSP code: audio graph, streaming primitives, timing, events, project schema, telemetry. |
| `core/app/` | JUCE/application integration: audio device callback, Core lifecycle, HTTP/WebSocket server, discovery, MIDI and platform code. |
| `core/app/plugins/` | Device-local plug-in discovery. Core owns the catalog service; an embedded helper process is the only code allowed to load untrusted plug-ins while scanning. |
| `core/tests/` | Native unit, stress, protocol, routing, streaming, and renderer tests. |
| `electron/src/` | Desktop main process, preload bridge, UDP receiver, discovery, platform integration. |
| `ui/src/` | React screens, hooks, telemetry decoders, and presentation components. |
| `ui/src/components/ui/` | The design-system boundary around HeroUI. Change shared component behaviour here instead of patching call sites. |
| `scripts/` | Cross-platform build, assembly, migration, release, and remote verification. |
| `docs/` | Operator-facing details that do not belong in this architectural contract. |

Important starting points:

- `core/app/engine/AudioEngine.h` and the `AudioEngine*.cpp`/`*.h` split
- `core/engine/audio/graph/MixGraph.h`, `MixRenderer.h`, and `RoutingEngine.h`
- `core/engine/audio/streaming/StreamingEngine.h` and `AudioRingBuffer.h`
- `core/engine/timing/MasterClock.h`
- `core/app/server/WebServer.h` and `.cpp`
- `core/app/main/MainComponent.cpp`
- `electron/src/main.mts`, `udpTelemetry.ts`, and `discovery.ts`
- `ui/src/lib/state/useLiveState.ts` and `ui/src/lib/audio/liveLevels.ts`
- `core/engine/project/ProjectSchema.h` and `ProjectLoader.h`

## 3. Ownership and thread model

Thread ownership is part of the design, not an implementation detail.

| Context | Owns/does | Communication rule |
| --- | --- | --- |
| Audio callback | Advances the sample render counter, consumes prepared streams, renders one immutable mix graph, fires due event requests, publishes meters/health. | Atomics, immutable snapshots, SPSC rings, bounded queues, and `SeqLock`. No blocking. |
| JUCE message thread | Applies commands, mutates the live `Project`, rebuilds routing, controls transport, takes publish snapshots. | The only normal mutator of project/application state. Publish new immutable state to workers. |
| Streaming workers | File I/O, WAV decode, resampling preparation, and ring refill. | Produce into fixed-capacity SPSC rings consumed by audio. Never make audio wait. |
| WebServer/libwebsockets thread | HTTP/WS I/O, request parsing, response writing, UDP telemetry sends. | Enqueue `WebCommand`; never call JUCE or mutate `AudioEngine` directly. |
| EventDispatcher worker | Slow HTTP output and DMX/Art-Net delivery; scheduled MIDI/event dispatch. | Audio/light producers use bounded lock-free queues. Overflow behaviour must stay explicit. |
| LightEngine worker | High-priority fixed-rate cue/effect resolution. | Reads `MasterClock` and an immutable project snapshot; queues output to EventDispatcher. |
| Offline render worker | Independent non-realtime render from a project snapshot. | Must not borrow mutable live state, stop transport, or enter the device callback. |
| Plug-in scanner helper | Enumerates VST3 and platform AU binaries and atomically publishes a device-local registry/catalog. | Separate process launched by Core; a third-party crash cannot unwind through playback. Dead-man's-pedal quarantines the item active at failure. |
| Live plug-in host helper | Owns the live AU/VST3 instances for one serial strip chain, its DSP, state capture, and editor windows. | Separate child per chain; fixed shared-memory audio slots and bounded control queue. Core's callback never waits for the child. A watchdog outside audio kills a stalled/dead helper; one automatic restart is allowed per strip/project epoch. This is crash containment, not an OS sandbox. |
| Electron main | Core process orchestration, native UI, discovery, HTTP proxy, UDP validation. | Renderer receives only validated/coalesced data through preload IPC. |
| React renderer | User interaction and visualization. | Treat all state as a view of Core, never as the real clock or show authority. |

The intended priority order is audio first, then lighting/event scheduling, then
UI/network/background work. Do not fix UI latency by moving work onto a
real-time thread.

### Keyboard and track-selection ownership

`ui/src/lib/interaction/HotkeyManager.ts` is the renderer's single keyboard
dispatcher. UI components register scoped commands there instead of installing
independent application-level `keydown` listeners. The Electron main process
may capture native window key events, but it forwards configured action IDs to
the renderer; it does not execute those actions itself. Browser and Electron
shortcuts therefore enter the same dispatcher. User-rebindable global actions
remain persisted in Core `AppSettings` and are validated by
`core/app/main/ActionCatalogue.h`. Fixed editor gestures are typed, scoped
commands and are deliberately absent from the rebindable/MIDI action catalogue.
While Settings learns a key, shortcut dispatch is suspended; while Musical
Typing is active, bare keys are reserved for note input and modified commands
remain available. MIDI learn is restricted to transport/navigation and
continuous performance controls. Previous/next-bar defaults use comma/period,
not the arrow keys used by note and editor navigation.

Shared React context-menu items can declare the same scoped command or
rebindable Core action as their keyboard shortcut; the menu shell displays that
binding in DOM menus and sends a platform accelerator to Electron menus.
Electron-native labels must escape literal ampersands because Electron treats
single `&` characters as mnemonic markers on Windows/Linux.

Core `TrackDef::recordArmed` and `TrackDef::inputMonitoring` are the authoritative
R/I states shown by every surface. Selecting a track updates the focused track;
an assigned focused audio input is monitored ephemerally, and focused MIDI
input is auditioned, without changing either persisted R/I flag. Explicit
monitor subscriptions on other tracks remain intact when focus changes. In the arrangement, Shift-click selects the
contiguous range from the selection anchor; Command-click on macOS or
Control-click elsewhere toggles an individual track.

Recording count-in length is a device preference (`AppSettings`, 0–2 bars,
defaulting to one), not project content. The last nonzero length is persisted so the
transport Count-In toggle restores it after being switched off. The same Core
setting is edited by Audio Settings and the transport button's context menu.
When enabled and Record is pressed while stopped, Core
starts transport at the preceding complete bar boundary (including negative
sample positions before song start), but keeps audio/MIDI capture gated until
the original cursor or auto-punch capture boundary. The callback applies that
gate at sample offsets; file/session preparation remains on the message thread.

## 4. The real-time audio path

`AudioEngine::audioDeviceIOCallbackWithContext()` is the deadline-critical
path. At a high level, each block does this:

1. Enable flush-to-zero so recursive DSP and meters do not enter slow denormal
   arithmetic during silence.
2. Start whole-callback wall-time and thread-CPU timing.
3. Clear device outputs, normalize the platform host timestamp, and advance
   the hardware sample counter.
4. Publish cheap transport/health atomics.
5. If stopped, emit the prepared declick tail, publish meter silence, and
   return.
6. Acquire exactly one `MixGraph` snapshot for the entire block.
7. Attempt the routing guard without waiting. Failure emits a silent block and
   increments health telemetry.
8. Acquire the active staged song and fire events whose time falls in the
   block. Non-RT work is queued elsewhere.
9. Pull each required track once from its stream into preallocated scratch,
   then apply region boundaries/fades/playback treatment.
10. Run one forward `MixRenderer` sweep through flat sparse graph edges,
    including track, click, send, main, and physical-output lanes.
11. Publish bounded meter/envelope data and copy physical lanes to device
    outputs, applying recovery/song-end fades as required.

The sample-accurate audio position while playing comes from
`hwSamplePosition`, not a UI timer and not the wall-clock projection. Stems and
the mathematical click therefore use the same sample index. `MasterClock`
also maintains a drift-corrected monotonic projection so MIDI/DMX scheduling
and telemetry continue advancing if the device callback temporarily stops.

Project-cycle playback uses a half-open `[left, right)` sample range. Enabling
a loop marks the active song's buffers as priority random-access material for
the resident worker. Once resident, the audio callback splits a hardware block
that crosses `right`, renders its remainder immediately from `left`, and uses
absolute modulo sample arithmetic rather than an accumulated floating phase.
This path must not perform a message-thread seek, stream handoff, global MIDI
all-notes-off, or allocation. Only sequenced notes that cross the locator are
released; independently held live-input notes remain active.

Host timestamps must be in the same nanosecond epoch as
`SystemMonotonicClock`. In particular, JUCE/CoreAudio exposes raw Mach ticks
through a misleadingly named field; always use `ticksToNanos()` before mixing
that value with monotonic nanoseconds.

### The actual non-blocking guarantee

Do not describe the callback as academically 100% lock-free. It uses atomic
`shared_ptr` snapshot acquisition and currently performs a `try_lock` on the
routing mutex. The important operational guarantee is **bounded and
non-waiting**: it never waits for the mutex. If state is being restaged, the
callback services the driver with silence and records a silent block instead
of missing the hardware deadline.

Never turn that `try_lock` into a blocking lock. Conversely, do not replace the
atomic `shared_ptr` with a hand-written raw-pointer/hazard scheme: previous
attempts had real use-after-free failures caught by the routing concurrency
tests. Correct lifetime reclamation is more important than removing one
atomic reference-count operation.

## 5. Why it performs well in real time

The design removes unbounded latency from the deadline path:

- **No disk or network I/O in the callback.** Workers decode ahead into
  `AudioRingBuffer`, a cache-line-separated, fixed-capacity SPSC planar ring.
  A short read becomes silence; it never blocks for refill.
- **No routine heap growth in the callback.** `MixRenderer`, per-track scratch,
  output lanes, sinc tables, meter state, and rings are prepared outside it.
  Capacity mismatch fails safely rather than resizing in place.
- **Immutable routing snapshots.** The message thread builds a complete flat
  `MixGraph` and atomically publishes it. One callback sees one graph, never a
  half-applied fader or route edit.
- **Sparse, cache-friendly mixing.** Only real edges are walked. A single
  canonical renderer applies fader, pan, mute, solo, sends, buses, click, and
  physical egress rather than duplicating signal logic.
- **Single-writer state exchange.** `SeqLock<T>` gives the audio writer a
  wait-free copy for multi-field telemetry; readers retry only a bounded four
  times and keep their previous sample on contention.
- Resize, clear, or replace callback-read track state (including band-meter
  processors and their filter vectors) only while holding `routingMutex`.
  The callback's `try_lock` then sees a complete state or emits a bounded
  silent block; never mutate these vectors beside it.
- **Atomics for scalar telemetry and intent.** Playhead, running state, drift,
  pending actions, and health counters do not require a cross-thread lock.
- **Bounded producer queues.** Audio and lighting enqueue network/event work;
  a slow endpoint cannot propagate back into the callback.
- **Latest-wins live telemetry.** UDP avoids TCP head-of-line blocking. Old,
  duplicated, reordered, malformed, and wrong-source datagrams are discarded.
- **Coalesced UI work.** Structural state is applied at animation-frame pace;
  meter frames remain high-rate so short peaks are not erased by React render
  scheduling.
- **Measured failure modes.** Callback wall/CPU histograms, underruns, silent
  blocks, stream depth, sequence loss, and jitter distinguish CPU overload,
  scheduling stalls, restaging, I/O starvation, and network loss.

`RelWithDebInfo` is the default native build because unoptimized per-sample DSP
can consume roughly several times more CPU and gives misleading performance
results. Use an explicit Debug build only for debugging, never for latency or
load conclusions.

## 6. Mixing and routing invariants

`MixGraph` is a precomputed DAG flattened into strips and forward edges.
`RoutingEngine` publishes immutable graphs; `MixRenderer` performs one forward
sweep using buffers allocated by `prepare()`.

Preserve these rules:

- Tracks, metronome, send buses, main, and physical outputs use the same graph
  model and renderer.
- The project's metronome enable preference gates click sample generation, not
  the click strip's mute/routing state. Record count-in temporarily generates
  the click even when that preference is off, ending at the capture boundary.
- A track stream is consumed only once per callback even if it feeds several
  buses. Fan-out happens after the source block is in scratch memory.
- Track/click solo is one group; send-bus solo is a separate group. Do not
  infer or duplicate this logic in UI code.
- `SendTap` routing (`PreFader`, `PostFader`, `PostPan`) and main/bus/ext-out
  routing semantics are defined by `ProjectSchema.h` and graph construction:
  - `PreFader`: Taps signal post-insert FX and polarity conditioning, bypassing fader, mute, and pan.
  - `PostFader`: Taps signal post-fader and post-mute, pre-pan.
  - `PostPan`: Taps signal post-fader, post-mute, and post-pan (stereo distribution to destination bus).
  Change schema, builder, renderer, serialization, UI, and tests together.
- Track pan law is persisted per track (`0dB` legacy balance, `-3dB` constant power,
  `-4.5dB` broadcast, or `-6dB` constant voltage). Missing values resolve to the
  legacy balance law; format v7 plus `scripts/migrate.mjs` preserves old mixes.
  The single `MixRenderer` pan-coefficient path applies the selected law to live
  and offline rendering.
- Polarity inversion (`PolarityMask { None = 0, Left = 1, Right = 2, Both = 3 }`):
  Applied at strip input conditioning in `MixRenderer` before insert plug-in chains
  using smooth 32-sample glide to prevent declick artifacts. The real-time timeline
  and mixer waveform canvas mirrors active polarity state by vertically inverting rendered
  peaks (`maxV = -minV`, `minV = -origMax`).
- Hardware audio input configuration:
  `AppSettings` persists `inputDeviceName` and `activeInputChannels` bitmap.
  `MainComponent` computes and publishes full hardware latency breakdown
  (`inputLatencyMs`, `outputLatencyMs`, `roundtripLatencyMs`) served via
  `/api/v1/settings/audio-input-device` and `/api/v1/settings/input-channels`.
- Mixer layout & dynamic ergonomics:
  - Three switchable density modes: `Narrow (64px)`, `Standard (96px)`, and `Wide (128px)`,
    persisted in `localStorage["resostage:mixer-density"]`, with dynamically scaled faders, knobs, and meters.
  - Dynamic $N+1$ slot architecture: strips display only active plug-in inserts and send knobs
    plus a single `+ Add` slot to eliminate vertical clutter.
  - Logic Pro circular contour record arming button `[R]` with soft pulse when armed and
    solid red with white inner circle when actively recording.
  - Centralized DAW design tokens (`--rs-record`, `--rs-monitor`, `--rs-solo`, `--rs-mute`,
    `--rs-phase`, `--rs-send-pre`, `--rs-send-post`, `--rs-send-pan`).
- Timeline & track creation:
  - Software Instrument tracks (`kind: "instrument"`), Audio tracks (`kind: "audio"`), and
    Aux Buses created via `builder.trackAdd(songIndex, { kind, name, instrumentPluginId })`
    with default MIDI pattern generation.
  - Track header controls include track kind icons (`Music` vs `Mic`) and phase invert toggle `Ø`.
- Piano Roll track linkage:
  - Header explicitly displays active track badge with track color pill and switcher dropdown,
    plus region selector dropdown for switching the primary editable pattern. Other selected
    regions may be visible as non-editable ghost notes; the primary region is always visible.
  - Note bodies render using the track's color token (`getTrackColor(trackIndex)`), modulated
    by note velocity (dimmer at low velocity, vibrant at high velocity).
  - Selected notes are highlighted in bright Logic Pro amber `#ffd60a`.
- Coefficient changes are smoothed (approximately 10 ms) to avoid zipper
  noise. Do not bypass smoothing for a “faster” fader.
- Strip plug-in chains run post-input-sum and pre-fader through the flat
  `MixProcessorView` hook. The renderer remains JUCE-free; application-owned
  live/offline processor banks publish one pre-bound function/context entry
  per graph strip. Live AU/VST3 instances are in the platform-branded plug-in
  host, one helper per serial strip chain (bounded to 32 helpers); offline rendering
  still uses a separate in-process bank. Pre-fader sends include inserts but
  bypass fader/mute.
  Generator instruments are supported at track slot 0: during the audio
  callback, timeline MIDI events within the block are stamped with sample
  offsets and deposited into the strip's preallocated MIDI buffer before
  processing; the chain clears its MIDI buffer immediately after execution
  without heap allocation. Live input is copied into versioned fixed-capacity
  shared-memory slots and processed two callback quanta later to tolerate
  bounded helper scheduling jitter; Core applies those nominal quanta plus
  reported plug-in latency through normal PDC. The helper DSP worker receives
  a platform best-effort priority above UI/background work but below the
  device's real-time audio callback. The helper's DSP worker blocks on a
  process-shared semaphore/event rather than polling. Audio and non-realtime
  control workers have separate coalesced binary wake edges: audio submissions
  cannot create stale semaphore tokens, and parameter/state work does not wake
  the audio worker. Shutdown signals both workers before joining. Parent death
  is handled by an independent watchdog, so idle helpers consume negligible
  wake-loop CPU without sacrificing request latency.
  If a result misses its deadline, effects retain their dry input and instrument
  strips emit silence for that block. MIDI packets and host controls use bounded
  queues; rejected control events increment a health counter without marking a
  vendor processor faulted. Project saves request opaque vendor-state capture from the helper on
  the save worker; plugin processing continues while each node's state is
  captured, and Core copies capped state blobs back into `Plugins/<slot>.state`.
  User-originated parameter/program changes mark the project dirty; host
  automation is suppressed from that signal. Unchanged healthy chain helpers
  are reused across same-project edits at the same sample rate and buffer
  capacity. Dynamic plug-in latency notifications cross back through shared
  atomic telemetry and trigger a non-realtime PDC rebuild without restarting a
  healthy helper. Only changed/failed chains are rebuilt;
  project-epoch changes invalidate all old helpers. Editor windows live inside
  the corresponding helper.
  Intelligent power management (`PluginPowerManager`)
  monitors strip signal activity via preallocated envelope followers, automatically
  suspending processing during silence while preserving tail decay and waking up
  ahead of upcoming audio/MIDI regions. Software Instrument slot on instrument tracks
  provides dedicated AU/VST3 generator selection via categorized context menus grouped
  by manufacturer (with 'Open UI' and 'No Plug-in' removal options), and `pluginSlotAdd`
  atomically replaces existing slot 0 instruments or prepends them before existing audio insert FX.
- Processor-bank replacement during an insert-chain-only edit is latest-wins
  and non-disruptive: while the new bank is built, the callback may keep using
  the previous immutable bank only when project epoch, sample rate, block
  capacity, and ordered strip/edge routing-layout key still match. It keeps
  that bank's matching PDC plan too, then switches banks atomically when the
  replacement is ready. A plug-in bank build exception leaves the last
  publication intact; callback compatibility checks decide whether it is
  still safe to render. A project replacement or routing-topology change
  rejects the stale delay plan (and a project-epoch mismatch rejects the bank
  entirely). Inspector/editor state must identify a matching current bank,
  not display or open a continuity-only previous bank as the newly selected
  plug-in.
- A whole-document replacement has a monotonically increasing
  `AudioEngine::projectEpoch`. Every published `MixGraph`, asynchronous
  plug-in-bank request, and published bank carries that epoch; the callback
  accepts a bank only when its epoch and processor layout match the graph.
  Project replacement invalidates pending builds and never reuses vendor
  instances from the previous document, even when track/slot IDs coincide.
  Reopening the same logical project after Save or Import gates the callback
  but preserves its epoch, so unchanged plug-in nodes and their runtime state
  are reused instead of reloading the entire chain.
  The replacement scope prevents callbacks (including stopped monitoring and
  meters) from touching callback-owned vectors while they are cleared or
  resized, then publishes the matching graph before resuming callbacks.
  Ordinary same-document edits may reuse healthy chain helpers. A failed bank
  build publishes no vendor bank for that generation; recoverable C++ exceptions
  from a slot or builder cannot escape the worker thread. A native crash/hang in
  a live helper is contained from Core and unrelated chains, but that helper
  chain is lost until one automatic restart or explicit retry. Helpers run with
  the user's permissions and are not an OS sandbox; offline render still loads
  vendor code in its renderer process.
- Dynamic curves and parameter automation use `AutomationEnvelope` with
  shape-preserving curvature matching `RegionFade` (`pow(t, 2^(-curve*2))`),
  supporting real-time bounded block evaluation without heap allocation. Real-time
  signal tracking utilizes `EnvelopeFollower` with peak/RMS detection and anti-denormal
  flush. Automation recording utilizes `AutomationRecorder` with touch/latch modes
  and non-destructive Ramer-Douglas-Peucker reduction (`RamerDouglasPeucker.cpp`).
- Plug-in parameter metadata is enumerated only inside the isolated plug-in
  host and copied into a fixed-capacity shared-memory table before the host
  publishes `Ready`. Core exposes that immutable table through the plug-in
  parameter HTTP endpoint; the HTTP thread must never inspect vendor objects.
  The editor can create and draw normalized track-level plug-in automation
  against stable slot/parameter IDs. Live block dispatch queues parameter
  changes to the isolated host; offline rendering evaluates track and audio-/
  MIDI-region plug-in lanes on its private render session. MIDI CC and channel
  pitch-bend lanes on MIDI regions are dispatched to the track instrument (and
  scheduled external MIDI output where applicable), at audio-block granularity.
  These channel lanes are not per-note MIDI 2.0 glide.
- Plug-in delay compensation is derived from the same topologically ordered
  graph. A topology-specific delay bank publishes pre-bound per-edge entries
  so every summing strip aligns to its slowest input without lookup or
  allocation in the audio callback. It is separate from the stateful processor
  bank: routing-only edits rebuild delay lines without recreating vendor
  instances or resetting their tails. Delay rings are prepared off-thread and
  bounded to 10 seconds and 128 MiB per bank; if either bound cannot be met,
  compensation is disabled as one whole plan rather than partially
  phase-aligning the graph. Inactive delayed edges consume zeroes so stale
  audio cannot replay after unmute. A runtime latency-change notification only
  flips an atomic; the message-thread host poll requests a new latest-wins
  delay-bank generation.
- Output lanes accumulate with `+=`; multiple valid sources may target the
  same lane.
- Real-time audio and MIDI recording: tracks support input monitoring (`inputMonitoring`, Logic Pro 'I' button) and record arming (`recordArmed`, Logic Pro 'R' button) with configurable hardware input routing (`inputSource`). In the real-time audio callback, live monitored tracks process incoming hardware inputs through scratch memory and plug-in chains even when transport is stopped without blocking or allocating. For stereo tracks assigned an input pair, if the device exposes only one of those channels, the available mono input is copied to both sides; when both are available, their stereo image is preserved. Real-time audio recording writes planar frames via lock-free SPSC `AudioRingBuffer`s drained by the asynchronous `AudioRecordWorker`, which finalizes 24-bit PCM WAV files and creates timeline regions upon transport stop. Incoming hardware MIDI is routed to the focused MIDI/instrument track plus every explicitly armed or input-monitored MIDI/instrument track; virtual MIDI may target a track explicitly. Only armed tracks capture MIDI into sample-accurate timeline regions. Auto Input Monitoring (AIM) state machine (`MonitorSourceMux.h`) governs monitor source switching (`StoppedMonitoring` vs playback tape monitoring and sub-block punch switching). The dry record tap samples input audio before insert FX, trim, or phase inversion. Live peak pyramids (`PeakMipAccumulator`, L0..L5) are populated off-thread by `AudioRecordWorker` and served range-wise via `/api/v1/recording/{id}/peaks` for real-time waveform visualization in `LiveRecordingRegion`. MIDI capture publishes completed and currently-held notes through a fixed-capacity `SeqLock` snapshot; UI telemetry grows held note bodies without locking or allocating in the callback. MIDI note IDs are assigned monotonically per track during capture and stay stable after commit. Low-Latency Monitoring (`LowLatencyPlan.h`) selectively bypasses high-latency plug-ins and non-safe sends on armed strips.
- Active MIDI key illumination (including non-recording MIDI monitor and sequenced notes) is separate from MIDI-capture preview: the callback owns fixed-capacity per-strip overlapping note counts and updates a compact `SeqLock` pitch mask only when a note becomes active/inactive. The JUCE message thread maps strip indices to stable track IDs and publishes `{trackId, pitch}` rows in web state for Piano Roll and virtual-keyboard feedback. UI polling must never read callback-owned counters directly; stop requests a callback-owned clear alongside all-notes-off.
  `I` is an independent per-track live-input subscription: several audio and MIDI/instrument tracks may monitor simultaneously. Software-instrument tracks also audition incoming MIDI by ephemeral controller focus without being armed, while `R` is still required to capture audio or MIDI. The global Record action auto-arms the focused recordable track when no track is armed. Audio tracks with `No Input`, plus folder, lighting, and bus-timeline rows, cannot be armed or monitored.
  Hardware MIDI input is opt-in: an empty device preference opens no input on
  startup. The selected source is persisted in device settings and published
  back to controllers; choosing “All Inputs” is an explicit action. Live MIDI
  note ownership is callback-owned and bounded by strip/channel/pitch, so
  note-offs still reach their original strip if focus, arm, monitor, or channel
  filtering changes while a key is held. Stop and seek clear this ownership
  alongside active-note counters.
- If graph or block dimensions exceed prepared capacity, silence is safer
  than allocating or writing out of bounds.
- Offline render must use the production graph and renderer. A second mixing
  implementation will drift semantically from live playback.

## 7. Streaming and song transitions

`StreamingEngine` supports bounded disk-backed playback and selective resident
audio:

- Directory packages give files independent handles and parallel workers.
  Legacy ZIP access is more serialized because it shares archive machinery.
- Only the used source window is considered for residency. The normal resident
  budget is bounded (currently 512 MiB), not “load the project into RAM.”
- Random-access treatments such as reverse, non-unity speed, or independent
  transpose require resident source data; ordinary playback streams forward.
- A process-wide file-path pool keeps reusable decoded/prepared sources alive.
  Song switches rebind or rewind where possible instead of reopening files.
- Warm-cache generations/epochs cancel stale staging work. Never let an old
  async result replace a newer selected song.
- `stageSong(..., asyncFill)` publishes the new active set without making the
  message thread wait for decode. It remains muted until real head audio is
  ready.
- Sample-rate/device changes invalidate cached preparation whose resampling
  ratio is no longer valid.
- Gapless handoff explicitly parks rendering while the message thread resets
  playhead and stream ownership. Preserve the ordering between handoff flags,
  clock reset, active-song publication, and fade state.

Any new cache must have a stated owner, memory bound, invalidation key, and
stale-job policy.

## 8. Commands, state publication, and remote telemetry

### Reliable control path

```text
React action
  -> preload/Electron HTTP proxy (or browser fetch)
  -> Core HTTP :2899
  -> WebServer parses and enqueues WebCommand
  -> JUCE message thread drains command
  -> mutate Project/transport/settings
  -> rebuild and publish snapshots where necessary
  -> next audio/light block observes the new state
```

Never execute a command directly on the libwebsockets thread. JUCE objects and
the mutable project belong to the message thread. Continuous controls may be
coalesced to prevent a remote fader gesture from building an obsolete backlog,
but transactional actions must not be silently coalesced or dropped.

### Telemetry path

```text
audio/light/workers
  -> atomics, SeqLock frames, bounded envelope rings
  -> MainComponent::publishWebState() on message/timer thread
  -> WebServer builds protocol-v8 binary frame
  -> UDP to each subscribed controller
  -> Electron UdpTelemetryTracker validates source/header/sequence
  -> preload IPC
  -> liveLevels decoder + useLiveState
  -> React view
```

The binary frame currently uses magic `0x5253`, protocol version `8`, a
wrapping 32-bit sequence number at byte offset 4, and a 66-byte header. Do not
edit layout in only one language. A protocol change requires, in the same
change:

1. bump/define the Core protocol version and encoder layout;
2. update `electron/src/udpTelemetry.ts` validation and tests;
3. update `ui/src/lib/liveLevels.ts` decoding and tests;
4. update `scripts/test-remote.mjs` and protocol documentation;
5. verify malformed, truncated, duplicate, reordered, wraparound, restart, and
   host-switch behaviour.

Electron binds an ephemeral UDP port and renews
`/api/v1/remote/subscribe-udp` every three seconds. Core expires a subscriber
after fifteen seconds. The old fixed loopback `2898` lane remains for local
compatibility, but remote sessions must use the subscriber-selected port so
multiple shells cannot steal one socket. Discovery uses UDP `28991`.
If Electron's UDP receive socket errors or closes, the shell rebinds an
ephemeral port with bounded exponential backoff and advertises the new port
through the normal subscription heartbeat. Embedded UI connection health uses
fresh UDP telemetry when available and falls back to recent successful HTTP
state polls while the UDP lane recovers.

`UdpTelemetryTracker` rejects packets from any host except the resolved active
Core, validates magic/version/length, applies wrap-safe sequence ordering, and
starts a fresh epoch after 1.5 seconds without telemetry. Keep the second
sequence guard in React as defence in depth. Never display “connected” merely
because discovery saw a host: command reachability and the UDP watchdog are
separate signals.

Track and bus peak measurements are Core-owned and included in live telemetry;
the renderer resolves positional track meter rows through the latest stable
track IDs before any view reads them. Meters and clip holds must not reuse a
previous strip's values when an inspector changes identity or the active Core
changes.

WebSocket/JSON state remains useful for browsers and slower structural state.
In Electron, high-rate telemetry is UDP while HTTP polling supplies structural
state that is unsuitable for a compact datagram. Do not reintroduce a
high-frequency full JSON state broadcast.

Structural project data, including song-, audio-region-, and MIDI-region
automation lanes, is copied into `WebUiState` by
`MainComponent::publishWebState()` on the JUCE message thread. `WebServer`
serializes that immutable snapshot only; it must not read mutable `Project`
objects from the libwebsockets thread.

### ResoLink Core-to-Core session protocol and serialization

All JSON communication (HTTP API, WebSocket messages, plug-in catalogs,
discovery datagrams, and project serialization) is unified under Glaze
compile-time reflection DTOs with external linkage (`server/WireTypes.h`,
`project/ProjectJson.cpp`). Fragile substring searches and `juce::JSON` tree
allocations are prohibited.

For distributed multi-machine live rigs and redundant failover, Cores exchange
compact binary beacons (`kResoLinkMagic = 0x52534C4B` on UDP `28992`) and
NTP/PTP-grade Ping/Pong packets (`resolink/ResoLinkProtocol.h`). Follower
instances run a Proportional-Integral (PI) phase-locked loop (PLL) tracking
leader monotonic time and sample render position (`resolink/SessionClock.h`),
bounded to safe $\pm 100\text{ PPM}$ frequency slewing without zipper noise,
snapping on large seeks ($> 50\text{ ms}$), and providing 2-second holdover
coasting during network packet loss. Individual tracks can be targeted for local
execution or remote peer delegation via `ExecutionTarget` in `TrackDef`. Real-time
threads query clock snapshots and rate multipliers wait-free via `SeqLock`.

## 9. Timing, events, MIDI, and lighting

Audio owns the sample render position. `MasterClock` projects from the latest
host-time/sample anchor with a bounded PI drift correction so other schedulers
remain monotonic during callback gaps. UI time is only a visualization.

Timeline events are detected against audio block boundaries for sample-aligned
intent, then dispatched without performing slow I/O in the callback. Output
latency, including the compatible plug-in bank's compensated path latency, is
included when deriving target host time so MIDI/DMX/HTTP intent is aligned
with audio as it is heard, not merely when buffers are filled.

Song tempo edits are message-thread project mutations. For the currently staged
song, publish a replacement immutable `TempoMap` snapshot atomically with
`AudioEngine::refreshActiveTempoMap()`; do not restage streams or seek merely
to make tempo edits visible to playback. Offline renderers continue to build
their own maps from their private project snapshot.

`LightEngine` resolves cues/effects on its own high-priority loop (nominally
60 Hz) from the master clock and immutable project state. Hardware protocols
may have their own lower safe rate (for example roughly 44 Hz per DMX
universe). `EventDispatcher` owns delivery and a persistent broadcast-enabled
UDP socket; do not create a socket per frame. Art-Net sequence numbers are
per-universe.

Queue capacity is a safety boundary. If adding an event type, document whether
overflow drops newest, drops oldest, coalesces, or raises health state. Never
replace bounded queues with an unbounded container on a producer that can run
from audio or lighting.

Continuous MIDI learn: hardware footswitches, pads, rotary knobs, and CCs map via
`ActionCatalogue` actions including transport recording (`record`), mixer strip
parameters (`track_gain:`, `track_pan:`, `track_arm:`, `track_monitor:`, `master_gain:`,
`master_pan:`, `send_level:`), and hosted VST3/AU parameters (`plugin_param:<slotId>:<paramIndex>`).

## 10. Project model and persistence

The schema lives in `core/engine/project/ProjectSchema.h`. Current on-disk
format version is `6`. A `.rsnraset` is normally a directory package containing
`project.rsnrasetmeta`, audio resources, and derived caches; legacy ZIP
packages and `project.json` still have compatibility paths.

Key ownership rules:

- Global project state owns tracks, click, main/send routing, lighting,
  songs, cycle state, and MIDI mappings.
- Songs own timeline regions, sections, events, and light cues.
- Stable entities use namespaced IDs such as `audio::track:1` and
  `audio::main`. Churn-heavy rows use UUIDv7 to survive copy/paste and undo.
- Optional strings serialize as JSON `null`, not an empty-string convention.
- Application/device preferences live in `AppSettings`; they are not portable
  musical project content.
- Track, click, send, and main strips own ordered `PluginSlot` chains. Each
  slot persists a catalog identifier plus fallback vendor/name metadata;
  opaque vendor state lives in a separate package resource referenced by
  `stateResource`, never as base64 in the metadata JSON. Missing effects must
  degrade to explicit pass-through, not make a project unloadable.
- The message thread may mutate `ProjectLoader::project()`. Workers receive a
  snapshot or other explicitly published state; they must not retain a mutable
  project reference across threads.
- Slow save/import/export operates from private snapshots on background work.
  Directory containers can coexist with open file cursors; legacy ZIP access
  has stricter shared-handle constraints.

There is deliberately no general in-engine migration ladder during this
pre-release phase. `ProjectLoader` rejects formats older than the explicitly
declared readable floor and directs the operator to `pnpm migrate <project>`.
Format v3, v4, and v5 are additive compatibility exceptions: v3 gains empty
plug-in chains, v4 gains default MIDI channels/empty retained-event vectors,
and v5 gains empty UMP-event vectors while MIDI 1.0 notes remain unchanged.
They are parsed losslessly and promoted in memory; the package is rewritten at
v6 only on its next normal save. MIDI 2.0 note attributes and raw UMP packets
are optional region data; preserving them in the project does not itself imply
that a given MIDI file, device, or plug-in path can consume MIDI 2.0.
Newer unknown formats are always rejected. When persisted semantics change, bump the format, update
serialization/parsing/defaults/fixtures and the external migrator, and add an
explicit compatibility rule only when the old shape is provably unambiguous.

Peak/waveform caches and other derived artifacts must be disposable. The audio
thread reads the peak-duration map through an immutable `shared_ptr` snapshot
so it never takes the peak-cache mutex; keep expensive peak building in the
bounded background pool.

## 11. Offline rendering

Offline rendering is not a recording of the live device. A background worker
takes an immutable project snapshot, opens an independent `ProjectLoader`, and
uses the same `MixGraph`/`MixRenderer` semantics as live playback. It supports
the project, one song, the project cycle, or a custom song-local range and can
capture any combination of main, track, bus, and metronome post-strip taps to
separate WAV files in one graph sweep. Never implement stem export by
repeatedly changing Solo and rerendering: that changes shared-bus/send
semantics and repeats the expensive mix work.

Each rendered song gets a private processor bank built from the snapshot and
saved plug-in states. Processors are marked non-realtime before
`prepareToPlay`, so JUCE signals offline mode to VST3 and Audio Unit hosts.
MIDI regions are converted through the song `TempoMap` to sample-positioned
events for software-instrument strips in that same graph pass; never route
offline MIDI through the live dispatcher or share live processor instances.

When several taps are exported together, shorter tap paths are delayed to the
slowest selected tap so every WAV shares one compensated sample origin. These
offline tap delays are bounded to 64 MiB and a job fails cleanly before
publication when that budget would be exceeded. Output-latency trimming is on
by default: the renderer processes the common latency as bounded extra work,
discards that startup window, and still writes the exact requested range. A
`Wrap` render needs no separate trim pass because its unwritten first cycle
already primes both processors and delay lines. Missing plug-ins, unavailable
state, and disabled PDC are recoverable render warnings carried through job
status and shown with the completed outputs; they must not disappear in a
background worker log.

The renderer uses bounded seek/decode caches (currently 8192-frame chunks)
rather than loading an entire show into memory. It must not stop or reconfigure
the live engine, touch the device callback, or read a project while the message
thread mutates it. In a remote session the job runs on the remote Core and its
reported output path belongs to the playback machine.

Tail policy is explicit. `Cut` ends at the requested sample range. `Leave`
feeds silence through the graph until every selected tap's release envelope
stays below the configured threshold for the quiet-hold duration, with a
mandatory maximum tail bound. A processor bank's conservative declared tail
is a minimum before quiet-stop, preventing sparse echoes from terminating in
the gap between repeats, but it can never extend the user-selected hard cap.
`Wrap` renders one complete priming pass without writing, preserves
renderer/processor state, then records the second pass; do not replace it with
post-summing an unbounded in-memory tail. Cancellation is cooperative at each
bounded render block and must close and remove every partial output in the job.

Writers publish atomically: output is built under `.resostage-part` and renamed
only after its header and samples are complete. Normalization uses a bounded-
memory float disk spool so peak/overload gain is decided before the one final
integer quantization. TPDF dither is applied only in that final conversion;
tail detection always observes pre-dither float samples. Float32 WAV preserves
values above full scale for downstream mastering. A multi-file job either
publishes every file or removes files already committed if a later commit
fails, and it never overwrites an existing destination.

Whenever routing or DSP semantics change, add parity tests proving offline and
live graph behaviour remain equivalent.

### Plug-in discovery boundary

Plug-in discovery is available through `GET /api/v1/plugins/list`,
`POST /api/v1/plugins/scan`, and cooperative cancel via
`POST /api/v1/plugins/scan/cancel`. Individual plug-in enable/disable states
are managed via `POST /api/v1/plugins/enabled` and persisted in
`scanner-prefs.json`. Plug-in discovery runs exclusively on explicit user
request from the Settings screen, never on application startup, so background
scanning never competes with audio device startup or project load. Native
plug-in editor windows are managed on the message thread via
`POST /api/v1/plugins/slot/editor`. `PluginCatalogService` never loads a
third-party binary in Core: it launches the packaged platform-branded plug-in
scanner executable, which uses JUCE's VST3/AU format scanners and writes
`known-plugins.xml`, a bounded JSON catalog, scan status, and dead-man's-pedal
under the device-local ResoStage application-data directory. Registry and
catalog replacements are atomic and checkpointed after each successfully
inspected item; Core exposes those safe partial checkpoints while a scan is
still running. A scan is single-flight and runs at background priority inherited
from Core. If a vendor binary crashes, or makes no progress for 60 seconds,
Core launches a fresh helper, applies the dead-man pedal to quarantine that
candidate, and continues from the checkpoint. Recovery is bounded to 32 helper
failures per requested scan. Core shutdown terminates the child without
turning that expected stop into a scan failure, and clears the active pedal so
an intentional stop does not quarantine a healthy item. Do not run discovery
or recovery on the audio path or make it delay device startup.

The catalog is structural state, not telemetry. React fetches it only on the
Plug-ins settings screen and polls while a scan is active; it must never be
added to the high-rate UDP or WebSocket state frame. UI rendering is capped
and filtered so catalog size cannot create an unbounded component tree.

VST3 is enabled on all supported desktop builds and AU on macOS. VST2 remains
disabled; do not enable or ship it without separately verified legacy SDK and
distribution rights. Live project slots use an asynchronous `PluginProcessorBank`
in Core as a graph-facing proxy; vendor instances execute in the packaged
platform-branded plug-in host, one process per serial strip chain (up to 32 chains).
Offline renders use a separate in-process bank and never borrow live vendor
instances. Same-project edits reuse unchanged healthy chain helpers, while a
whole-project replacement invalidates the prior epoch and restores only the
incoming project's state. Core exchanges audio through a versioned shared-memory
protocol with three fixed audio slots, bounded MIDI packets, and a bounded MPMC
parameter/bypass queue. The callback only copies into fixed storage, advances
lock-free slot states, and sends a non-waiting wake signal; a late/missing effect
block falls back to dry input, while instruments emit silence. PDC includes the
nominal device callback quantum and plug-in-reported latency, not the larger
preallocated buffer capacity. Runtime latency changes flow back to Core through
shared atomic telemetry and trigger delay-plan rebuilding without recreating
the host. Sample-rate or IPC-capacity changes require a fresh helper. A
non-realtime watchdog kills a dead/stalled host;
Core permits one automatic restart per chain/document and then requires an
explicit retry. Native live plug-in faults are therefore contained to their
helper chain, but helpers run with the user's permissions and are not OS
sandboxes. Offline plug-in crashes remain outside this live-host guarantee.

Project resource extraction rejects absolute paths, traversal, and symlinks
that resolve outside the project container. Plug-in state resources are capped
at 64 MiB per slot before allocation/read; never move that validation after
materialization. This protects the loader boundary, not the vendor state parser:
malformed state can still crash an in-process offline renderer. Live state
restoration runs in the isolated chain helper, which contains native faults but
is not a permission/security sandbox.

## 12. Electron and UI conventions

`electron/src/main.mts` is orchestration code, not a second backend. Keep
security-sensitive and OS-sensitive work there: process lifecycle, native file
dialogs, project upload/download, remote target selection, UDP source
validation, menus, tray, and Touch Bar. Keep the preload surface narrow and
typed; do not expose raw Node or Electron APIs to React.

Application menus have one source of truth in `core/app/platform/MenuModel`.
`MenuItemModel::children` is recursively serialized by the UI menu endpoint and
recursively materialized by Electron; submenu placement, labels, and shortcut
metadata belong in that model. High-rate undo/redo availability is applied to
the existing native menu items in place. Electron exposes a built
`MenuItem.submenu` as read-only, so changes to Open Recent rebuild the native
menu from the current `MenuModel` rather than mutating the existing submenu.
Menu-state updates must not rebuild the menu for action echoes or unchanged
recent-project lists.

`useLiveState.ts` merges two classes of data:

- high-rate UDP meter/playhead/health state, pushed without React erasing
  transient peaks; and
- lower-rate HTTP/WS structural state, coalesced through animation frames.

Avoid putting full telemetry objects into broad React context if that forces
the entire application to rerender at telemetry frequency. Subscribe narrowly
and keep latest-frame storage outside expensive component trees.

HeroUI is wrapped by `ui/src/components/ui/`. Shared visual or behavioural
policy belongs in those wrappers. In particular, all modals use the shared
modal implementation so backdrop blur and the theme surface background are
consistent. Do not import a raw HeroUI modal at a feature call site to bypass
the policy. Reuse tokens and variants; avoid one-off near-duplicate components.

## 13. Rules for safe changes

Before modifying a realtime or cross-thread path, identify its writer, readers,
lifetime, upper bound, and failure mode. Then preserve these hard rules:

### Never do this in the audio callback

- blocking mutex acquisition, condition-variable wait, thread join, or sleep;
- filesystem, archive, console/logging, HTTP, socket, JSON, or UI work;
- routine `new`, container growth, buffer resize, or destruction with
  unpredictable cost;
- waiting for decode, a message-thread command, or an offline job;
- reading state while another thread mutates it without an established atomic,
  snapshot, SPSC, or single-writer protocol;
- throwing an exception across the device callback.

The existing debug-only injected stall is a test mechanism, not precedent for
production sleeping.

### Cross-thread checklist

- Prefer immutable snapshots for complex read-mostly state.
- Prefer SPSC rings when there is exactly one producer and one consumer.
- Use `SeqLock` only for trivially copyable state and exactly one writer.
- Use atomics for independent scalar state; document ordering when it carries
  ownership or publication, not just a value.
- Bound queues, retries, memory, and work per callback/frame.
- Make cancellation generation-based for async work whose result can become
  stale.
- Keep object reclamation correct. “Lock-free” is not permission to introduce
  use-after-free or ABA hazards.
- On contention or exhaustion, choose an audible/visible failure policy and
  report it through health telemetry.

### Engineering priority and resource budget

ResoStage must remain usable on weak, old, thermally constrained laptops as
well as modern workstations. Optimize the whole application for predictable
latency and efficient use of CPU, memory, storage, GPU, and network bandwidth.
Do not assume that spare resources on the development machine exist at a live
show.

When principles conflict, use this priority order:

1. correctness, data integrity, and safe hardware/output behaviour;
2. meeting audio and time-critical deadlines with bounded worst-case latency;
3. efficient and bounded CPU, RAM, I/O, GPU, and network use;
4. clear ownership, simple code, testability, and maintainability;
5. cosmetic elegance or abstract purity.

Clean code supports performance; it does not override it. Do not introduce a
generic abstraction, dependency, background poller, copy, allocation, virtual
dispatch, serialization pass, or rerender merely because it looks cleaner.
Likewise, do not write obscure “optimized” code without evidence. First remove
unnecessary work and choose the right data flow; then measure representative
optimized builds on realistic low-end constraints.

Resource rules:

- Give every cache, queue, pool, history, retry loop, batch, and worker count a
  defensible upper bound. Derive capacity from a real workload where possible.
- Avoid work proportional to total project size on a per-audio-block, per-UDP-
  packet, per-animation-frame, or high-frequency timer path. Pre-index,
  incrementally update, or publish a prepared snapshot instead.
- Prefer contiguous, compact, cache-friendly data in DSP and telemetry paths.
  Avoid pointer-heavy object graphs and repeated string/map lookup in hot loops.
- Reuse prepared buffers and objects. Avoid copying full projects, graphs,
  telemetry blobs, audio blocks, or large React state unless crossing an
  ownership boundary genuinely requires a snapshot.
- Load and decode lazily, stream large media, and keep residency selective.
  Never trade a small latency improvement for unbounded project-sized RAM.
- Keep thread counts intentional. A worker per track/file/request is not
  acceptable; use bounded pools and avoid oversubscribing low-core machines.
- Do not busy-wait or poll at a needlessly high frequency. Prefer notification,
  backoff, coalescing, or a frequency justified by the consumer's deadline.
- Send compact deltas or binary latest-state data at high frequency. Do not
  repeatedly serialize or transmit unchanged full structural state.
- Keep React render scope narrow, virtualize or window large collections, and
  avoid GPU-heavy visual effects on continuously changing surfaces. Visual
  polish must degrade gracefully without affecting Core.
- Treat startup time, idle CPU, idle network traffic, and background RAM as
  product performance. A stopped show should not burn resources as if playing.
- Do not add a dependency for a small operation without considering binary
  size, startup work, transitive code, maintenance, and runtime allocation.
- Preserve diagnostics, but keep high-rate tracing out of production hot paths.
  Aggregate counters/histograms and sample diagnostics instead of logging per
  block, packet, sample, or lighting frame.

Performance work must be evidence-based. Record the workload, build type,
buffer size/sample rate, track/output counts, machine class, and before/after
measurements when a change is justified as an optimization. Watch averages
and tail behaviour: callback maximum/deadline misses, allocation count, peak
RAM, stream depth, UI frame time, packet size/rate, and idle usage. A faster
average that creates an unbounded or much worse p99 path is usually a
regression in live software.

### Clean code, DRY, KISS, and comments

- Keep functions and types focused around one responsibility and one owner.
  Split code when it clarifies a boundary; do not split a hot loop into layers
  that hide cost or make data access less local.
- Keep domain/DSP code JUCE-free where practical so it stays deterministic,
  portable, inexpensive to test, and reusable by live and offline rendering.
- DRY means one source of truth for signal semantics, protocol layouts,
  persisted schema, validation, and shared UI policy. Extract duplication only
  when the cases have the same invariant and are expected to evolve together.
  Superficially similar code with different realtime, ownership, or error
  constraints may correctly remain separate.
- KISS means the smallest explicit design that preserves ownership, bounds,
  observability, and correctness. It does not mean collapsing process/thread
  boundaries or replacing a proven primitive with a clever custom one.
- Apply SOLID pragmatically. Dependency direction and narrow interfaces matter;
  class proliferation, runtime indirection, and factories with one use do not.
- Prefer composition and plain data over deep inheritance. In a hot path,
  prefer compile-time/static structure when it is clearer and demonstrably
  cheaper, without duplicating behaviour.
- Use names that reveal role, ownership, units, and lifetime. Keep units in
  names (`Seconds`, `Samples`, `Nanos`, frames) and normalize at boundaries.
- Validate external input once at the boundary, return useful errors, and keep
  internal invariants strong. Do not scatter defensive branches throughout a
  hot loop when preparation can make invalid state unrepresentable.
- Keep error handling explicit. Never swallow an error merely to keep a UI
  green; expose recoverable degradation through existing health telemetry.
- Refactors must preserve behaviour and performance unless their change is
  deliberate and tested. Do not combine a broad cleanup with an unrelated
  protocol, schema, DSP, or threading semantic change when they can be safely
  separated.
- Remove dead code, stale compatibility branches, and duplicated obsolete
  paths only after all callers, persisted data, remote peers, and platform
  packaging requirements are proven gone.

Comments and API documentation are part of correctness in concurrent code:

- Comment **why** a design exists: ownership, thread affinity, units, ordering,
  lifetime, capacity, realtime restrictions, platform quirks, failure policy,
  or the bug that a non-obvious sequence prevents.
- Public methods and non-obvious internal methods should document what they do,
  the thread/context allowed to call them, important preconditions, side
  effects, ownership/lifetime of arguments and results, and failure behaviour.
- Keep documentation grounded in the current implementation. Verify the body
  and callers before writing a method comment; never invent guarantees from a
  name alone.
- Do not narrate syntax, duplicate the type signature, explain obvious code, or
  preserve a historical diary that no longer affects the design.
- When code changes invalidate a comment, update or remove it in the same
  change. A plausible but stale concurrency comment is worse than no comment.
- Memory-ordering comments must state the published data and the happens-before
  relationship they protect. Do not weaken ordering without a stress test and
  a concrete proof.
- Performance comments should state the avoided cost or bound, not merely say
  “optimized.” Include measurement context when a surprising implementation is
  retained because it is measurably better.

## 14. Build and artifacts

Use Node 20+ and the pinned pnpm major. Root scripts are the supported entry
points:

```bash
pnpm install
pnpm run dev              # production UI + Core + Electron assembly, then run
pnpm run rebuild          # same full assembly without launching
pnpm run app              # build Core only
pnpm run ui:dev           # Vite UI development server; not the full product
pnpm run publish:rebuild  # clean full build followed by installer packaging
```

`pnpm run dev` is intentionally a real assembled Electron/Core build, not only
a browser/Vite session. The distributable layout is the same shape used by
release code:

- macOS Apple Silicon: `build/mac/arm64/ResoStage.app`
- Windows x64: `build/win/x64/resostage.exe` with its sibling `core.exe` and
  Electron resources

The assembled Core carries a scanner beside its executable. Windows helper
names are `pluginscan.exe` and `pluginhost.exe`; the app entry points are
`resostage.exe` and `core.exe`. Linux retains `resostage-plugin-scanner` and
`resostage-plugin-host`. On macOS the scanner executable is `ResoStage Plugin
Scanner`; the live host is a separately identified
`Contents/Helpers/ResoStage Plug-in Host.app` inside the Core bundle, with a
matching `ResoStage Plug-in Host` executable. Raw CMake Core builds may still
launch the sibling unbundled host. Keep the nested app's
icon, version, and bundle identifier intact for OS process attribution and
bottom-up code signing. The packaged Kaishaku execution helper is stored once
under `ResoStage Core.app/Contents/Resources` (branded app bundle preferred,
raw binary fallback); Electron and Core resolve the same copy. Do not omit
either plug-in helper from a platform adapter.
Missing scanner means the catalog API reports a visible scan failure; missing
live host makes affected plugin slots visibly fail closed rather than loading
vendor code in Core.

On Windows the executable is not standalone; keep the complete assembled
directory together. On macOS the outer Electron application contains
`Contents/Resources/ResoStage Core.app` and embedded web assets. Raw CMake
output under `core/build/` is an intermediate, not the deliverable users run.

The build scripts are cross-platform. Do not add shell-only assembly logic when
the operation belongs in `scripts/platform/` or shared Node helpers.

## 15. Verification matrix

Run focused tests while iterating, then the relevant full matrix before
handoff. Do not claim real-time or remote behaviour from compilation alone.

```bash
# Native engine suite (configure/build first if needed)
pnpm run app
ctest --test-dir core/build --output-on-failure

# React
pnpm --dir ui test
pnpm --dir ui exec tsc -b --pretty false
pnpm --dir ui lint

# Electron, UDP, discovery, and orchestration helpers
pnpm --dir electron test
pnpm --dir electron typecheck

# Repository-level expected suite
pnpm test
pnpm lint

# Full shipping-shape assembly
pnpm run rebuild

# Real two-machine command + UDP path, with Core already running remotely
REMOTE_HOST=192.168.5.115 REMOTE_PORT=2899 pnpm test:remote
```

Choose additional tests by risk:

- Routing/concurrency change: run routing stress tests, preferably also ASan or
  TSan in a suitable native build.
- DSP or callback change: compare callback wall time versus thread CPU time,
  silent-block/underrun counts, and output on realistic track/output counts.
- Streaming change: test cold load, warm switch, rapid song reselection,
  seek/cycle, device sample-rate change, EOF, and ring starvation.
- Remote change: test wrong-source packets, loss, reorder, duplicates,
  sequence wrap, Core restart, cable loss/recovery, multiple controller shells,
  and Windows firewall behaviour.
- Project schema change: round-trip current projects, reject old versions with
  a useful message, run migration, and reopen migrated packages.
- UI component-system change: inspect all affected dialogs/states in light and
  dark themes, not only the edited feature.
- Offline render change: compare main/track/bus/click outputs with live routing
  semantics and verify cancellation/error cleanup.

For a remote acceptance pass, confirm that transport, seek, song selection,
mute/solo, fader/pan, routing, project edits, render status, meters, health, and
lighting visualization all reflect the playback Core, while the controller's
local audio device remains unused. UDP must become stale promptly after link
loss and recover without restarting either application.

## 16. Definition of done

A change is complete only when:

1. ownership and thread boundaries are unchanged or deliberately documented;
2. the audio callback gained no unbounded work, waiting, I/O, or surprise
   allocation;
3. memory, queues, caches, retries, and async jobs remain bounded and stale
   results cannot win;
4. live, offline, browser, local Electron, and remote Electron semantics stay
   aligned where the feature applies;
5. protocol/schema changes are updated atomically across producers, consumers,
   fixtures, migrations, tests, and documentation;
6. focused tests and the appropriate matrix pass in an optimized build;
7. comments and this document describe the real implementation rather than an
   intended future architecture;
8. `AGENTS.md` is updated when, and only when, the change materially alters
   architecture or the safety/verification contract described above;
9. unrelated user changes are preserved and generated artifacts are not
   committed unless the repository explicitly tracks them.

When forced to choose in a live-show code path, prefer deterministic bounded
degradation with visible telemetry over an occasionally perfect result with an
unbounded latency tail.
