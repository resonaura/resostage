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

Initial symbol/alias normalization was implemented on 2026-09-30; the repository
wide naming pass remains incomplete. Source inventory reviewed 2026-10-01.
- `PluginMIDIBuffer.h`: canonicalized from `PluginMidiBuffer.h` (`PluginMIDIBuffer`, `PluginMIDICopyResult`, `copyPluginMIDIEventsToHost`).
- `core/engine/project/Uuid.h`: canonical RFC 9562 `generateUUIDv7()` with the
  backward-compatible `generateUuidV7()` alias. There is no separate `UUID.h`
  wrapper in the current inventory.
- `core/engine/audio/streaming/WavStreamDecoder.h` and `WavMetadata.h`: canonical
  `WAVStreamDecoder` type alias and `extractTempoFromWAVFile()` forwarding helper;
  the legacy filenames remain. No case-only forwarding headers are present.
- `core/app/engine/OfflineWavWriter.h`: canonical `WAVWriter` type alias in the
  existing header; the filename remains unchanged.
- `AudioRecordWorker`: canonicalized internal header writer `writeWAVHeader()`.
- `core/app/network/UdpDiscovery.h`: canonical `UDPDiscovery` alias in the
  existing header, without a separate case-only wrapper.
- `EventDispatcher.h`: canonical `HTTPTriggerCommand`, `DMXTriggerCommand`, `enqueueHTTP()`, `sendHTTP()`, `enqueueDMX()`, `sendDMX()`.
- `core/app/server/WebServerHttp.h`: canonical `writeHTTPResponse()` forwarding
  helper in the legacy header; no separate `WebServerHTTP.h` exists.
- Invariants preserved:
  - Wire formats, persisted `.rsnraset` JSON keys, and HTTP REST endpoint paths remain stable for zero backwards-incompatibility.
  - Vendor JUCE library interfaces (`juce::MidiBuffer`, `juce::MidiMessage`) preserved.
  - Do not create both case-only variants of one header: they collide on common
    macOS/Windows file systems. A future rename needs a two-step Git move and
    reference-aware updates, not ambiguous duplicate paths.

Remaining: inventory all internal identifiers/callers, choose actual canonical
filenames where safe, migrate internal usages away from transitional aliases,
and run the full cross-language build/resolution matrix. Preserve external
wire/persisted/JUCE spellings unless a deliberate compatibility change is made.
