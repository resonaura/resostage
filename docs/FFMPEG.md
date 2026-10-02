# Bundled media conversion

ResoStage ships FFmpeg with the application. Import/export never searches PATH
and never depends on the operator installing FFmpeg or Homebrew. Conversion is
a background operation, separate from live audio and the plug-in DSP helpers.

## Supported workflows

- Audio import accepts WAV/AIFF, FLAC, MP3, AAC/M4A/ALAC, Opus/Vorbis, WMA,
  CAF, and audio streams from common video containers.
- Supported PCM WAV files are retained unchanged. Other media is prepared as
  project-local 48 kHz stereo float WAV, using RF64 when necessary.
- Video import extracts the first audio stream and copies the original video
  under `Video/`. It does not implement synchronized video playback yet.
  A video without an audio stream reports an error instead of an empty region.
- Audio export first uses the production offline graph/instruments/effects,
  then converts the rendered PCM into WAV, AIFF, FLAC, MP3, AAC/M4A, ALAC/M4A,
  Opus, Ogg/Vorbis, or WMA. Conversion never substitutes for plug-in rendering.
  Integer output applies final TPDF dither rather than dithering an intermediate
  float render twice. Output files are published without replacing existing files.
  The export dialog starts with the format picker, defaults to WAV, labels the
  selected encoder in the summary/action, and limits rates/bit depths to the
  selected codec. Lossy formats show their quality profile instead of a misleading
  disabled WAV-encoding field. FLAC/ALAC offer 16/24-bit; WAV/AIFF also offer float.
  The Destination section supports a chosen folder, remembers the last accepted
  folder on the Core device, and offers an explicit reset to the standard
  Exports location. Local Electron uses the OS folder picker; remote/browser
  control accepts an absolute path on the Core computer, not the controller.
  Missing/unwritable/non-directory paths report errors without creating folders
  or altering the saved choice. Files appearing during rendering are preserved
  by exclusive final publication; WAV and codec outputs use the same policy.

Imports retain source offsets, extend explicit song boundaries when required,
use unique resources for repeated filenames, and enter shared history only on
success. Multi-file uploads await actual Core completion rather than treating
an HTTP upload acknowledgement as a successful import.

## Packaging

| Platform | Installed worker | Runtime profile |
| --- | --- | --- |
| macOS Apple Silicon | Core `Contents/Helpers/ResoStage Media.app/Contents/MacOS/ResoStage Media` | Build-time Homebrew GPL executable and recursively relocated non-system dylibs |
| macOS Intel | Same branded app/executable | Pinned Evermeet GPL Intel executable |
| Windows x64 / ARM64 | `core/media.exe` beside `core/core.exe` | Pinned BtbN GPL shared build, complete sibling DLL set |
| Linux x64 / ARM64 | `resostage-media` beside Core | Pinned BtbN GPL static build |

macOS helper libraries use bundle-relative install names. Architecture and
dependency closure are verified before bottom-up signing. Media, scanner, host,
and Kaishaku use the supplied shared `icons/helper.icns` / `icons/helper.ico`
artwork, independent of Core's icon. The media worker's PE metadata
identifies ResoStage's media worker while retaining FFmpeg attribution.

`scripts/ffmpeg-runtime.mjs` defines versioned package URLs/hashes and runtime
cache identity. Build-time Homebrew is not a runtime dependency: all required
non-system libraries are copied into the installed app. The ARM version may
differ from the other platforms; `BUILD.txt` and `CONFIGURE.txt` report the
actual build, not a claimed common version. Cache layout changes invalidate
older layouts. The exact installed executable is probed with a minimal PATH.

The profile enables GPL-compatible codecs and rejects `--enable-nonfree`.
This is broad codec support, not a promise that every optional hardware codec
or every third-party FFmpeg component exists on every platform. Codec and OS
availability still apply. FFmpeg/dependency licenses, source/supplier references,
configuration, and build provenance accompany the worker in `FFmpeg` notices.
Before distributing releases, retain corresponding dependency sources/build
recipes as required by their licenses; runtime notice collection is not a
substitute for source-distribution obligations.

## Bounds and failures

- Source and prepared audio files: 20 GiB each. Copies/decode/peak generation
  stream bounded chunks instead of allocating an entire source file.
- FFmpeg codec thread limit: two per conversion; jobs are serialized by Core.
- Diagnostic retention: 8 KiB. stderr is continuously drained even after the cap.
- Codec job deadline: six hours. Shutdown/cancel kills the child and cleans
  temporary files; these waits occur only on background workers.
- Upload tickets/results: at most 64, with expiry and correlation IDs. HTTP
  bodies stream to unique temporary files; invalid tickets, interrupted uploads,
  disk failure, and queue rejection are explicit errors.
- Legacy action/endpoint names containing `Wav`/`import-wav` remain compatible;
  they now accept audio/video. They must not be renamed without protocol migration.

## Verification

`node scripts/media/smoke.mjs <runtime-directory> [executable-name] [architecture]`
copies the runtime into an unrelated path containing spaces, uses a minimal
environment, and checks real encode/decode and non-silent output for eight
formats, H.264 video audio extraction, and invalid-media failure.

On 2026-09-30 this smoke passed on:

- macOS ARM64 locally, including all 92 relocated dylibs;
- macOS Intel executable locally under Rosetta, not physical Intel hardware;
- Linux x64 on the user's Linux machine;
- Windows x64 on the user's Windows machine, with branded `media.exe` and DLLs.

Branded macOS helper installation and plist validation passed for both macOS
architectures. Native media/project/RF64 tests passed: 20 cases, 21,718 assertions.
Core compiled successfully. ARM64 Windows/Linux packages are selected/pinned;
hardware execution there and a physical Intel macOS pass remain release checks.

## Remaining release acceptance

Integration is implemented. Outer-app assembly/deep signature and real HTTP
export acceptance were verified on macOS ARM64 on 2026-10-01. The acceptance
harness in `scripts/media/acceptance.mjs` exercises all nine output formats,
Unicode custom destinations, Core restart persistence, rejected paths, older
clients and explicit default reset. Actual HTTP import-begin/upload/completion
acceptance also covers audio/video, malformed/no-audio sources, duplicate names,
interrupted upload cleanup, song extension and restart persistence. Import
Undo/Redo and heavy saved-state vendor rendering remain separate checks;
codec smoke does not certify them.
The full native run on 2026-10-01 passed all 542 cases and 287,112 assertions.
Do not infer ARM Windows/Linux or physical Intel Mac coverage from pinned
packages or Rosetta. The current plan is [ai/tasks/media.md](ai/tasks/media.md).
