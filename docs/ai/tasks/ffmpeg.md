# Embedded FFmpeg integration

## Goal and user requirements

Finish portable audio/video import and audio export using FFmpeg shipped inside
ResoStage on macOS (Apple Silicon and Intel), Windows, and Linux. Runtime media
operations must use the packaged executable/libraries, never a system PATH
lookup. Include a broad GPL codec build, executable branding where applicable,
license/provenance notices, and platform-appropriate metadata. Video import uses
its audio now and retains the original video in the project for future support.

## Architecture and files

- `scripts/ffmpeg-runtime.mjs`: acquire, verify, cache, relocate, validate, and
  install the complete runtime. Build-time package managers are permitted;
  installed applications must be independent of them.
- `scripts/platform/{Mac,Win,Linux}BuildAdapter.mjs`: shipping-shape installation
  before signing/packaging. Follow existing Core/scanner/host conventions.
- `core/app/media/FfmpegProcess.{h,cpp}`: bounded diagnostic capture, argv-based
  process invocation, cancellation, and packaged-helper resolution.
- `core/app/engine/AudioEngineImport.cpp`: decode on the import worker into
  project-local float WAV, build peaks incrementally, preserve video originals,
  and extend the song when needed.
- `core/app/main/render/MainComponentRender.cpp`: production offline renderer
  first, then format conversion on its worker; cancellation and atomic publication
  must cover all outputs.
- `core/engine/project/{ProjectSchema,ProjectJson,ProjectLoader}` and
  `scripts/migrate.mjs`: optional video source reference, format v9, streamed
  large-resource copy, and backward compatibility.
- `ui/src/transfer/{audio,render,workflows}` plus timeline drop/import controls:
  consistent media extensions and export formats. Use existing shared HeroUI
  wrappers and transfer dialogs.

## Implementation plan

1. Audit existing uncommitted integration; preserve the intentional copyright
   header changes and all unrelated work.
2. Make architecture selection explicit. Intel macOS builds cannot embed ARM
   Homebrew binaries. Verify hashes for downloaded packages and reject nonfree
   builds. Relocate every non-system macOS dylib into the bundle and validate
   the complete dependency closure.
3. Resolve packaged paths consistently in raw development and assembled builds.
   Give a ResoStage-created helper the same naming/metadata/icon convention as
   other helpers; upstream FFmpeg remains identified in notices/configuration.
4. Verify media import, original-video retention, multi-file behaviour, duration
   extension, project save/reopen, malformed/no-audio input, and cleanup.
5. Verify export codecs, exact rendered ranges, plug-in processing, cancellation,
   all-or-nothing publication, diagnostics, and output collision handling.
6. Add focused project/process/packaging regression coverage and smoke-test the
   copied runtime with an isolated environment. Run UI/Electron checks and native
   tests/builds. Record actual platform coverage; never infer it from compilation.
7. Update `AGENTS.md` only for implemented deployment/schema/thread boundaries
   and document runtime provenance in `docs/FFMPEG.md`.

## Safety invariants

No FFmpeg process, decode, filesystem work, or wait enters the device callback.
Project mutations stay on the JUCE message thread. Imports and renders use
private snapshots and reject stale completion. Large assets use streamed I/O,
not project-sized vectors. Preserve original resource path validation.

## Status at handoff

In progress. Initial implementation exists in the working tree but has not yet
passed the complete verification matrix. macOS ARM dependency relocation has
been smoke-tested; Intel architecture handling and manifest accuracy still need
completion. Do not treat this initial status as a completed integration.

## Verification log

Update with exact commands, results, platforms, codec probes, and remaining
limitations as work progresses.
