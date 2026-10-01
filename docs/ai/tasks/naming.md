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

Completed initial canonical acronym normalization pass on 2026-09-30.
- `PluginMIDIBuffer.h`: canonicalized from `PluginMidiBuffer.h` (`PluginMIDIBuffer`, `PluginMIDICopyResult`, `copyPluginMIDIEventsToHost`).
- `UUID.h`: canonical RFC 9562 `generateUUIDv7()` introduced in `core/engine/project/` with backward-compatible `generateUuidV7()` alias and `UUID.h` header wrapper.
- `WAVStreamDecoder.h` & `WAVMetadata.h`: canonical `WAVStreamDecoder` type alias, `extractTempoFromWAVFile()` helper, and forwarding headers.
- `OfflineWAVWriter.h`: canonical `WAVWriter` type alias and header wrapper.
- `AudioRecordWorker`: canonicalized internal header writer `writeWAVHeader()`.
- `UDPDiscovery.h`: canonical `UDPDiscovery` alias and header wrapper.
- `EventDispatcher.h`: canonical `HTTPTriggerCommand`, `DMXTriggerCommand`, `enqueueHTTP()`, `sendHTTP()`, `enqueueDMX()`, `sendDMX()`.
- `WebServerHTTP.h`: canonical `writeHTTPResponse()` alias and header wrapper.
- Invariants preserved:
  - Wire formats, persisted `.rsnraset` JSON keys, and HTTP REST endpoint paths remain stable for zero backwards-incompatibility.
  - Vendor JUCE library interfaces (`juce::MidiBuffer`, `juce::MidiMessage`) preserved.
  - Dual headers ensure case-insensitive file system safety across macOS, Windows, and Linux.
