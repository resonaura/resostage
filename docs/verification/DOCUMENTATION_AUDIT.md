# Archived documentation audit and synchronization

Historical status: complete source-document review and synchronization with loading, history,
and performance implementations completed on 2026-10-01.

This preserves the original file-by-file audit, not a current task or a claim
that its inventory counts remain unchanged. Current implementation acceptance
is recorded in [STATE_AND_HISTORY.md](STATE_AND_HISTORY.md); unfinished work
is under `docs/ai/tasks`.

## Scope and ownership

Read every repository-owned Markdown file completely, including hidden GitHub
templates, then compare operational and architectural claims with the current
source and tests. Exclude ignored build outputs and third-party dependencies.
The root agent owns `AGENTS.md` and the loading task; implementation agents own
the history and performance task documents. Do not edit legal or trademark
terms as part of a technical documentation audit.

## Plan

1. Inventory tracked and untracked source Markdown and read each complete file.
2. Check paths, supported commands, project schema, telemetry protocol,
   packaging, media import/export, plug-in hosting, MIDI, and automation claims.
3. Correct outdated technical documentation without claiming untested hardware
   or future features as implemented.
4. Consolidate completed task findings into durable reference documents; remove
   a task only when its stated acceptance criteria have been met. Keep remaining
   work explicit, especially platform-validation gaps.
5. Send architectural corrections to the root agent for `AGENTS.md` and record
   the final file-by-file result here.

## Audit inventory

The initial inventory contained 23 Markdown files, including `AGENTS.md` and
this new report. The current inventory contains 26 after completed-task cleanup
and new task/reference documents. Every listed original file was read in full;
new current tasks were also read, not inferred from filenames.

| File | Audit status |
| --- | --- |
| `AGENTS.md` | Read completely; root owns corrections. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Read; technical checklist now references actual bounded ownership/test evidence. |
| `README.md` | Read; corrected C++23, build commands, process diagram, Kaishaku scope, callback and performance claims, media support, sample-peak metering. Legal/product-policy terms retained. |
| `PROJECT_OVERVIEW.md` | Read; corrected live-host boundary, source review date, UDP ownership, media scope, stale marketing-warning text. |
| `CONTRIBUTING.md` | Read; corrected callback/queue invariants and current engineering references; governance terms unchanged. |
| `CLA.md` | Read completely; unchanged legal text, no legal sufficiency conclusion. |
| `TRADEMARK.md` | Read completely; unchanged legal text, no legal sufficiency conclusion. |
| `docs/FFMPEG.md` | Read/source checked; retained actual platform evidence and added remaining acceptance reference. |
| `docs/MIDI2_REMAINING_WORK.md` | Read/source checked; version6 described as introduction, not current format; native UMP limitations retained. |
| `docs/PLUGIN_FAILURE_CONTAINMENT.md` | Read/source checked; corrected two-quanta pipeline and current ABI-v6 power mailboxes; loading/final-test synchronization pending. |
| `docs/PLUGIN_HOSTING.md` | Read/source checked; discovery controls, explicit scan startup, prepared MIDI and benchmark scope documented. |
| `docs/REMOTE_CONTROL.md` | Read; current v9/minimum-v8 distinction and media-worker/cancellation semantics corrected. |
| `docs/architecture/AUTOMATION_MODEL.md` | Read; separated implemented primitives/plugin lanes from unfinished console integration and unsupported numerical claims. |
| `docs/architecture/DAW_TRACK_MODEL.md` | Read; corrected actual song-owned regions/track-strip schema versus proposed workflows. |
| `docs/architecture/MIDI_AND_PIANO_ROLL.md` | Read/source checked; actual bucket complexity, toolbar/gestures, source-loop semantics, MIDI expression boundary, manual acceptance retained. |
| `docs/architecture/PLUGIN_POWER_MANAGEMENT.md` | Read/source checked; actual DSP ownership/ABI-v6 atomic intents documented, fictitious unload/resume guarantees removed; focused verification pending. |
| `docs/architecture/RESOLINK_PROTOCOL.md` | Read/source checked; actual engine packet/PLL foundation versus unimplemented application/distributed transport made explicit. |
| `docs/performance/DAW_BASELINE.md` | Read; kept historical measurements, corrected evidence limits and unrecorded exact hardware details. |
| `docs/performance/PLUGIN_BASELINE.md` | Added from dated first-pass evidence; no heavy-vendor/dropout claim. |
| `docs/ai/tasks/ffmpeg.md` | Read and removed after implementation verification; remaining release acceptance moved to `media.md`/`FFMPEG.md`. |
| `docs/ai/tasks/naming.md` | Read/source checked; kept partial task and corrected nonexistent case-only wrapper claims. |
| `docs/ai/tasks/pianoroll.md` | Read and removed after source verification; unperformed visual/music checks moved into architecture reference. |
| `docs/ai/tasks/plugins.md` | Read and removed; dated implemented first pass preserved in benchmark/hosting; remaining work owned by `performance.md`. |
| `docs/ai/tasks/media.md` | Added precise residual release/platform/endpoint/source-distribution acceptance plan. |
| `docs/ai/tasks/loading.md` | Read; root-owned current implementation plan. |
| `docs/ai/tasks/history.md` | Read; history-agent-owned reproduced causes/plan. |
| `docs/ai/tasks/performance.md` | Read; performance-agent-owned current scope and honest measurements. |
| `docs/ai/tasks/documentation.md` | Current plan/report, read and maintained. |
| `resolight/firmware/README.md` | Read/source checked; protocols/scripts retained, hardware-link screen location corrected. |

## Findings sent to the root agent

- Telemetry is current v9 with a 66-byte base header; the stale AGENTS v8
  statement and moved `lib/audio/liveLevels.ts` path need correction.
- Format9 could not preserve explicit click `soloSafe=false` while parsing used
  a `<10` compatibility override. Root owns a complete format10 fix/migrator/test.
- ResoLink packet/PLL code is currently engine/test-only, not running Core-to-Core
  network/distributed vendor execution. The architectural contract must not
  describe proposed integration as a shipped path.

## Documentation verification

Repository-owned tracked/untracked Markdown was enumerated using Git (including
the hidden GitHub template). Local Markdown-link target check: 26 files, zero
missing targets. `git diff --check` passed. No native/UI build was run by the
documentation owner; recorded test counts remain explicitly dated evidence.

## Verification and limits

This audit changes documentation only. Source inspection can verify ownership
and implementation paths, but cannot establish acoustic correctness, hardware
compatibility, native plug-in behavior, or legal sufficiency. Test results are
reported with their actual source and platform context.
