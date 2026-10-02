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
- `LightEngine.h`: canonical `setBPM()` with `setBpm()` compatibility alias.
- `AudioEngine.h`: canonical `notifyLightEngineBPMChanged()` with `notifyLightEngineBpmChanged()` compatibility alias.
- `CoreMidiDispatcher.{h,cpp}`: canonical `setClockBPM()` with `setClockBpm()` compatibility alias across macOS, Linux, and Windows.
- `WebServer.{h,cpp}` & `WebServerTelemetry.cpp`: canonical `kUDPTelemetryPort` and `registerUDPSubscriber()` with `kUdpTelemetryPort` and `registerUdpSubscriber()` compatibility aliases.
- `LightHardwareServer.{h,cpp}`: canonical `sendFrameOverUDP()` with `sendFrameOverUdp()` compatibility alias.
- `ArtNetPacket.h`: canonical `kArtNetUDPPort` with `kArtNetUdpPort` compatibility alias.
- `PluginPowerManager.h` & `PluginProcessorBank.cpp`: canonical `estimatedDSPSavingsPercent` with `estimatedDspSavingsPercent` compatibility alias and dual assignment.
- `IoPressurePolicy.h`: canonical `IOPressureLevel`, `kIOMinTightFraction`, and `kIOMinCriticalFraction` with legacy aliases.
- `ProjectSchema.h`: canonical `MIDINote`, `MIDIClipEvent`, `MIDIUmpEvent`, `MIDIRegion`, `MIDITriggerType`, `MIDIMapping`, `MIDIConfig` aliases.
- `CoreMidiDispatcher.h`: canonical `MIDICommand`, `MIDICommandKind`, `CoreMIDIDispatcher` aliases.
- `CoreMidiInputListener.h`: canonical `CoreMIDIInputListener` alias.
- `PluginMidiActivity.h`: canonical `PluginMIDIActivity` alias.
- `Midi2Compatibility.h`: canonical `MIDI1CompatibleMessage` alias.
- `WebServer.h` & `WireTypes.h`: canonical `RemoteUDPSubscriber`, `WSubscribeUDPPayload`, and `lastUDPSendTimeSec_` with legacy aliases.
- `WebServerCommands.cpp`: uses canonical `kUDPTelemetryPort`, `wire::WSubscribeUDPPayload`, and `registerUDPSubscriber`.
- `ArtNetPacket.{h,cpp}`: canonical `buildArtDMXPacket()` and `parseArtDMXPacket()` with `buildArtDmxPacket()` and `parseArtDmxPacket()` backward-compatible wrappers.
- `EventDispatcher.cpp`: uses canonical `buildArtDMXPacket()` and `kArtNetUDPPort`.
- `core/tests/test_artnet_packet.cpp`: tests canonical `buildArtDMXPacket()` and validates roundtrip parity against legacy alias.
- `WebServer.h`: canonical `WebCommandKind` values (`BuilderTrackImportWAVBegin`, `BuilderTrackImportWAVUpload`, `BuilderTrackImportWAVDialog`, `BuilderMIDIRegionAdd`, `BuilderMIDIRegionRemove`, `BuilderMIDIRegionUpdate`, `SetMIDIOutput`, `SetMIDIInput`, `SetMIDIVirtualPort`, `MIDILearn`, `MIDILearnCancel`, `MIDIClear`) with legacy aliases.
- `WebServerCommands.cpp`: routes table and dispatch switch use canonical `WebCommandKind` values.
- `MainComponent.h`, `MainComponentBuilderImports.cpp`, `MainComponentBuilderTracks.cpp`, `MainComponentSettingsMidi.cpp`, `MainComponentWebCommands.cpp`: canonical method names (`builderMIDIRegionAdd/Remove/Update`, `builderTrackImportWAVUpload/Dialog`, `settingsSetMIDIOutput/Input/VirtualPort`, `settingsMIDILearn/Cancel/Clear`) with backward-compatible wrappers.
- `AudioEngineProjectApi.h` and `AudioEngineImport.cpp`: canonical `importWAVForTrackAsync()` with `importWavForTrackAsync()` inline wrapper.
- `electron/src/udpTelemetry.ts`: exports canonical `UDPTelemetryStats` and `UDPTelemetryTracker` aliases.
- `ui/src/lib/state/types.ts`: exports canonical `MIDINoteRow`, `MIDIClipEventRow`, `MIDIUmpEventRow`, `MIDIRegionRow`, `MIDIBindingRow` aliases.
- `ui/src/lib/state/api.ts`: canonical `trackImportWAV()`, `trackImportWAVDialog()`, `setMIDIOutput()`, `setMIDIInput()`, `setMIDIVirtualPort()` with backward-compatible wrappers.
- `AudioEngine.h`, `AudioEngineTransportApi.h`, `AudioEngineRoutingApi.h`: canonical `ActiveMIDINoteInfo`, `enqueueIncomingMIDI()`, `getActiveMIDINotes()`, and `syncMIDITransportToCurrentSong()` aliases and wrappers.
- `OfflineMidiEvents.h`: canonical `OfflineMIDIEvent` and `buildOfflineMIDIEvents()` with test coverage in `test_offline_renderer.cpp`.
- `MainComponent.h`: canonical `handleMIDILearnMessage()` wrapper.
- `MidiTransform.h`: canonical `MIDITakeoverMode` and `MIDIRelativeEncoding` with test coverage in `test_midi_takeover.cpp`.
- `CoreMidiDispatcher.h` and `CoreMidiInputListener.h`: cross-platform canonical `MIDIClientRef`, `MIDIPortRef`, and `MIDIEndpointRef` aliases.
- `ProjectSchema.h`: canonical `EventType::MIDINoteOn`, `MIDINoteOff`, `MIDICC`, `MIDIProgramChange`, `HTTP`, `DMX` and `MidiNote::MIDI2Data` alias.
- `PluginHostProtocol.h`: canonical `MIDIEvent` alias.
- `WebServer.h`: canonical `MIDIRegionRow`, `MIDI2Data`, `MIDIEvent`, `UMPEvent`, and `MIDIBinding` aliases.
- `WireTypes.h`: canonical `MIDINote` alias.
- Invariants preserved:
  - Wire formats, persisted `.rsnraset` JSON keys, and HTTP REST endpoint paths remain stable for zero backwards-incompatibility.
  - Vendor JUCE library interfaces (`juce::MidiBuffer`, `juce::MidiMessage`) preserved.
  - Do not create both case-only variants of one header: they collide on common
    macOS/Windows file systems. A future rename needs a two-step Git move and
    reference-aware updates, not ambiguous duplicate paths.

The WAV/UDP/HTTP/DMX/BPM/DSP/IO/MIDI cleanup and references were built and verified on 2026-10-02:
- Native engine tests: 566 passed / 378,188 assertions (`core/build/tests/resostage_engine_tests`).
- Native application target: built and verified with embedded scanner and host helpers.
- Verification harness: `scripts/verification/editor-state.mjs` PASS.
- UI Vitest: 103 test files / 706 tests passed.
- Electron Vitest: 5 test files / 37 unit tests + 2 alias tests passed.
- TypeScript: `pnpm typecheck` passed (0 errors).
- Linter: `pnpm --filter ui lint` passed (0 errors).
Remaining: continue repository-wide inventory of acronym identifiers and filenames as new features land. Preserve external wire/persisted/JUCE spellings.

