# Restore point — timeline reliability + full lighting overhaul

Created before implementation on 2026-08-01. This document is **frozen**: it
is written once, before any code changes in this batch, and is never edited
again as the work proceeds (progress lives in git history / commit messages,
not here). It exists so that another human, or a completely different AI
agent with its own unrelated tools, can pick this work up mid-flight — after
a crash, a context reset, or a handoff — and understand exactly what was
agreed, why, and what is left, without having to re-derive any of it from
scratch. A previous attempt at this exact batch produced a restore point that
was too thin to be useful and a 3D glow effect that looked bad; this is the
redo, done properly.

Do not treat anything below as aspirational marketing copy. Every claim about
"why" is grounded in an actual line of code that was read before writing it.
Where a root cause is a hypothesis rather than 100%-confirmed, it says so.

## Repository shape (for an agent that has never seen this repo)

- `/engine` — pure, portable C++20 core (audio, project schema/persistence,
  lighting math, timing). No JUCE, no platform code. This is what
  `tests/` links against.
- `/app` — the JUCE desktop application: audio device I/O, the embedded
  libwebsockets HTTP/WS server (`app/web/`), MIDI, native UI shell. Talks to
  `/engine` types directly (`Project`, `LightCue`, etc.) and to `/ui`'s built
  assets via `app/web/EmbeddedAssets.h` (a generated header — never hand-edit
  it, it's produced by `ui/scripts/embed.mjs` / `pnpm embed`).
- `/ui` — the Vite + React 19 + TypeScript SPA served both by the embedded
  web server (on-device control surface / FOH tablet) and as the desktop
  app's own UI shell. `pnpm --dir ui dev` is normally already running during
  development — **frontend-only changes do not need an app rebuild/restart**,
  Vite HMRs them. Native (`/app`, `/engine`) changes need `pnpm run
  rebuild:run` (kills the running app, rebuilds, relaunches it) before they
  take effect, and `pnpm test` (native doctest suite) should pass first.
- `/tests` — doctest-based C++ unit tests for `/engine` (and the parts of
  `/app` that are pure enough to test, like `ResoLightChannelMap.h`). New
  test files must be registered in `tests/CMakeLists.txt`'s
  `add_executable(resostage_engine_tests ...)` list or they silently never
  run.

Duplication note that matters a lot for this batch: several small math
functions are **hand-ported, on purpose, in two languages** because the
alternative (a schema/codegen step, or a server round-trip for every preview
frame) was rejected earlier in the project's life. Whenever you change one
side you must change the other or the live preview will lie about what the
real hardware is doing:
- `engine/lighting/LightCueInterpolation.h` (`resolveLightCueValue`,
  `hsvToRgb`, `addressableEffectLedColor`, `applyEffect`,
  `parseEffectType`/`effectTypeToString`) ↔ `ui/src/lib/lightCueInterpolation.ts`.
- `engine/project/ProjectSchema.h`'s `LightCue`/`LightFixture`/etc. field
  sets ↔ `app/web/WebServer.h`'s `WebUiState::LightCueRow`/`LightFixtureRow`
  (JSON wire shape, `int`/`double` instead of `uint8_t`) ↔
  `ui/src/lib/types.ts`.

## Scope agreed with the project owner

Two unrelated problem areas landed in the same session, both authorized for
fully autonomous, no-questions-asked execution, complex work first:

### A. Timeline playhead reliability (3 bugs)

1. Follow-playhead pinning (continuous auto-scroll during playback) must be
   completely suspended for the entire duration of a playhead drag gesture,
   and cleanly resume its prior mode afterward.
2. Vertical scrolling of the track lanes must stay visually stable — no
   "дорожки косоёбит" (track rows visibly skew/misalign) — while the
   timeline is fully playhead-pinned (auto-follow actively driving the
   viewport every frame).
3. Dragging the playhead while the transport is playing must reliably work:
   no gesture that silently fails to grab it, and no dropped position that
   gets discarded/overwritten instead of taking effect.

A prior attempt at bug 1 (commit `a15e434`) is in history and is **not**
being reverted — it added real (if partially redundant/inert) machinery.
This batch finishes the job properly instead of re-doing it from scratch.

### B. Lighting system overhaul

4. Audit tempo-synced light effects for perfect, drift-free metronome
   lock, and audit whether light data actually benefits from the binary
   WS transport built for audio peaks (`e722ec5`) the way it's assumed to.
5. Substantially expand the addressable LED effect library (the user
   supplied a detailed research document on concert lighting effects for a
   120-LED vertical bar — Fire2012, Perlin-noise flame with swappable
   palettes, gravity/physics particle effects, log-frequency GEQ, VU meter
   with peak-gravity ballistics, sonic transient waves, BPM-locked chasers,
   plasma/interference fields, twinkle fields, layered blend modes, etc.).
   Several of these already exist under the existing effect vocabulary
   (Chase, Helix, Plasma, Twinkle, SonicBoom already cover Phase-Locked
   Chasers / DNA Helix / Plasma Hiphotic / Fairytwinkle / Sonic Boom) — the
   gap is the physically-simulated ones (fire, gravity/particles), the
   audio-spectral ones (GEQ/Blurz — see the FFT note below), and multi-layer
   blend compositing.
6. Real custom-gradient support, including for tempo-synced/rhythmic
   effects — not just persisted-but-unused text, and not just a raw
   comma-separated hex textbox (see the concrete bug found below).
7. The 3D LED preview needs a real per-pixel glow done properly (the
   previous attempt used a flat additive sprite billboard and looked bad —
   do not repeat that particular approach uncritically; a small
   view-space/shader-driven bloom or a properly authored radial-falloff
   sprite texture reads as an actual light source instead of a flat halo).
   Every light panel must be hard-snapped to the stage grid at all times,
   including while the user is actively dragging it, not just on drop (this
   already mostly exists — see the audit note below — verify and hard-lock
   it, including for positions that predate the grid-snap feature).

## Root causes found during the pre-implementation audit

Everything below was independently confirmed by two separate deep-research
passes over the actual code before any line was changed.

### Timeline bug 1 — follow-pin "not suspended" during drag

`ui/src/components/Timeline.tsx` already has **two** refs toggled in lockstep
by the exact same four pointer handlers (`onPointerDown`/`Move`/`Up`/
`CancelOrLost`, ~line 2191-2239): the pre-existing `dragging` ref (used by the
`followMode==="snap"` edge-pan and reveal-pan branches) and a newer
`playheadDragActiveRef` (added by `a15e434`, read only inside the
`followMode==="smooth"` `following` boolean, ~line 2449-2453). As booleans
they can never disagree — this is redundant state, a maintenance hazard, not
a functional bug by itself. Default `followMode` is `"snap"`
(`localStorage` key `resostage.timeline.followMode`, default `"snap"` — see
~line 1214), so `playheadDragActiveRef` is **inert for most users**; whatever
"still feels broken" the user is seeing in the default mode is coming from
`dragging`'s pre-existing gating, not from the new ref at all.

The real stall: `seekFromClientX`'s commit call
(`setPlayheadAbsoluteSec(clampedAbs, commit ? 2_000 : undefined)`, ~line
2157) passes a **2000ms** lock to `useContinuousPlayhead`'s `seekAbsolute`
(`ui/src/lib/optimistic.ts`). Per that hook's rAF-advance effect (~line
109-135), the local clock does not advance *at all* — even once `dragging`
correctly flips back to false and follow correctly re-engages — until
`Date.now() - lastSeekAt.current > SEEK_LOCK_MS(450)`, i.e. up to a full 2
seconds of the view visibly sitting still after every committed drag-release.
That reads exactly like "follow isn't restored" even though the boolean gate
itself is fine. This 2000ms figure was itself a workaround for bug 3's real
defect (see below) rather than a correct fix.

**Fix direction**: drop the premature/duplicate `playheadDragActiveRef` in
favor of reusing the single `dragging` ref (or renaming it, but not doubling
it) for both branches. Fix the underlying clock-suspension properly per bug
3 below instead of papering over it with a long fixed lock window. Also
delete the dead `lastSeekAt.current = Date.now()` write at ~line 2167 inside
`Timeline.tsx` itself (a leftover local ref that is written once and never
read anywhere — confirmed by grep — separate from `optimistic.ts`'s own
same-named ref, which *is* live).

### Timeline bug 2 — vertical scroll glitches while fully pinned

`ui/src/components/Timeline.tsx`'s right-hand pane (`scrollRef`, ~line 3048)
is a **single** `overflow-auto` div handling both axes natively. The left
sidebar (track header labels) lives in a **separate** DOM subtree and is
kept visually aligned only via `transform: translateY(-scrollTopY)` (~line
2984 and ~line 3011), where `scrollTopY` is React state written solely
inside `onScrollSync` (~line 2242) from `e.currentTarget.scrollTop` — i.e.
gated behind a native `scroll` event → `setState` → re-render → commit
round-trip. Meanwhile, whenever the playhead is "fully pinned" (smooth
follow engaged), the dedicated rAF loop (~line 2404-2645) is **writing
`scroller.scrollLeft` directly, up to 60×/sec**, and each such write fires
its own native `scroll` event that re-enters `onScrollSync`. There is a
whole `programmaticScrollLeftRef`/`pendingScrollLeftRef` bookkeeping system
to keep the *horizontal* echo from re-triggering gesture detection, but
**no equivalent discipline exists for the vertical axis** — the sidebar's
position is just however-fast React happens to process the flood of scroll
events competing with a genuine concurrent user vertical scroll. That race
is what produces the "track rows visibly skew" symptom, and it only shows up
"while fully pinned" because that's the only time `scrollLeft` is being
rewritten at 60Hz on the very same native scroll container the user is also
trying to scroll vertically.

**Fix direction**: split the single combined-axis scroll container into two
properly nested ones — an outer `overflow-y:auto; overflow-x:hidden`
container that owns vertical scroll only and is *never* touched
programmatically, and an inner `overflow-x:auto; overflow-y:hidden`
container (full content height) that the rAF follow/zoom logic can freely
rewrite `scrollLeft` on every frame without ever perturbing the outer
container's native scroll bookkeeping. `position: sticky` on the ruler still
works correctly nested this way (it sticks relative to the nearest
*scrolling* ancestor for the axis in question, not necessarily its immediate
parent). This fully eliminates the race at the DOM/browser level instead of
trying to out-schedule it in JS.

### Timeline bug 3 — drag during playback doesn't apply / gets overwritten

The real defect, in `ui/src/lib/optimistic.ts`'s server-reconciliation
effect (~line 86-94):

```ts
const seekLocked = Date.now() - lastSeekAt.current <= SEEK_LOCK_MS;
if (seekLocked) {
  if (Math.abs(serverAbsoluteSeconds - localRef.current) < 0.35) {
    lastSeekAt.current = 0;                      // <-- releases the lock
    localRef.current = serverAbsoluteSeconds;      // <-- and snaps back
    setAbsolute(serverAbsoluteSeconds);
  }
  return;
}
```

This fires on **every** incoming server position update (the ~30-60Hz WS
telemetry stream), including mid-drag. `transport.seek()` is a
fire-and-forget POST (`ui/src/lib/api.ts`) racing that stream — while
playing, the live (not-yet-seeked) transport keeps advancing at 1× from
wherever it actually is. Any drag that lands within 0.35s of that
still-advancing live position — extremely common for an ordinary "nudge the
playhead a beat forward/back while it's playing" gesture — makes the very
next telemetry frame (still reporting the pre-seek position) satisfy this
proximity check and **snap the optimistic value straight back**, which is
indistinguishable from "the drop didn't apply." This is a genuine logic bug,
not a timing coincidence: it triggers on *proximity*, not on *whether the
seek actually landed*. It also directly explains why widening the commit
lock to 2000ms (the change that caused bug 1's stall) didn't fix it — the
proximity release bypasses the lock duration entirely.

**Fix direction**: give `useContinuousPlayhead` a real "suspended" signal —
the same pattern the hook already uses correctly for `frozen` (zoom
gestures) — driven by the drag-active ref, so **all** server reconciliation
(not just the lock timer) is fully inert for the entire duration of a live
drag, with no proximity-based early release at all. On commit, apply a
short, fixed, deterministic lock (a few hundred ms, not 2000ms) with no
distance heuristic, then resume normal correction. This removes the
snap-back bug at its root and, as a side effect, also fixes bug 1's stall
(no more multi-second frozen clock after every drop).

### Lighting bug — `LightEngine`'s project snapshot goes stale on almost every edit

`AudioEngine::notifyLightEngineProjectChanged()` (`app/AudioEngine.h`
~line 165) is the only thing that pushes a fresh `Project` snapshot to the
real-time DMX thread (`LightEngine::setProject`). It is called from project
load and from exactly **one** of the eight lighting mutation handlers in
`app/MainComponentLighting.cpp`: `lightingCueUpdate` (~line 381). The other
seven — `lightingSetConfig`, `lightingFixtureUpdate`, `lightingTrackAdd`,
`lightingTrackRemove`, `lightingTrackMove`, `lightingTrackUpdate`,
`lightingCueAdd`, `lightingCueRemove` — only call
`notifyProjectStructureChanged()`, which does **not** touch `LightEngine` at
all (confirmed by reading its body, `app/MainComponent.cpp` ~line 1570: it
only rebuilds busses and re-selects the current song). `MainComponent::
publishWebState()` reads `engine.project()` live and directly, so the web
preview reflects every edit instantly — meaning this bug is **completely
invisible in the preview** and only manifests on real hardware, which is
exactly the kind of bug that's easy to ship undetected. **Fixed as a
prerequisite** for trusting any of the new-effect testing below: every
lighting mutator now also calls `notifyLightEngineProjectChanged()`.

### Lighting bug — live BPM edits don't reach the real-time DMX thread

`MainComponent::builderSongUpdate` (`app/MainComponentBuilder.cpp` ~line
157) writes `s.bpm = numVal` directly into `SongDef::bpm` and only calls
`goToSong(index)` — which is what eventually re-pushes BPM to `LightEngine`
via `lightEngine.setBpm(song.bpm)` (`app/AudioEngine.cpp` ~line 1801) — when
`index != engine.currentSongIndex()`. Editing the tempo of the song that is
**currently playing** takes exactly the path that skips this call. Net
effect: live-nudging the BPM of the active song updates the operator's 3D
preview immediately (it reads `SongDef::bpm` fresh every publish) but every
tempo-synced effect on the real LED hardware keeps running at the stale old
BPM until the next song switch. This is very likely a real contributor to
"rhythmic effects don't lock to the metronome" as experienced live, on top
of being a distinct bug from actual phase-lock math (which, per the audit,
is already correct and shared by every effect uniformly since `59d000a`).
**Fixed**: an explicit BPM push when editing the active song's own tempo.

### Lighting: phase-lock math itself is already correct

`engine/lighting/LightOutputResolver.h`'s `p.tSec = tempoSync ?
std::max(0.0, tSec) : ...` (absolute transport time, not cue-relative) is
one shared code path used by **every** effect type uniformly — nothing was
individually missed, and `tests/test_light_cue_interpolation.cpp`'s
"addressable tempo effects begin on a deterministic beat phase" test already
asserts the tick-perfect-modulo-cycle invariant. The two staleness bugs
above are the actual defects; the phase math does not need touching. New
tempo-synced effects added in this batch must preserve the same invariant
(same `tSec`/`rateHz` phase convention, verified the same way).

### Lighting: binary WS transport — light data rides it, but nothing reads it yet

`app/web/WebServer.cpp`'s `buildBinaryTelemetryFrame()` (~line 70) already
packs a `LightOutputRow` per addressable fixture (fixture idx, RGB, effect
byte, intensity, meterLevel01, effectTSec, effectRateHz — 22 bytes/fixture)
into the same 60Hz binary frame audio peaks use. **But nothing in the
frontend currently consumes it** — `ui/src/lib/liveLevels.ts`'s
`getLiveLightOutputs()`/`subscribeLiveLightOutputs()` have zero callers; the
actual 3D preview reads `state.lightOutput` from the slower
rAF-coalesced JSON structural frame instead
(`ui/src/components/light/LightSidePanel.tsx`,
`ProjectLightingPanel.tsx`). So the user's instinct ("скорее всего проблема
не в транспорте") was right — the transport work from `e722ec5` is real but
currently inert for lighting, not the bottleneck. Left as-is / not wired up
in this batch (out of scope — the JSON path is already fast enough at
rAF-coalesced ~60fps for a UI preview; wiring the unused binary path up
would be a separate, purely-optional latency optimization, not a bug fix).
Two small correctness bugs found in the unused code path are still worth
fixing so it isn't silently broken *if* it's wired up later:
`effectToByte()` (`WebServer.cpp` ~line 116) and `EFFECT_TYPES`
(`liveLevels.ts` ~line 59) both only list 7 of the 12 effect types (missing
chase/helix/plasma/twinkle/sonicboom, and every new type added in this
batch) — fixed alongside adding the new effect identifiers.

### Lighting: custom gradients are fully persisted but never rendered

`LightCue::gradientColors` (`engine/project/ProjectSchema.h` ~line 227,
"three CSS-style #RRGGBB stops... empty means the built-in preset") is fully
round-tripped through persistence, the HTTP API, and has editor UI
(`LightSidePanel.tsx`, a raw `<input>` textbox, `placeholder="#ff0040,
#7c3aed,#00e5ff"`) — but is **never parsed or consumed anywhere in the
rendering pipeline**, neither the C++ DMX path
(`meterLedColor`/`applyEffect`/`addressableEffectLedColor` only know
`GradientPreset::Solid`/`GreenYellowRed`) nor the 3D preview (`ResoLightStage3D.tsx`
hardcodes the same two-preset branch). Selecting "Custom palette" and typing
hex stops currently has zero visual effect. This batch adds real gradient-stop
parsing/sampling shared by both languages (mirroring the existing
hand-ported-pure-function pattern above) and wires it into every effect that
can meaningfully use a palette (fire effects' color ramp, GEQ's frequency-to-hue
map, Colorwaves, Plasma, etc. — not just Meter), plus replaces the raw
textbox with a real visual gradient-stop editor (add/remove/drag/recolor
stops) since a bare comma-separated hex string is not a serious authoring
tool for a "make custom gradients" feature.

### Lighting: no FFT / spectral analysis exists yet

The research document assumes true FFT spectrum bins (GEQ, Blurz). The audio
engine (`engine/audio/`) currently only has broadband peak/RMS/LUFS metering
(`engine/audio/Metering.h`'s `LoudnessMeter`) — there is no per-band
spectral analysis anywhere in the codebase. Building a full real-time-safe
multi-band FFT analyzer, wiring it through the audio callback, a new
lock-free telemetry channel, `LightEngine`, and the web state, is a
legitimate but substantial real-time-audio-thread change. **Decision**:
implement a lightweight multi-band **energy split** (a small fixed number of
bandpass-filtered energy trackers, reusing the existing real-time-safe
`Biquad` class already in `Metering.h`) instead of a literal FFT — this is a
standard, well-established practical substitute for driving a handful of
visual bands (WLED-class audio-reactive lighting rigs commonly do the same
thing rather than run a full spectral analyzer for 3-6 visual buckets), it's
real-time safe by construction (no allocation, fixed per-sample filter
cost), and it avoids destabilizing the audio callback with a much larger,
riskier change for marginal visual benefit at 120-LED scale. GEQ/Blurz are
implemented against this band-energy signal, documented in code as exactly
that (not literal FFT bins) so nobody later assumes a spectrogram-grade
frequency resolution exists.

## Engineering guardrails

- Native changes are in `/app` and `/engine`; frontend is `/ui` (Vite dev
  server already running — do not restart it for frontend-only changes).
- After each completed feature: run its relevant tests. For native work,
  also run `pnpm test` (must pass) and `pnpm run rebuild:run` before the
  feature's commit, since a native change is only real once the running app
  reflects it. Pure frontend-only changes don't need an app rebuild/restart.
- One feature = one commit, in the existing lowercase Conventional Commit
  style (see `git log --oneline`). Never include AI co-authorship or
  attribution lines in any commit message — the project owner adds
  attribution separately, by hand, later.
- Preserve unrelated working-tree changes. Use `rg`/grep to relocate
  symbols; exact line numbers in this document will drift as the work
  proceeds — they were accurate at time of writing, not a promise.
- Prefer deterministic unit tests for timing, phase/interpolation math, grid
  snapping, and gradient sampling. Do not add shallow tests solely for JSX
  wiring or for trivial getters — match the existing test suite's standard
  (see `tests/test_light_cue_interpolation.cpp` for the house style: pure
  functions, `doctest::Approx`, one invariant per test, comments explain
  *why* a value was chosen, not what the assertion does).
- Whenever a pure math/interpolation function is added or changed in
  `engine/lighting/*.h`, mirror the change in
  `ui/src/lib/lightCueInterpolation.ts` in the same commit (see the
  hand-ported-duplication note above) — the two must never drift, since a UI
  preview that lies about real DMX output is worse than no preview.
- New light effects follow the existing pure-function convention: take
  `(i, totalLeds, type, tSec, rateHz, baseRGB, ...)`-style explicit
  parameters, no internal clock/state reads, so they stay trivially testable
  without a mock clock (unlike `MasterClock` itself, which does need one —
  see `tests/test_master_clock.cpp`'s `FakeClock`).

## Explicitly deferred / out of scope for this batch

- Wiring the frontend to actually consume the binary WS light-output frame
  (`getLiveLightOutputs`/`subscribeLiveLightOutputs`) — currently dead code,
  left in place, corrected for new effect IDs but not activated. The JSON
  path is fast enough for a UI preview; this would be a pure latency
  micro-optimization, not a bug fix.
- A literal FFT/spectrogram analyzer — see the spectral-analysis decision
  above. The band-energy approach is the intended permanent design here, not
  a stopgap to later replace with real FFT, unless a future session decides
  the visual fidelity genuinely requires it.
- DMX/Art-Net/sACN protocol-level changes (universe packing, output rate,
  gamma correction, dual-end power injection) — the research document's
  "practical stage integration" section is infrastructure/electrical advice
  for the venue, not application code; nothing here needs to change for it.
- Any change to non-lighting, non-timeline-playhead parts of the app.
