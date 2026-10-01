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

Imports retain source offsets, extend explicit song boundaries when required,
use unique resources for repeated filenames, and enter shared history only on
success. Multi-file uploads await actual Core completion rather than treating
an HTTP upload acknowledgement as a successful import.

## Packaging

| Platform | Installed worker | Runtime profile |
| --- | --- | --- |
| macOS Apple Silicon | Core `Contents/Helpers/ResoStage Media.app/Contents/MacOS/ResoStage Media` | Build-time Homebrew GPL executable and recursively relocated non-system dylibs |
| macOS Intel | Same branded app/executable | Pinned Evermeet GPL Intel executable |
| Windows x64 / ARM64 | `media.exe` beside `core.exe` | Pinned BtbN GPL shared build, complete sibling DLL set |
| Linux x64 / ARM64 | `resostage-media` beside Core | Pinned BtbN GPL static build |

macOS helper libraries use bundle-relative install names. Architecture and
dependency closure are verified before bottom-up signing. The helper inherits
the Core icon until a dedicated `icons/media.icns` is supplied. Windows uses
`icons/media.ico` when available and otherwise the Core icon. Its PE metadata
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

See `docs/ai/tasks/ffmpeg.md` for current implementation and handoff status.
