# Export formats and modal consistency

## Scope

Expose the existing WAV, AIFF, FLAC, ALAC, MP3, AAC/M4A, Opus, Ogg Vorbis,
and WMA render paths accurately. Keep WAV as the default. Align format labels,
integer/float encoding controls, supported output rates, and estimates with
Core's FFmpeg encoder settings. Rendering remains independent of live playback.

Use the shared HeroUI v3 `Modal` override for dialog material and close controls.
Close triggers are direct children of Dialog, not flex items inside Header.
Use the same theme-aware darker background as Card. Preserve busy/non-dismissible
workflows, accessibility, cancellation, and existing content.

## Verification

- Typed format-model tests and controlled render-dialog interactions.
- Shared modal close/layout regression tests, UI build and full test suite.
- Encode and decode every format with the packaged FFmpeg runtime.
- Check actual dialog appearance at narrow and wide sizes.

Status: implementation and verification in progress.
