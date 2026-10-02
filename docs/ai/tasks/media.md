# Bundled media release acceptance

Status: integration implemented; final acceptance and unavailable hardware
coverage remain. Replaces the completed implementation task on 2026-10-01.

## Existing implementation

The complete bundled FFmpeg import/export architecture, platform runtime paths,
codec profiles, bounds, upload tickets, cancellation, source retention, and
recorded x64/Apple Silicon tests are documented in [FFMPEG.md](../../FFMPEG.md).
Do not reimplement it or introduce a runtime PATH/package-manager dependency.

## Remaining validation plan

1. The macOS ARM64 application assembly, deep strict signature, helper icon/
   metadata probes and installed HTTP export invocation passed on 2026-10-01.
   Repeat these checks for release artifacts and the remaining platforms.
2. Exercise actual HTTP import-begin/upload/completion: successful audio/video,
   no-audio video, corrupt source, duplicate filename, cancelled/disconnected
   upload, queue rejection, and song boundary extension. Confirm failure leaves
   no region/history/temporary file and success survives save/reopen.
3. Nine-format HTTP graph-to-codec export and custom destination persistence/
   validation are covered by `scripts/media/acceptance.mjs`. Still exercise
   production export with heavy saved AU/VST3 state,
   multiple stems/ranges, cancellation, and output collisions. Verify effects
   are rendered before conversion and publication remains all-or-nothing.
4. Run complete suites after concurrent changes. Report AU/vendor fixture skips
   and build-load timing failures instead of hiding them behind a later retry.
5. Obtain actual Windows ARM64, Linux ARM64, and physical Intel Mac execution
   when those machines are available. Rosetta/x64 tests do not certify them.
6. Before distribution, complete corresponding dependency source/build-recipe
   retention required by the supplied licenses. Collected notices alone do not
   establish source-distribution compliance.

## Ownership

Packaging: `scripts/ffmpeg-runtime.mjs`, `scripts/media/`, platform adapters.
Background conversion: `core/app/media/FFmpegProcess` and import/render workers.
Reliable upload: WebServer ticket/result state and transfer workflows. Project
mutations remain on the message thread; no media work enters the callback.

Acceptance harnesses can set `RESOSTAGE_SETTINGS_FILE` to an absolute temporary
settings-file path so saved audio/MIDI devices, recent projects, and bindings on
the user's rig are not changed. Relative override paths are ignored. This is a
diagnostic preference-file override, not a runtime FFmpeg lookup or a substitute
for isolating project/output paths too.
