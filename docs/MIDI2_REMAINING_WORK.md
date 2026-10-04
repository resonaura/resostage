# MIDI 2.0 Support: Implemented Scope and Remaining Work

Status reviewed against file codecs, project schema, Piano Roll editor, and live bridge: 2026-10-04.

This document describes the MIDI 2.0 work currently present in ResoStage and
the gaps that remain before calling the application end-to-end MIDI 2.0
compatible. “MIDI 2.0 file” is not used as a format name here: ResoStage's
MIDI 2.0 file support refers specifically to the MIDI Clip File (`.midi2`),
which stores one timed UMP stream. It is distinct from Standard MIDI Files
(`.mid`, MIDI 1.0) and the SMF2 Container File.

## Implemented

- MIDI 1.0 Standard MIDI File import/export remains the compatibility default.
  Format 0 and Format 1 files are imported; Format 2 is recognized as
  independent sequences and the import dialog requires the user to choose one
  sequence rather than silently stacking unrelated sequences.
- The import dialog accepts `.mid`, `.midi`, and `.midi2`. It supports choosing
  whether to keep beat positions, adapt the file to the project tempo, or use
  the imported tempo map where that choice is meaningful. Imported content is
  placed in MIDI regions and can extend the song as needed.
- MIDI Clip File (`.midi2`) import/export supports the published single-stream
  UMP clip structure, clip framing, delta clocks, tempo and meter Flex Data,
  MIDI 1.0 Channel Voice UMP, MIDI 2.0 Note On/Off, note group, 16-bit attack
  and release velocity, and the note attribute fields represented in the
  current project schema.
- Project schema version 6 introduced MIDI 2.0 note fields and timed opaque UMP
  packets on MIDI regions; the current format 12 retains them. Readable additive older
  formats receive defaults; other older files require `pnpm migrate`. UI state and
  project serialization carry these fields so unsupported UMP packets can
  survive a save/load and MIDI Clip File round-trip.
- The Piano Roll edits normalized note velocity/release velocity and updates
  the corresponding stored 16-bit MIDI 2.0 value so edits do not leave stale
  high-resolution data behind.
- MIDI Clip export is explicit. `.mid` remains the default; `.midi2` must be
  selected by the user. When exporting `.mid`, the dialog reports known
  MIDI 2.0 note/group/attribute/velocity and unsupported-UMP losses and asks
  for confirmation.
- Exporting a subset from a nonzero timeline origin carries the effective
  tempo and meter at that origin into beat zero of the exported clip.
- MIDI Clip export follows region mute, trim and loop placement. At an exact
  loop retrigger tick it orders Note Off before Note On. SMPTE-timed Standard
  MIDI File imports place non-note channel events using the same seconds-to-beat
  conversion as notes and meta events.
- Live and offline instrument playback adapt representable MIDI 2.0 note
  attacks/releases and channel controls to the current MIDI 1.0 JUCE plug-in
  bridge. Note velocity uses the stored 16-bit value for the downconversion;
  the project retains the original UMP/16-bit data for editing and export.
- Piano Roll can discover and preview recognized MIDI 2.0 Channel Voice CC and
  channel Pitch Bend packets in separate UMP lanes. The visual lane scales the
  32-bit packet value to the existing 7-bit/14-bit display range only; stored
  packet words are not changed by preview. Its MIDI 2.0 event dialog can add,
  edit and delete recognized CC/Pitch Bend packets through the exact MIDI-region
  history transaction. Time edits retain the 32-bit data word; group, channel,
  CC index and full unsigned 32-bit value are explicit fields. Unknown, malformed
  and reserved packets are not editable and remain unchanged. Pending region
  creation also carries its UMP collection through the follow-up update. UMP
  controller preview has independent Group and Channel filters, defaults to
  All, discovers choices only from recognized packets in the selected lane,
  and clears stale selections when a source group/channel disappears. In
  Events mode, Draw creates recognized CC/Pitch Bend packets, Select/Draw can
  move a point or a Shift/platform-primary multi-selection, and Erase,
  double-click, and Delete remove only selected/targeted recognized packets.
  These gestures edit `umpEvents` through the separate reliable region draft;
  time movement retains the complete 32-bit data value and value movement maps
  vertical pointer displacement across the full UMP word range. New point
  drafts can be moved before first commit. Trim/loop occurrences map back to
  source beats. Opaque and reserved packets remain unchanged.

## Known limitations

### File formats and round-trip fidelity

- SMF2 Container File is not implemented. Do not label MIDI Clip File support
  as general SMF2 Container support.
- MIDI Clip File is one UMP event stream. Exporting multiple DAW tracks or
  songs merges them into that stream; the export dialog explains this. It does
  not preserve DAW track boundaries as separate UMP streams.
- The MIDI 2.0 note schema represents one attack velocity, one release
  velocity, one group, and one note-attribute type/data pair. It does not yet
  model note IDs, multiple/independent note attributes, or all note-off
  attributes. MIDI 2.0 notes normalized into Piano Roll notes may therefore
  round-trip musically but not byte-for-byte in every expressive edge case.
- Unknown UMP packets are retained as packet words and timing, but ResoStage
  does not interpret or promise playback for message types it does not
  implement. The original UMP stream's exact byte layout, utility packets,
  and ordering around normalized note events are not preserved as a raw file
  blob.
- `.mid` remains inherently lossy for data without a MIDI 1.0 equivalent.
  The loss report is a safeguard, not a universal translator. MPE/vendor
  encodings are not synthesized automatically.
- Piano Roll UMP lanes currently recognize only well-formed two-word MIDI 2.0
  Channel Voice CC and channel Pitch Bend messages with ordinary MIDI 1.0
  fallback semantics. Reserved compound CCs and unsupported packet kinds stay
  opaque. Group/channel filters scope the preview and canvas gestures. Direct
  editing supports point creation, move/value editing, multi-selection,
  deletion, curve shaping and smoothing. Continuous transforms preserve the
  full unsigned 32-bit data word, endpoints, event timing and opaque packets;
  binary pedal CC64–69 are excluded. Range marquee selection and raw event
  cut/copy are not implemented. The semantic event dialog remains available
  for exact field entry.
- The importer has focused unit coverage but no maintained conformance corpus
  from other DAWs and no broad cross-application round-trip certification.

### Live MIDI and plug-ins

- Live MIDI I/O is currently the existing MIDI 1.0 path. ResoStage does not
  yet enumerate/connect MIDI 2.0 UMP endpoints, negotiate MIDI-CI Profiles,
  or preserve MIDI 2.0 resolution from a physical controller through the live
  input path.
- The live instrument/plug-in bridge uses JUCE `MidiBuffer`/MIDI 1.0 events.
  The representable subset above is translated; MIDI 2.0 per-note controllers,
  per-note pitch, high-resolution controllers without a defined MIDI 1.0
  mapping, and native UMP plug-in delivery are not implemented end-to-end.
- The project model and file codec can retain some MIDI 2.0 data without
  implying that the current audio callback, external MIDI output, AU/VST3
  plug-in, or operating-system API can consume that data natively.

## Recommended implementation order

1. **Close file-codec gaps:** add official/reference fixtures for MIDI Clip
   File framing, DCTPQ/DCS edge cases, simultaneous events, SysEx, Flex Data,
   malformed packets, large deltas, and all supported UMP message lengths.
   Specify exact handling for note-off attributes and overlapping same-pitch
   notes; extend the project note model only where round-trip requirements
   justify it.
2. **Continue Piano Roll MIDI 2.0 UMP authoring:** the bounded semantic editor,
   group/channel preview filters, and direct point gestures for recognized
   CC/Pitch Bend packets, plus bounded curve/smoothing transforms, are
   implemented. Next assess marquee and clipboard actions only if they can
   retain packet identity and history semantics. Keep MIDI 1.0 `events` and UMP
   `umpEvents` separate and use the exact MIDI-region history/acknowledgement
   path.
3. **Finish MIDI 1.0 interoperability:** maintain Format 0/1/2 fixtures,
   validate SMPTE timing and tempo/meter maps against independent files, and
   improve the `.mid` loss report so every supported conversion and every
   dropped event category is explicit.
4. **Implement UMP live transport per platform:** enumerate/select UMP
   endpoints, receive/send bounded UMP packets with timestamps, preserve
   groups, and keep OS callbacks separate from the audio callback. Add
   platform-specific device tests and explicit MIDI 1.0 fallback behavior.
5. **Extend the translation layer:** retain the implemented deterministic
   note-velocity and representable channel-control adaptation for MIDI 1.0-only
   instruments. Define policy for remaining high-resolution and per-note data;
   report or reject what has no mapping instead of inventing a vendor encoding.
6. **Add plug-in interoperability only against verified format APIs:** JUCE's
   MIDI 1.0 `MidiBuffer` bridge is not native UMP. Verify AU/VST3/CLAP support
   and host API versions before adding native delivery; otherwise expose the
   supported subset and use the same explicit adaptation layer.
7. **Evaluate SMF2 Container separately:** add it only when the published
   specification and practical interoperability justify support. Keep it a
   separate extension/format option from both `.mid` and `.midi2`.

## Completion criteria for “full MIDI 2.0 support”

Do not use that claim until ResoStage can demonstrate, with tests, all of the
following: project persistence of editable and opaque data; MIDI Clip File
fixtures and round-trips; documented lossy MIDI 1.0 export; platform UMP live
input/output; a defined fallback when any endpoint is MIDI 1.0-only; and an
explicitly documented plug-in capability boundary. SMF2 Container support is
a separate capability and must be named separately.
