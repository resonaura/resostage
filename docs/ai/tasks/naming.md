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
- `core/engine/audio/streaming/WAVStreamDecoder.{h,cpp}` and
  `WAVMetadata.{h,cpp}` now use canonical filenames and symbols. The legacy
  `WavStreamDecoder` type and `extractTempoFromWavFile()` spellings remain as
  source-compatibility aliases/wrappers.
- `core/app/engine/OfflineRenderer.cpp`: canonicalized `WAVSource` with backward-compatible
  `WavSource` alias.
- `core/app/engine/OfflineWAVWriter.{h,cpp}` now uses canonical filenames, `WAVWriter`,
  and `finalizeWAVFile()`; `WavWriter` and `finalizeWavFile()` remain as source-compatibility aliases.
- `AudioRecordWorker`: canonicalized internal header writer `writeWAVHeader()`.
- `core/app/network/UDPDiscovery.{h,cpp}` now uses canonical filenames and
  `UDPDiscovery`; `UdpDiscovery` remains as a source-compatibility alias.
- `EventDispatcher.h`: canonical `HTTPTriggerCommand`, `DMXTriggerCommand`, `enqueueHTTP()`, `sendHTTP()`, `enqueueDMX()`, `sendDMX()`.
- `core/app/server/WebServerHttp.h`: internal callers use canonical
  `writeHTTPResponse()`; the old `writeHttpResponse()` spelling remains as a
  compatibility wrapper. No separate case-only `WebServerHTTP.h` exists.
- `EventDispatcher` internal callers use canonical HTTP/DMX type and method
  spellings; legacy spellings remain as compatibility wrappers/aliases.
- `WAVMetadata.{h,cpp}`: canonical `parseBPMFromName()` and `stripBPMSuffix()` with
  backward-compatible `parseBpmFromName()` and `stripBpmSuffix()` wrappers.
- `TempoMap.h`: canonical `fallbackBPM()` with `fallbackBpm()` compatibility alias.
- `ClickGenerator.h`: canonical `currentBPM()` with `currentBpm()` compatibility alias.
- `PluginPowerManager.h`: canonical `estimatedDSPSavingsPercent` with `estimatedDspSavingsPercent` compatibility alias.
- `IoPressurePolicy.h`: canonical `IOPressureLevel`, `kIOMinTightFraction`, and `kIOMinCriticalFraction` with legacy aliases.
- `ProjectSchema.h`: canonical `MIDINote`, `MIDIClipEvent`, `MIDIUmpEvent`, `MIDIRegion`, `MIDITriggerType`, `MIDIMapping`, `MIDIConfig` aliases.
- `CoreMidiDispatcher.h`: canonical `MIDICommand`, `MIDICommandKind`, `CoreMIDIDispatcher` aliases.
- `CoreMidiInputListener.h`: canonical `CoreMIDIInputListener` alias.
- `PluginMidiActivity.h`: canonical `PluginMIDIActivity` alias.
- `Midi2Compatibility.h`: canonical `MIDI1CompatibleMessage` alias.
- `WebServer.h` & `WireTypes.h`: canonical `RemoteUDPSubscriber` and `WSubscribeUDPPayload` aliases.
- Invariants preserved:
  - Wire formats, persisted `.rsnraset` JSON keys, and HTTP REST endpoint paths remain stable for zero backwards-incompatibility.
  - Vendor JUCE library interfaces (`juce::MidiBuffer`, `juce::MidiMessage`) preserved.
  - Do not create both case-only variants of one header: they collide on common
    macOS/Windows file systems. A future rename needs a two-step Git move and
    reference-aware updates, not ambiguous duplicate paths.

The WAV/UDP/HTTP/DMX/BPM/DSP/IO/MIDI cleanup and references were built and the native test target
passed on 2026-10-01 (558 tests / 327,352 assertions). Remaining: continue the repository-wide inventory of
acronym identifiers and filenames, migrate any remaining internal uses away
from transitional aliases, and run UI/Electron/script plus supported platform
build and resolution checks. Preserve external wire/persisted/JUCE spellings
unless a deliberate compatibility change is made. Do not mark this task done
until that inventory and verification are complete.
