# Mixer Audio Flow controls and routing graph

Added 2026-10-03. Read AGENTS.md, docs/ai/tasks/audit.md,
docs/ai/tasks/performance.md and docs/architecture/PLUGIN_POWER_MANAGEMENT.md
before implementation. This file is a requirements/acceptance contract, not a
claim that the following integration is complete.

## User-visible workflow

- Every actual mixer bus strip (aux/group, main and any bus that can carry
  signal) gets an icon-only graph button directly to the left of Mute, using
  the same compact track-state-button hit area and selected/focus treatment as
  R/I. It opens the existing Audio Flow surface focused on that stable bus ID.
  Do not place the control on fabricated physical output rows that are not
  authorable buses unless their graph focus has defined behavior.
- The graph surface has an explicit focused-node view and a toggle to inspect
  the complete project routing tree. Focus view highlights all reachable
  upstream sources and downstream consumers (and sidechain/plugin-input paths),
  dims unrelated paths without removing them, and updates when the graph
  changes. Full-tree mode restores every graph node/edge. Escape/close,
  keyboard navigation, pan/zoom, and reduced motion follow shared HeroUI
  wrappers and theme tokens.
- Opening from a bus must work in a project with no routes, direct outputs,
  unavailable physical outputs, solo/mute state, hidden buses, and a remote
  Core. Stable IDs, not selected row indices, own graph focus across structural
  updates. If the bus is deleted or the Core project changes while the view is
  open, show an explicit unavailable/focus-cleared state rather than silently
  focusing a different bus at the same index.
- The current graph implementation lives under
  ui/src/screens/settings/audio/{components,logic} and uses the authoritative
  MixGraph HTTP snapshot for audio edges. Reuse that model/dialog, theme
  handling, and fetch contract; do not create a second graph API or poll at
  animation-frame rate.

## Sidechain graph and routing

- Represent sidechain feeds as a distinct typed edge between a source strip and
  an enabled auxiliary input on a particular plugin slot. Normal audio output
  routes remain distinct. Show the plugin endpoint as part of its owning strip
  or as a stable plugin-port node, label source/sidechain kind and channel
  mapping, and use a clear theme-aware line style which cannot be mistaken for
  a main/send route or configured MIDI path.
- Graph payload identity includes source strip, destination strip/plugin slot,
  input bus/port and channel mapping. Validate stale slot, unsupported bus,
  invalid channel count and project epoch before accepting configuration.
  Updates while playing publish a prepared compatible graph without stopping
  transport or restarting unchanged healthy plugin helpers.
- Reject cycles, including sidechain-only feedback, unless a separately
  designed and bounded feedback-delay feature is intentionally added later.
  Source mute/solo, destination bypass, sidechain disablement, source deletion,
  plugin replacement, unavailable helper, latency changes and Offline Render
  must match documented engine routing semantics. Use PDC only where the
  processing graph and plugin bus layout make it correct.
- A full routing editor is not implied by a visualization button. The first
  implementation may expose focus/full-tree inspection only; authoring sidechain
  connections remains a separate project mutation with exact acknowledgement,
  undo/redo, save/reopen and graph publication results.

## Route-layout quality reference

The read-only reference project at /Users/resonaura/resopatch separates graph
adapters, route geometry/pathfinding, post-processing and worker ownership.
Its canvas waits for a complete route snapshot, computes routes away from React
render work, avoids node bodies, handles parallel routes and places labels on
usable path runs. Apply those architectural lessons to the audio graph; do not
copy code or add its packages without license, dependency-size and maintenance
review. ResoStage's graph is smaller and must stay bounded: cap geometry work,
cache positions by topology identity, retain the last complete route set while
re-layout runs, and never recompute route paths for meter/fader telemetry.

The existing implementation already caches layout positions by graph topology,
and bus-origin focus/full-tree viewing is now wired through the Mixer. It still
uses a general React Flow graph and does not provide sidechain-port semantics
or proof that edge curves/labels remain legible in dense crossed routing.
Improve the route strategy with deterministic
crossing-reduction, obstacle-clearance and parallel-lane separation; avoid
adding an unbounded graph worker or introducing visual routes that disagree
with Core's published MixGraph.

## Acceptance

- Focus a track source, aux bus, main, physical output and plugin
  sidechain-input. Verify upstream and downstream paths, cross-bus fan-out,
  send tap labels, direct physical outputs and MIDI dotted routes. Focused and
  full-tree states are reversible and retain stable identity on live refresh.
- Use dense graphs with converging/fan-out paths, parallel sends, long labels,
  hidden/unavailable destinations, muted/soloed branches and repeated refresh.
  Curves and labels must not collide with node bodies or each other more than
  unavoidable topology requires; rerendering meter telemetry must not run layout.
- Test track/bus/slot deletion, reorder, project epoch switch during fetch,
  failed graph read, stale graph result, remote Core, narrow window, light/dark
  themes, reduced motion and keyboard access.
- Before claiming sidechain complete, run live and offline audio parity with a
  real compatible VST3 and AU, channel mapping, PDC, bypass, plugin load failure,
  source deletion, cycle rejection and active playback edits. Synthetic graph
  tests do not prove signal reaches a plugin's auxiliary input.

## Implemented block — mixer bus-origin focus (2026-10-03)

Bus strips (aux and main, including the fixed master lane) now show a compact
icon-only Audio Flow control immediately before Mute/Solo. The selected bus
uses its stable Core strip ID; opening it reuses the Settings graph snapshot,
layout cache, colours and refresh/freeze behaviour. Focus view highlights all
reachable upstream and downstream audio routes and dims unrelated branches;
the header toggles to the un-dimmed full graph. MIDI configuration is retained
in the full graph and is not mislabeled as an audio edge. If a refresh no longer
contains the focused ID, the dialog reports that explicitly and shows the full
graph instead of following a replacement row at the old index.

Bus focus restricts its path walk to typed audio edges while retaining the
complete graph for layout and rendering. A source track's separate MIDI
dispatcher/output configuration therefore cannot be highlighted as though it
were audio passing through the selected bus. Full-tree mode clears that path
highlight without removing the configured MIDI view.

Added regressions for the icon action being bus-only, its pressed state and
activation, stable-ID path reachability around a send bus, target deletion and
project-epoch/session changes during the dialog lifetime, and strict audio-vs-
MIDI path highlighting. UI TypeScript passed; the full UI suite passed 828
tests in 125 files; lint exited 0 with 12 existing warnings in unrelated
files; `git diff --check` passed. This block changes no
Core graph data and makes no sidechain claim. Remote Core, visual density,
stale in-flight graph response and hardware audio acceptance remain open.

## Bounded dense-graph layout — implemented subset (2026-10-03)

The row-order optimizer estimates pairwise crossing work before scoring a
layout. If the estimate is at most 50,000 comparisons per score pass, the
existing four exact crossing-reduction sweeps are retained. Above that
threshold, it performs one deterministic forward/backward barycentre pair and
scores edge vertical span in O(E), avoiding repeated O(E²) scans. The estimate
stops as soon as it crosses the threshold. The existing topology cache keeps
meter/fader-only updates from rerunning either strategy.

The dense regression creates a 160-by-160 all-to-all graph (25,600 edges),
proves the exact-comparison estimate exceeds the budget, and verifies stable
non-overlapping row assignments across repeated layouts. Focused layout tests
passed 21/21; UI TypeScript and changed-file lint passed; full UI and
production-build results are recorded in the latest audit/handoff entry. This
bounds the optimizer's crossing work, not React Flow's O(E) rendering, and
does not prove dense-graph visual legibility or manual interaction quality.
Sidechain port authoring remains unimplemented; graph visualization is tracked
separately below.

## Sidechain model and graph foundation (2026-10-03)

Project format v12 now persists an optional sidechain route on each plug-in
slot: stable source strip ID, auxiliary input bus index and automatic/mono-sum/
left/right channel mode. The current schema allows one source per slot; future
multi-source summing requires an explicit schema and bounded graph design. The
format-v11-to-v12 migration defaults every slot to disconnected. `MixGraph`
exposes typed `MixSidechainEdge` values separately
from ordinary audio routes, rejects missing/self/instrument/invalid-bus
references from the render graph, rejects sidechain feedback cycles against
both ordinary routing and previously accepted sidechain dependencies, and
publishes source mute/solo audibility with each edge. The processor-capable
strips are stably topologically ordered; output lanes remain last. The
processor-layout key includes graph indices and the selected plugin bus index.
A source edit that changes topological order rebinds the index-based processor
table, while unchanged vendor chains are reused by stable identity.

The bounded audio path is wired through `MixRenderer` and
`PluginProcessorBank`: each destination processor receives up to eight
block-local source views, and the selected JUCE auxiliary input bus receives
automatic stereo/mono mapping or the explicit mono-sum/left/right mode. The
live-host shared-memory ABI is v11; each audio slot carries the bounded samples
and descriptors, and the helper reads only the current block's sample count.
Offline rendering uses the same renderer and in-process plug-in bank. Sidechain
audio remains independent from the destination's normal insert input and obeys
source mute/solo plus automation mute. The callback path must remain
allocation-free.

Serialization, migration, graph, protocol, renderer and allocator tests pass;
CTest passes 1/1. The two real-macOS-AU editor-window integration cases also
pass on a focused rerun (2/2, 78 assertions). One earlier direct full-binary run
transiently failed their editor open/close requests after the helpers were
ready and had rendered audio; keep that flaky observation separate from
sidechain work. This is not yet complete user-facing support: sidechain-path
PDC/alignment, route-authoring and validation UI,
and real AU/VST sidechain fixtures remain open.
Unsupported bus bindings warn during bank preparation and degrade to the
normal plug-in path; do not claim full compatibility until the remaining
stages and acceptance tests pass.

## Sidechain route visualization (2026-10-03)

The explicit `/api/v1/audio/mixgraph` response now has a separate
`sidechainEdges` collection. Each edge carries source/destination strip IDs,
stable plug-in slot ID and display name, auxiliary bus index, channel mode,
and resolved source audibility. Core projects only edges already present in
the published render graph and validates the slot index while creating the
view snapshot; a stale edge is omitted rather than assigned to another slot.

Settings > Audio Signal Flow renders these as dashed, track-coloured edges
with labels identifying the plug-in, bus and channel mode. Focused bus paths
include sidechain edges but continue excluding configured MIDI paths. The
ordinary graph and MIDI edge semantics are unchanged; older Core responses
without `sidechainEdges` remain valid. This is inspection only: users cannot
create/change a route from the graph yet, and a configured but unsupported
plug-in bus is still a runtime warning rather than a UI validation error.

Focused Signal Flow model/layout tests passed (32 tests); full UI passed 917
tests in 138 files. TypeScript, production UI build, changed-file lint,
optimized Core/helper build, native CTest (1/1), and `git diff --check` passed.
Packaged/remote response and visual theme/density checks remain open.

## Auxiliary bus capability discovery (2026-10-03)

The live helper now publishes a bounded immutable list of each hosted slot's
auxiliary input buses before its Ready state. It includes stable slot-local bus
index, channel count, display name and enabled state; the main input is
excluded. The Core parameter metadata endpoint returns this alongside existing
plug-in parameter descriptors, with a truncation flag and optional UI typing
for compatibility with older Core builds. In-process/offline banks use the
same non-realtime bus inspection and do not toggle buses merely to discover
them. The callback does not enumerate buses or allocate.

The shared-memory layout is ABI v11. Helper-generation replacement naturally
replaces this capability snapshot; clients must not infer "no sidechain bus"
while `loadState` is loading/failed, and must check the truncation flag before
treating an absent entry as conclusive. This discovery does not yet expose
route authoring or prove that a vendor can process the bus audibly. Unsupported
saved bindings remain an explicit preparation warning.
