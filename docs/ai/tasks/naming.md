# Acronym naming consistency

## Goal and priority

Optional final pass after FFmpeg, plug-in performance, and Piano Roll. In mixed
case identifiers/file names, preserve canonical acronym spelling: WAV, MIDI,
FFmpeg, VST3, AU, API, HTTP, UDP, IPC, DSP, PDC, UUID, BPM, and similar terms.
Folder names remain short lowercase words per the user's convention.

## Plan

1. Inventory inconsistent internal identifiers and filenames, classify internal
   versus persisted/API/protocol/vendor names, and record an explicit mapping.
2. Rename internal symbols/files mechanically with reference-aware updates;
   preserve comments and implementation. Keep external/persisted names stable
   or provide deliberate compatibility handling rather than silently breaking
   projects, IPC, API, imports, or endpoints.
3. Update CMake, TypeScript aliases/imports, scripts, tests, and documentation.
   Case-only file renames must work on case-insensitive macOS/Windows systems.
4. Run native, UI, Electron, and script resolution checks. Avoid mixing broad
   naming cleanup into correctness/performance changes.

## Status

Queued. New integration names should use canonical spelling immediately; a
repository-wide migration has not been started.
