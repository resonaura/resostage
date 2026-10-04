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
  and release velocity, and independent Note-On and Note-Off Attribute
  Type/Data pairs. MIDI 2.0 Note On with zero velocity remains Note On; the
  MIDI 1.0 UMP zero-velocity Note On convention is treated as Note Off.
- JR Clock and JR Timestamp Utility UMPs are retained as ordered opaque events
  through project and MIDI Clip round-trips. ResoStage does not interpret JR
  sender-clock time or use it as the project timeline; MIDI Clip DCS remains
  the file's timing authority. NOOP reset packets are consumed as framing, and
  reserved bits are checked for DCS, DCTPQ, NOOP, and JR timing messages.
- MIDI Clip File parsing requires one DCTPQ with its preceding zero DCS,
  clockstamped Start/End markers, no bytes after End, and at most 200,000
  retained UMP events. Export enforces the same event cap while collecting
  output (including loop expansion), rather than after building an oversized
  intermediate list. Long DCS gaps are emitted with bounded DCS/NOOP resets.
- MIDI Clip File musical event beats and duration are normalized to the
  accumulated tick position at Start of Clip. Timed configuration-header
  packets before Start are retained at beat zero (and tempo/meter Flex Data is
  interpreted at beat zero), so setup pre-roll cannot shift notes. Project
  format v13 persists whether opaque UMP events belong to the receiver
  configuration header, and whether an unclockstamped SysEx7 packet belongs to
  its profile prefix. Export restores profile packets before DCTPQ and receiver
  setup packets between DCTPQ and Start; configuration is emitted once per
  contributing region and is never loop-expanded or trim-shifted. The parser
  structurally accepts only SysEx7 UMP packets as a potential profile prefix;
  it does not decode MIDI-CI Profile transactions.
- Configuration-header Set Tempo and Set Time Signature messages are checked
  separately from sequence events: each is limited to one; configuration tempo
  must be the first event after DCTPQ, and configuration time signature must
  immediately follow that tempo. Multiple tempo changes in Clip Sequence Data
  remain supported.
- Project schema version 6 introduced MIDI 2.0 note fields and timed opaque UMP
  packets on MIDI regions; current format 15 retains them, optional MIDI Clip
  configuration-section identity, separate release attributes, source
  presentation order for simultaneous note edges and opaque sequence UMP, and
  the optional `thirtySecondsPerQuarter` and
  `midiClocksPerMetronomeClick` signature-point fields.
  Readable additive older
  formats receive defaults; other older files require `pnpm migrate`. UI state and
  project serialization carry these fields so unsupported UMP packets can
  survive a save/load and MIDI Clip File round-trip.
- For overlapping MIDI 2.0 notes, matching is scoped by UMP Group, Channel and
  Note Number. Repeated overlapping events with the same key are paired FIFO;
  Attribute Type/Data are never treated as a note ID. Different Note Numbers
  naturally remain distinct note rows.
- The Piano Roll edits normalized note velocity/release velocity and updates
  the corresponding stored 16-bit MIDI 2.0 value so edits do not leave stale
  high-resolution data behind.
- Matched same-tick MIDI 1.0/MIDI 2.0 Note On/Off pairs retain zero musical
  duration through file import/export, tempo adaptation, project state, live
  playback and offline rendering. Piano Roll gives zero-duration point notes a
  minimal visible/hit target. Their attack is delivered before their same-sample
  release; receivers are not guaranteed to produce audible sound for them.
- MIDI Clip export is explicit. `.mid` remains the default; `.midi2` must be
  selected by the user. When exporting `.mid`, the dialog reports known
  MIDI 2.0 note/group/attribute/velocity and unsupported-UMP losses and asks
  for confirmation. Representable MIDI Clip receiver-configuration Channel
  Voice packets are emitted at the beginning of the Standard MIDI File track,
  independent of region trim/loop; unsupported profile-prefix SysEx7 remains
  listed as a lossy event.
- MIDI 1.0 event conversion between SMF and MIDI Clip now handles valid
  channel-voice messages, supported System Common/Real-Time messages, and
  complete/fragmented SysEx7. SMF F0/F7 framing is converted to UMP MT3
  Complete/Start/Continue/End packets and back; real-time messages may remain
  interleaved while a SysEx message is open. MIDI 2.0 Program Change with
  Bank Valid set expands to ordered MIDI 1.0 CC 0, CC 32, then Program Change;
  with Bank Valid clear it emits only Program Change and validates the required
  zero bank fields. Invalid reserved bits are rejected. Export warns before
  dropping ambiguous F7 escape events, unsupported SMF meta events, malformed
  or interrupted SysEx, and other unrepresentable raw events. Nonzero UMP
  Groups are not representable in SMF and are reported before export. MIDI 2.0
  RPN/NRPN UMPs expand to the ordered MIDI 1.0 selector MSB, selector LSB,
  Data Entry MSB, and Data Entry LSB messages; reserved address bits are
  rejected. In the reverse direction, MIDI 1.0 CC 0/32 are accumulated per
  channel and folded into the next Program Change. RPN/NRPN CC sequences are
  assembled per channel: CC 6 is buffered until CC 38, a following selector or
  Data Entry MSB, or end-of-track; CC 38 is optional. The legal RPN null
  selection is ignored, while unmatched Bank Select, orphan/incomplete Data
  Entry, and incomplete parameter selection are reported rather than encoded
  as ordinary MIDI 2.0 CCs. Ordinary RPN/NRPN values use Appendix D.1
  min/center/max scaling in both directions. Standard RPN 0x0000 uses its
  7+7-bit Pitch Bend Range layout, while RPN 0x0002/0x0003/0x0004/0x0006 use
  their defined top-seven-bit integer fields with reserved low bits
  zero-extended or ignored as specified. During MIDI Clip export, selected raw
  MIDI 1.0 events are projected
  through region trim/loop placement, ordered on the merged output timeline,
  then translated as one channel-state stream. Bank, RPN/NRPN, and SysEx
  continuation state can therefore span selected regions, tracks, and
  concatenated songs. Simultaneous events have deterministic order by output
  tick, selected track/region order, loop occurrence, and source event order.
  Loss analysis uses the same beat-offset track selection and loop setting.
  These field layouts follow [UMP & MIDI 2.0 Protocol v1.1.1 §7.4.7.1](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).
- Standard MIDI File import folds MIDI Association CA-031 CC 88 High Resolution
  Velocity Prefix into the next Note On/Off velocity on the same channel;
  other MIDI messages may intervene, each note edge consumes the prefix
  once, and a zero-velocity Note On used as Note Off ignores it. Matched
  prefixes are stored in the note's MIDI 2.0 16-bit velocity fields; unpaired
  CC 88 remains a raw event and is reported when MIDI Clip export cannot map it.
  MIDI 2.0 note-to-SMF export emits CC 88 when the 14-bit value has a nonzero
  low component, preserving the MIDI 1.0 high-resolution representation.
  Conversion from 16-bit to 14-bit velocity is included in the export loss
  analysis. Reference: [MIDI Association CA-031](https://midi.org/high-resolution-velocity-prefix)
  and UMP & MIDI 2.0 Protocol v1.1.1 §D.2.1.
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
  source beats. UMP CC/Pitch Bend points support curve/smoothing transforms,
  bounded Select-tool range marquee (including additive platform-primary
  selection), and internal cut/copy/paste. Clipboard packets retain exact
  words, lane, Group, Channel, and relative beat spacing; cut/paste commits
  through the same reliable UMP region history path. Paste uses the playhead's
  trim/loop-mapped source beat and wraps offsets into the region's active loop
  window. The internal clipboard survives Piano Roll unmounts but is not the
  system clipboard. Opaque and reserved packets remain unchanged.

## Known limitations

### File formats and round-trip fidelity

- SMF2 Container File is not implemented. Do not label MIDI Clip File support
  as general SMF2 Container support.
- MIDI Clip File is one UMP event stream. Exporting multiple DAW tracks or
  songs merges them into that stream; the export dialog explains this. It does
  not preserve DAW track boundaries as separate UMP streams.
- The normalized MIDI 2.0 note schema represents one attack/release velocity,
  one group, and one attribute pair for each edge. It does not retain original
  packet byte layout or model arbitrary per-note controller lifetimes as note
  metadata. Overlapping events sharing the same Group/Channel/Note Number use
  FIFO pairing; no independent note-instance identity is persisted beyond the
  protocol's note number. MIDI Clip normalized notes may therefore preserve
  musical semantics without being byte-for-byte identical in every expressive
  edge case.
- Unknown UMP packets are retained as packet words and timing, but ResoStage
  does not interpret or promise playback for message types it does not
  implement. The original UMP stream's exact byte layout is not preserved as a
  raw file blob. JR Clock/Timestamp are retained opaquely; their sender-clock
  domain is not mapped to project time or playback scheduling. Project v15
  preserves source order for simultaneous normalized note edges and opaque
  sequence packets. Tempo/meter Flex Data is normalized through project maps,
  while the Set Time Signature 1/32-notes-per-quarter field is preserved by
  each song signature point. The MIDI 1.0 `FF 58` metronome-click interval is
  also preserved as `midiClocksPerMetronomeClick` in project state and SMF
  import/export. This byte has no MIDI 2.0 Set Time Signature equivalent;
  `.midi2` export warns and requires confirmation when a selected song uses a
  non-default value. Configuration-header section identity is
  persisted, but its elapsed DCS timing is intentionally flattened to beat
  zero. Before DCTPQ, only complete MIDI-CI Set Profile On SysEx7 messages are
  accepted and retained as opaque
  packets; the profile payload is not interpreted and no MIDI-CI negotiation
  is performed.
- `.mid` remains inherently lossy for data without a MIDI 1.0 equivalent.
  The loss report is a safeguard, not a universal translator. In particular,
  a MIDI 2.0 zero-velocity Note On is a valid attack but cannot be written as a
  MIDI 1.0 zero-velocity Note On (which means Note Off); the exporter raises it
  to velocity 1 and reports this conversion separately from ordinary 7-bit
  velocity quantization. It also reports high-resolution MIDI 2.0 CC, pressure,
  pitch-bend and ordinary RPN/NRPN values when conversion to MIDI 1.0 loses
  meaningful bits; fixed-width reserved fields in special RPNs and CC84/CC126
  are not misreported as quantization. SysEx8, Mixed Data Set, MIDI-CI negotiation/profile
  semantics, vendor-specific translations, and arbitrary system/meta events
  are not synthesized automatically. An SMF F7 event without an open F0 is
  ambiguous between a continuation and an escape event; ResoStage does not
  guess. An unpaired MIDI 1.0 CC 88 prefix remains unrepresentable in the MIDI
  Clip event stream and is disclosed; successfully matched prefixes are attached
  to notes. Loss analysis only treats UMPs actually emitted to SMF as
  interruptions to an open SysEx7 sequence; omitted unsupported packets are
  reported separately and do not create a duplicate false SysEx warning.
  MPE/vendor encodings are not synthesized automatically.
- Piano Roll UMP lanes currently recognize only well-formed two-word MIDI 2.0
  Channel Voice CC and channel Pitch Bend messages with ordinary MIDI 1.0
  fallback semantics. Reserved compound CCs and unsupported packet kinds stay
  opaque. Group/channel filters scope the preview and canvas gestures. Direct
  editing supports point creation, move/value editing, multi-selection,
  deletion, curve shaping and smoothing. Continuous transforms preserve the
  full unsigned 32-bit data word, endpoints, event timing and opaque packets;
  binary pedal CC64–69 are excluded. Canvas marquee selection now supports
  visible points and additive Shift/platform-primary selection. Internal
  cut/copy/paste now preserves complete selected packet words and relative
  timing, uses exact region history edits, and wraps pasted points through the
  source loop window. It does not bridge to the OS clipboard. The semantic
  event dialog remains available for exact field entry.
- The parser/exporter now have focused structural, timing, long-gap and
  capacity tests, but there is no maintained reference-file corpus from other
  DAWs and no broad cross-application round-trip certification. Use the
  [MIDI Clip File Specification v1.0](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf)
  as the source for future conformance fixtures; do not infer rules from an
  implementation that conflicts with the published specification.

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

1. **Continue file-codec conformance:** add official/reference fixtures for
   MIDI Clip File profiles/configuration messages, simultaneous events,
   SysEx, Flex Data, malformed packets, large deltas, and all supported UMP
   message lengths. Existing tests cover core DCTPQ/DCS framing, Start/End,
   shared deltas, long-gap resets, size caps, separate note-edge attributes,
   zero-velocity protocol differences, and FIFO overlap matching. Add
   independent reference files before claiming cross-DAW conformance.
2. **Continue Piano Roll MIDI 2.0 UMP authoring:** the bounded semantic editor,
   group/channel preview filters, direct point gestures, curve/smoothing,
   marquee selection and internal cut/copy/paste for recognized CC/Pitch Bend
   packets are implemented. Keep MIDI 1.0 `events` and UMP `umpEvents`
   separate and use the exact MIDI-region history/acknowledgement path. Add
   tests for clipboard behavior to future gesture or loop-timing changes.
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

### Latest continuation — MIDI Clip configuration-section round-trip (2026-10-04)

Project format v13 now retains the section identity of opaque receiver-
configuration UMP packets and the unclockstamped SysEx7 prefix. Import/export
keeps the profile prefix before DCTPQ and other setup packets after DCTPQ but
before Start. Configuration setup is emitted once for each contributing
region, outside region trim and loop expansion. Piano Roll CC/Pitch Bend
discovery and editing ignore these packets and equality checks treat absent
optional flags as the default false value. Parser framing validates profile
prefix clocking, the DCTPQ zero clockstamp, and configuration tempo/meter's
permitted zero-clockstamp inheritance. This preserves section placement only:
elapsed configuration pre-roll still flattens to beat zero, and no MIDI-CI
Profile payload is decoded or negotiated. Focused codec/editor tests passed
50/50; the full UI suite passed 1,033/1,033 across 151 files; TypeScript and
production UI build passed. Lint passed with 12 existing warnings outside this
change, and `git diff --check` passed. Do not infer broad SysEx or profile
interoperability.

### Latest continuation — MIDI 1.0 export of configuration setup (2026-10-04)

When exporting `.mid`, representable MIDI Clip receiver-configuration UMP
Channel Voice messages are converted to SMF track-start events. They ignore
region trim and loop expansion because SMF has no separate receiver setup
section. Unrepresentable profile-prefix SysEx7 is omitted from the SMF payload
and remains counted by the existing unsupported-UMP loss report. A regression
covers a trimmed, looped region with setup Program Change, sequence Program
Change and notes. Focused Standard MIDI/MIDI Clip tests passed 35/35; full UI
passed 1,034/1,034 across 151 files; TypeScript and production UI build passed;
lint passed with 12 existing unrelated warnings; diff check passed. This does
not add full MIDI 2.0-to-1.0 conversion for unsupported UMP packet kinds.

### Latest continuation — MIDI 2.0 note-edge fidelity (2026-10-04)

Project format v14 stores Note-On and Note-Off Attribute Type/Data separately.
The external migrator upgrades v13 by copying Note-On fields into release
fields, matching the prior writer's behavior; the Core reader applies the same
fallback when a v13 project is opened directly. MIDI Clip import preserves the
actual Note-Off fields and export writes them back. MIDI 2.0 Note On at zero
velocity remains an attack, while a type-2 MIDI 1.0 UMP zero-velocity Note On
remains a release. Repeated overlap with the same Group/Channel/Note Number is
paired FIFO; note attributes are not identity tokens. This does not complete
platform UMP endpoints or general SMF2 Container support.
The zero-velocity and note-edge rules are based on the official [UMP and MIDI
2.0 Protocol Specification v1.1.1](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

### Latest continuation — simultaneous MIDI Clip event order (2026-10-04)

Project format v15 retains the original packet index on MIDI 2.0 note attack
and release edges (`midi2.attackOrder` / `midi2.releaseOrder`) and opaque UMP
sequence events (`presentationOrder`). Import → project save/load → `.midi2`
export now preserves the order of imported note and raw-UMP events that land on
the same output tick, including same-pitch overlapping note retriggers. Export
sorts using the final integer TPQ tick, avoiding `double` beat drift. When a
region loop is expanded, copied occurrences deliberately use deterministic
Note Off-before-Note On ordering rather than reusing stale source indexes.
Newly authored events and projects predating v15 use the same fallback (`-1`
means no source order). Migration defaults invalid or missing indexes outside
0–200,000 to `-1`; direct Core reads use the same default.

This preserves only note-edge and opaque UMP sequence ordering. Set Tempo and
Set Time Signature Flex Data continue through the project's tempo/meter model,
so their original packet interleaving is not retained. MIDI-CI, physical UMP
endpoints, SMF2 Container, and complete plug-in UMP playback remain open.
Validation for this block: MIDI Clip codec tests 18/18, migration tests 9/9,
full UI tests 1,039/1,039 across 151 files, TypeScript, production build, and
changed-file lint passed. Core RelWithDebInfo build and CTest passed (1/1 test
target); project JSON coverage includes round-trip, missing legacy fields, and
out-of-range order values. `git diff --check` passed. This does not establish
full MIDI Clip conformance: source order for extracted tempo/meter Flex Data,
independent profile/configuration references, SysEx interoperability, broad
malformed-packet fixtures, MIDI-CI, native UMP endpoints, SMF2 Container and
complete plug-in UMP playback remain open. See the task handoff/audit for exact
next steps and commit status.

### Latest continuation — MIDI-CI profile-prefix validation (2026-10-04)

Profile data before DCTPQ is now recognized as MIDI-CI Set Profile On rather
than treating every SysEx7 packet as profile configuration. The parser and
writer require complete SysEx7 UMP message framing, consistent continuation
by Group, legal 7-bit payload bytes and zero reserved padding; the reassembled
prefix must identify Set Profile On and contain its minimum fixed fields.
Payload bytes remain opaque and are preserved exactly. This does not negotiate
MIDI-CI, validate the profile's meaning, or add UMP device support.

Coverage includes a complete three-packet profile fixture, profile/config
round-trip even when a source region has no musical events, rejecting Set
Profile Off in the prefix, rejecting incomplete framing on import/export, and
rejecting timestamped profile packets. The format rules follow MIDI Clip File
v1.0 sections 6 and 7 and MIDI-CI v1.2 section 7.8; the wire encoding follows
UMP SysEx7 rules in UMP & MIDI 2.0 Protocol v1.1.1. Validation passed: codec
tests 22/22, full UI 1,043/1,043 across 151 files, TypeScript, production UI
build, changed-file lint, migration tests 9/9, Core test target build/CTest
(1/1), and `git diff --check`.

### Latest continuation — reject MIDI-CI Property Exchange in sequence data (2026-10-04)

MIDI Clip sequence import and export now reject MIDI-CI Property Exchange
SysEx7 messages (Universal SysEx + MIDI-CI Sub-ID #1 + Property Exchange
Sub-ID #2 `0x30`–`0x3F`) as required by the file format. Detection carries a
bounded prefix across UMP Start/Continue/End fragments by Group. Ordinary
non-MIDI-CI SysEx7 remains allowed. Sequence SysEx7 structure also rejects a
continuation without a Start, overlapping same-Group starts, and unfinished
messages; count, 7-bit data and reserved-byte padding are validated. Profile
Set Profile On remains accepted only in the unclockstamped pre-DCTPQ prefix.

The rule follows [MIDI Clip File v1.0 §7.2](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf),
which excludes Property Exchange messages from sequence data;
[MIDI-CI Property Exchange v1.1 §§1.7 and 3.1](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-103-UM_v1-1_Common_Rules_for_MIDI-CI_Property_Exchange.pdf)
defines the message prefix and Sub-ID range. Validation results are recorded
in the task audit and handoff below.

### Latest continuation — preserve MIDI Clip JR Utility packets (2026-10-04)

The MIDI Clip parser previously dropped every Message Type 0 Utility packet
after handling DCS/DCTPQ, silently losing JR Clock and JR Timestamp data.
Sequence/configuration JR timing packets now survive as opaque UMP events with
their original order and are emitted again by MIDI Clip export. The application
does not interpret their sender-clock domain or replace the clip's DCS/project
timeline with JR timing. NOOP remains a non-musical DCS reset aid and is
consumed. Reserved Group bits are rejected on Utility packets; reserved DCTPQ,
NOOP, and JR timing bits are validated. Tests cover JR import/export fidelity
and each malformed reserved-field case.

The rules follow [UMP & MIDI 2.0 Protocol v1.1.1 §§2.1.3 and 7.2–7.2.3](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).
Focused MIDI Clip tests passed 24/24; the full UI passed 1,045/1,045 across
151 files; TypeScript/production build and changed-file lint passed.
`git diff --check` passed. This is opaque file preservation, not live JR timestamp
scheduling or complete MIDI 2.0 interoperability.

### Latest continuation — validate MIDI Clip timing Flex Data (2026-10-04)

Set Tempo and Set Time Signature now require the Flex Data complete-message
format, Group addressing, and reserved channel zero. Set Tempo's time-per-
quarter value must be nonzero, and reserved data bytes for both timing messages
must be zero. Supported time signatures map denominator exponents 1–7 to
project denominators 2–128. Exponent zero (the specification's non-standard
denominator marker) and exponents beyond the application's supported range
remain opaque UMP instead of being misread or discarded. If such a meter came
from the configuration header, it is retained as an opaque sequence event at
beat zero so a later export does not create a malformed incomplete
configuration header. Export now rejects unsupported/invalid project meters
instead of silently filtering or wrapping them.

The specification gives a numerator range of 1–256 in an 8-bit field; decoding
byte zero as 256 is an implementation inference from that range and field
width, not a separately stated encoding rule. The Number of 1/32 Notes field
is preserved in MIDI meter events and persisted song signature points; legacy
projects default it to 8. Set Tempo 1/24-quarter placement and Set Time
Signature bar-boundary placement are not yet validated on import; add reference
fixtures before claiming complete Flex Data conformance.

Rules follow [UMP & MIDI 2.0 Protocol v1.1.1 §§7.5.3–7.5.4](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).
Focused MIDI Clip tests passed 27/27; the full UI passed 1,048/1,048 across
151 files; TypeScript/production build, changed-file lint, and `git diff --check`
passed. This remains file-codec support, not live UMP scheduling or complete
MIDI 2.0 interoperability.

### Latest continuation — validate MIDI Clip boundary markers (2026-10-04)

MIDI Clip Start of Clip and End of Clip UMPs now require `Form=Complete`, a
zero low reserved field in word 0, and zero remaining data words. The parser
previously accepted multipart forms or nonzero reserved data based only on the
status code. Malformed import fixtures cover both markers and each reserved
data area. The rule follows [UMP & MIDI 2.0 Protocol v1.1.1 §7.1.10–7.1.11 and Appendix F](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

Focused MIDI Clip tests passed 28/28; full UI passed 1,049/1,049 across
151 files; TypeScript/production build, changed-file lint and `git diff --check`
passed. This validates framing only; timing placement and independent
cross-application fixtures remain open.

### Latest continuation — retain MIDI Clip meter tick precision (2026-10-04)

Set Time Signature events are no longer rounded to the 24 MIDI Clock pulses
per quarter. Unlike Set Tempo, their recommended locations are bar boundaries;
short bars may begin between MIDI Clock pulses. Export rounds these events only
to the output file's DCTPQ tick grid. A `1/128` bar followed by a signature
change at `1/32` beat now round-trips at that exact tick instead of shifting to
`1/24` beat. The writer now emits DCTPQ=65,280, the highest multiple of 960
within the protocol's 65,535 limit, retaining the common project PPQ grid and
24 MIDI Clock pulses per quarter at much finer resolution. Since that raises
the number of DCS/NOOP resets needed for long sparse gaps, parser and writer
share a bounded 800,016-UMP packet budget. Export preflights reset expansion
and safe tick conversion; import rejects packet floods at the same ceiling.
Import still preserves off-boundary input rather than enforcing a recommended
(not `shall`) placement rule.

This follows [MIDI Clip File v1.0 §7.1.2](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf) and [UMP & MIDI 2.0 Protocol v1.1.1 §§7.5.3–7.5.4](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).
Focused MIDI Clip tests passed 30/30, including DCTPQ and long-gap cases; full
UI passed 1,051/1,051 across 151 files; TypeScript/production build,
changed-file lint, and `git diff --check` passed.

### Latest continuation — reject lossy Set Tempo clamping (2026-10-04)

Set Tempo export converts BPM to the protocol's 10-nanosecond units per
quarter note and rejects values that round outside the unsigned 32-bit range
instead of silently clamping them. Invalid supplied tempo events are rejected
rather than filtered out. Tests exercise both representable endpoints, values
outside the range, and invalid event data. Set Tempo placement continues to
follow the protocol's 1/24-quarter-note grid. The encoding range comes from
[UMP & MIDI 2.0 Protocol v1.1.1 §7.5.3](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

Focused MIDI Clip tests passed 31/31; full UI passed 1,052/1,052 across
151 files; TypeScript/production build, changed-file lint, and `git diff --check`
passed. Broader cross-application MIDI Clip fixtures remain an open validation
gap; do not claim complete MIDI 2.0 interoperability.

### Latest continuation — preserve time-signature notation metadata (2026-10-04)

The MIDI Set Time Signature `Number of 1/32 Notes` byte now round-trips through
MIDI Clip Flex Data, MIDI 1.0 `FF 58` events, import tempo-map application,
Core project JSON, builder commands, and UI telemetry. It is stored as the
optional `thirtySecondsPerQuarter` signature-point field, defaults to 8 for
older projects/files, and is deliberately excluded from `SignatureMap` bar
arithmetic. Both writers validate the byte range instead of truncating. Tests
cover non-default values through both codecs and a Core project save/load.
Focused MIDI codec tests passed 53/53; full UI passed 1,052/1,052 across
151 files; Core engine tests and the `ResoStage` build passed.

This closes the metadata-loss item, not the whole timing audit. The importer
still preserves recommended off-grid tempo/meter events instead of rejecting
them, and no independent DAW-generated MIDI Clip corpus is maintained.

### Latest continuation — validate MIDI Clip DCS/NOOP adjacency (2026-10-04)

The parser now requires a Null/NOOP timing-reset packet to immediately follow
its Delta Clockstamp. It previously accepted a stale DCS across an intervening
JR Utility packet, although MIDI Clip File v1.0 §3.2.2 specifies the reset pair
as DCS followed by Null. A malformed sequence fixture covers the gap. Focused
MIDI Clip tests passed 31/31; full UI passed 1,052/1,052 across 151 files;
TypeScript/production build, changed-file lint and `git diff --check` passed.

Source: [MIDI Clip File Specification v1.0 §3.2.2](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf).

### Latest continuation — preserve same-tick MIDI note edges (2026-10-04)

MIDI Clip and Standard MIDI File imports no longer widen a matched Note On/Off
pair whose timestamps are identical. This zero duration survives SMPTE/time-map
adaptation, the Core Builder and project JSON. Piano Roll renders a compact
point note that remains selectable and can be resized into a positive length.
Live MIDI queues Note On then Note Off at the same sample offset; offline event
sorting releases older notes first, preserves the point pair's edge order, and
keeps ordinary retriggers Off-before-On. Instrument response to a zero-length
gate remains receiver-dependent. This does not claim byte-identical SMF/UMP
round-trip or audible playback of a zero-length note.

Focused codec/Piano Roll tests passed 73/73; the full UI suite passed
1,055/1,055 across 151 files; Core engine CTest passed 1/1; the `ResoStage`
Core target compiled; TypeScript/production build, changed-file lint and
`git diff --check` passed. The semantics follow timestamp/delta-clock
resolution in the [Standard MIDI Files specification](https://www.midi.org/specifications/file-format-specifications/standard-midi-files)
and [MIDI Clip File Specification v1.0](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf).

### Latest continuation — preserve open-note duration to Clip end (2026-10-04)

An unmatched MIDI 2.0 Note On was previously normalized to an arbitrary 1/64
beat gate. The MIDI Clip importer now treats it like an unmatched Standard MIDI
File note and holds it through the End of Clip timestamp. If the attack occurs
at the clip boundary, its normalized duration remains zero. Regression tests
cover a note held across the clip and an attack at the boundary. Focused
MIDI Clip tests passed 33/33; full UI passed 1,056/1,056 across 151 files;
TypeScript/production build, changed-file lint and `git diff --check` passed.
This preserves the file's timing in the editable note model, but export still
serializes a matching Note Off because the project note schema represents
notes as attack/release pairs. Independent DAW fixtures remain necessary.

### Latest continuation — isolate mixed-protocol note edges (2026-10-04)

MIDI Clip note pairing now includes the UMP message type. A MIDI 1.0 Channel
Voice attack cannot be closed by a MIDI 2.0 Channel Voice release from the
same Group/Channel/note, or vice versa. The protocol forbids a device from
mixing Message Types 0x2 and 0x4 in one Group; if a file nevertheless contains
such data, the importer now preserves each unmatched release as an opaque UMP
event and keeps the attack open through End of Clip rather than corrupting the
pair. A regression fixture exercises both directions. Focused MIDI Clip tests
passed 34/34; full UI passed 1,057/1,057 across 151 files; TypeScript/production
build, changed-file lint and `git diff --check` passed. Basis: [UMP and
MIDI 2.0 Protocol v1.1.1 §§3.2.1, 3.3.1 and 7.4](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

### Latest continuation — cover the complete UMP packet-width table (2026-10-04)

Added a table-driven MIDI Clip codec fixture covering all 16 UMP Message Type
values, including the reserved types' preallocated packet widths. It verifies
that every packet is parsed and emitted with its exact word count and payload;
this protects raw opaque-event round-trip as future UMP types are added. The
widths follow UMP Protocol v1.1.1 Table 4. Focused MIDI Clip tests passed
35/35, including the all-type import/export round-trip. This is framing
coverage, not semantic support for the currently reserved message types.

### Latest continuation — preserve SMF metronome-click interval metadata (2026-10-04)

Standard MIDI File `FF 58` carries both the 1/32-notes-per-quarter value and
the MIDI-clocks-per-metronome-click byte. ResoStage now preserves the latter
as optional `SignaturePoint::midiClocksPerMetronomeClick` (default 24) across
SMF import/export, Import MIDI tempo-map adoption, project JSON, Builder edits,
and Core state/telemetry. Legacy projects without the field load as 24. Short
or otherwise malformed `FF 51`/`FF 58` timing metadata is retained as an
ordinary raw MIDI event instead of being silently discarded. Because MIDI 2.0
Set Time Signature Flex Data has no click-interval field, `.midi2` export now
counts selected non-default intervals and requires explicit confirmation
before dropping them. Focused SMF tests passed 28/28; full UI passed
1,063/1,063 across 151 files; Core CTest passed 1/1; the `ResoStage` target,
TypeScript check, and production UI build passed. Independent cross-DAW
fixtures and complete MIDI Clip interoperability remain open. References:
[MIDI.org Standard MIDI Files specification](https://midi.org/standard-midi-files-specification),
[UMP & MIDI 2.0 Protocol v1.1.1 §7.5.4](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

### Latest continuation — disclose MIDI 2.0 zero-velocity Note On conversion (2026-10-04)

MIDI 2.0 permits a zero-velocity Note On as a real attack. The MIDI 1.0
translator must replace the converted zero with velocity 1, because MIDI 1.0
assigns Note-On velocity zero the Note-Off meaning. Standard MIDI export
already performed this protocol-correct conversion, but its loss analyzer
failed to report it. The report now counts these attacks separately from
ordinary 7-bit velocity quantization and the dialog names the conversion.
The MIDI export consent fingerprint includes the selected MIDI 1/2 loss
summary and exact selected time-signature metadata, so project changes that
alter the reported loss clear prior consent. Focused SMF tests passed 29/29;
full UI passed 1,064/1,064 across 151 files; TypeScript, production build, and
changed-file lint passed. Reference: [UMP & MIDI 2.0 Protocol v1.1.1 §7.4.2]
(https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf).

### Latest continuation — reject out-of-range Standard MIDI File VLQs (2026-10-04)

The Standard MIDI File reader already rejected variable-length quantities
longer than four bytes, but the writer could emit one when an event delta or
length exceeded `0x0FFFFFFF`; it also silently coerced invalid/non-finite
values. The shared writer encoder now accepts only safe integers in the SMF
VLQ range, so invalid event times and deltas that cannot be represented fail
explicitly instead of producing a file the parser rejects. Tests cover the
maximum legal delta, one tick beyond it, and a non-finite event timestamp.
Focused Standard MIDI File tests passed 55/55; full UI passed 1,089/1,089 across
151 files, TypeScript, production build, changed-file oxlint, and
`git diff --check` passed. This intentionally rejects an
unrepresentable gap rather than inserting a synthetic event into the user's
sequence. The four-byte bound follows the [MIDI Association Standard MIDI
Files specification](https://midi.org/standard-midi-files-specification).

### Latest continuation — validate SMF channel data bytes (2026-10-04)

Standard MIDI File import now rejects MIDI 1.0 Channel Voice messages whose
data byte has bit 7 set. Such bytes are status values, and accepting them as
pitch, velocity, or controller data could create malformed project events.
Fixtures cover the first and second data-byte positions. Focused SMF tests
passed 56/56; full UI passed 1,091/1,091 across 151 files, TypeScript,
production build, changed-file oxlint, and `git diff --check` passed. This
follows the MIDI Association's [MIDI 1.0 Detailed
Specification](https://midi.org/midi-1-0-detailed-specification) and [expanded
message table](https://midi.org/expanded-midi-1-0-messages-list).

### Latest continuation — validate stored events before SMF export (2026-10-04)

Standard MIDI export now validates every persisted raw event before writing
track bytes: status/data octets must be in range, Channel Voice and supported
System messages must have the proper byte count, MIDI data fields must be
7-bit, and End-of-Track is forbidden as an in-region event because it would
truncate later events. Unknown meta payloads and SysEx bytes remain retained.
Regression coverage exercises invalid values, message lengths, unsupported
system status, and embedded End-of-Track. Focused SMF tests passed 57/57;
TypeScript and changed-file oxlint passed; full UI passed 1,092/1,092 across
151 files, the production build, and `git diff --check` passed. See the MIDI
Association [Standard MIDI Files specification]
(https://midi.org/standard-midi-files-specification).

### Latest continuation — preserve running status around real-time bytes (2026-10-04)

The permissive SMF parser accepts System Real-Time bytes as raw events, but it
was also clearing the current Channel Voice running status for them. It now
retains that status around F8–FE; System Common, SysEx, and meta events still
clear it. Regression coverage verifies a subsequent running-status note is
parsed correctly and that System Common still requires a fresh status byte.
Focused SMF tests passed 58/58; full UI passed 1,093/1,093 across 151 files,
TypeScript, production build, changed-file oxlint, and `git diff --check` passed.
This is defensive support for files
containing tolerated real-time events, not a claim that such events are
standard SMF track events. The behavior follows MIDI Association guidance that
Real-Time messages may occur anywhere and do not alter running status:
[MIDI messages](https://midi.org/about-midi-part-3midi-messages), [MIDI.org
running-status discussion](https://midi.org/community/getting-started-with-midi-1/note-off/paged/2).

### Latest continuation — keep Standard MIDI export within parser event limits (2026-10-04)

The SMF parser rejects files with more than 200,000 events, counting tempo,
meter, track-name and End-of-Track metadata. The writer previously allowed
400,000 channel events and did not count metadata, so it could generate a file
that ResoStage itself could not reopen. The writer now reserves mandatory
track/tempo metadata and admits no more content events than fit the parser's
file-wide cap. Repeated loop occurrences of one raw source event reuse its
validated encoded bytes. A regression exercises the over-limit boundary.
Focused Standard MIDI tests passed 63/63; full UI passed 1,098/1,098 across
151 files; TypeScript, production build, changed-file oxlint, and
`git diff --check` passed.

### Latest continuation — bound Standard MIDI export bytes and allocation (2026-10-04)

Standard MIDI export now enforces the same 32 MiB whole-file ceiling as
import. It accounts encoded event bytes as events are admitted, preflights each
track's exact size before allocation, and writes directly into bounded
`Uint8Array` track/file buffers. Large raw SysEx and sequencer-specific meta
payloads remain referenced until final serialization, so loop expansion does
not duplicate their source arrays or build an oversized nested number array.
A regression uses loop-expanded raw SysEx to verify early rejection over the
file-size limit. Focused Standard MIDI tests passed 64/64; full UI passed
1,099/1,099 across 151 files; TypeScript, production build, changed-file
oxlint, and `git diff --check` passed.

The importer now applies its existing 7-bit data-byte validation to System
Common messages as well as Channel Voice messages. This closes a mismatch where
malformed F1/F2/F3 payloads could enter project state even though export
rejected the same data. SysEx and F7 escape payload handling remains unchanged.

The importer also skips unknown chunks before/between declared MTrk chunks using
their declared length, so a FourCC-like byte sequence inside unknown payload
data is never treated as a track. Truncated unknown chunks reject cleanly. This
follows the forward-compatible chunk rule in the MIDI Association [Standard
MIDI Files specification](https://midi.org/standard-midi-files-specification).

Focused Standard MIDI tests passed 69/69; full UI passed 1,104/1,104 across
151 files; TypeScript, production build, changed-file oxlint, and
`git diff --check` passed.

MIDI Clip profile-prefix validation now checks MIDI-CI Set Profile On layouts
by Message Format Version: v1.1 requires exactly 18 UMP SysEx7 payload bytes;
v1.2 requires 20 including Channel Count. Future minor versions may append
fields, but reserved major-version bits are rejected. Profile messages in a
MIDI Clip must use broadcast source/destination MUIDs, and v1.2+ Group or
Function Block destinations must request zero channels. Tests cover valid v1.1
and v1.2 messages plus truncated/extra fields and invalid reserved/address
values. Focused MIDI Clip tests passed 36/36; full UI passed 1,105/1,105 across
151 files; TypeScript, production build, changed-file oxlint, and
`git diff --check` passed. References: [MIDI-CI v1.2 §§5.2–5.4, 7.8](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-101-UM_v1-2_MIDI-CI_Specification.pdf)
and [MIDI Clip File v1.0 §6.2](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf).

### Latest continuation — enforce SMF track bounds for System messages (2026-10-04)

Standard MIDI import now verifies that System Common/Real-Time message data
ends within its declared `MTrk` chunk. Previously, a truncated F1/F2/F3 event
could consume bytes from the next chunk and be accepted as fabricated event
data. A two-track regression proves the following chunk header is not used to
complete the earlier event. Focused Standard MIDI tests passed 70/70; full UI
passed 1,106/1,106 across 151 files; TypeScript, production build,
changed-file oxlint, and `git diff --check` passed. Continue the codec audit
with malformed chunk-boundary fixtures; do not broaden this into accepting
truncated events.

### Latest continuation — validate End-of-Track framing (2026-10-04)

The SMF parser now checks meta-event payload bounds before handling special
events and rejects End-of-Track unless its payload length is zero. This avoids
silently rewinding the reader after an End-of-Track event borrowed bytes from
the next chunk, and rejects malformed nonempty End-of-Track payloads. Tests
cover both cases. Focused Standard MIDI tests passed 71/71; full UI passed
1,107/1,107 across 151 files; TypeScript, production build, changed-file
oxlint, and `git diff --check` passed. Reference: [MIDI Association Standard
MIDI Files specification](https://midi.org/standard-midi-files-specification).

### Latest continuation — validate MIDI 1.0 UMP note bytes (2026-10-04)

MIDI Clip import now rejects malformed Message Type 2 Note On/Off packets whose
MIDI 1.0 data bytes have bit 7 set. The note parser previously masked those
bits and converted the altered values to project notes, discarding the source
packet. Tests cover invalid note-number and velocity bytes. Focused MIDI Clip
tests passed 37/37; full UI passed 1,108/1,108 across 151 files; TypeScript,
production build, changed-file oxlint, and `git diff --check` passed. Basis:
[UMP & MIDI 2.0 Protocol v1.1.1 §7.3](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-104-UM_v1-1-1_UMP_and_MIDI_2-0_Protocol_Specification.pdf)
and the MIDI 1.0 channel-voice data-byte rules.

### Latest continuation — validate receiver-configuration SysEx7 (2026-10-04)

MIDI Clip parsing and export now validate SysEx7 packet status, byte count,
7-bit payload, zero padding, and complete/start/continue/end framing in the
receiver configuration header after DCTPQ. Previously, unlike sequence and
profile-prefix packets, malformed receiver-setup SysEx7 could be retained or
written. Regressions cover valid preservation plus bad count, padding, and an
unfinished message on both import/export paths. Focused MIDI Clip tests passed
38/38; full UI passed 1,109/1,109 across 151 files; TypeScript, production
build, changed-file oxlint, and `git diff --check` passed.

### Latest continuation — reject Property Exchange from receiver setup (2026-10-04)

The receiver-configuration SysEx7 validator now also rejects MIDI-CI Property
Exchange messages, while preserving structurally valid non-PE SysEx setup.
Property Exchange is excluded from MIDI Clip data; it must not bypass the
sequence validator merely because a packet is in the configuration header.
Regression coverage checks both import and export. Focused MIDI Clip tests
passed 39/39; full UI passed 1,110/1,110 across 151 files; TypeScript,
production build, changed-file oxlint, and `git diff --check` passed. Basis:
[MIDI Clip File v1.0 §6.4](https://amei.or.jp/midistandardcommittee/MIDI2.0/MIDI2.0-DOCS/M2-116-U_v1-0_MIDI_Clip_File_Specification.pdf).

### Latest continuation — honor extended Standard MIDI headers (2026-10-04)

Standard MIDI import no longer imposes an arbitrary 1 KiB maximum on the
declared `MThd` chunk. It skips the complete extension payload within the
existing 32 MiB whole-file bound and reports a truncated header distinctly,
before attempting to parse track chunks. Tests cover a valid 1,025-byte
extension and a truncated extension. Focused Standard MIDI tests passed 73/73;
full UI passed 1,112/1,112 across 151 files; TypeScript, production build,
changed-file oxlint, and `git diff --check` passed. Basis: the MIDI Association
[Standard MIDI Files specification](https://midi.org/standard-midi-files-specification).

### Latest continuation — validate Standard MIDI chunk inventory (2026-10-04)

After parsing the number of tracks declared in `MThd`, the importer now scans
remaining chunk framing instead of silently ignoring it. Well-formed unknown
chunks remain forward-compatible and are skipped by declared length; an extra
`MTrk`, duplicate `MThd`, or truncated trailing chunk is rejected. The parser
also reports when the header declares tracks that are missing. Tests cover
trailing alien data, an undeclared track, a repeated header, and a truncated
trailing chunk. Focused Standard MIDI tests passed 76/76; full UI passed
1,115/1,115 across 151 files; TypeScript, production build, changed-file
oxlint, and `git diff --check` passed. Basis: the MIDI Association
[Standard MIDI Files specification](https://midi.org/standard-midi-files-specification).

### Latest continuation — enforce Standard MIDI End-of-Track termination (2026-10-04)

When an `MTrk` contains an End-of-Track event, the parser now requires that
event to end exactly at the declared track boundary. It no longer advances to
the end of the chunk and discards later bytes/events. This change deliberately
does not add a new rejection for tracks that omit EOT; malformed-but-readable
files retain the existing recovery behavior. A regression verifies that an
event after EOT is rejected. Focused Standard MIDI tests passed 77/77; full UI
passed 1,116/1,116 across 151 files; TypeScript, production build, changed-file
oxlint, and `git diff --check` passed. Basis: the MIDI Association
[Standard MIDI Files specification](https://midi.org/standard-midi-files-specification).

### Latest continuation — bound multi-file MIDI import memory (2026-10-04)

The MIDI import dialog now parses selected files sequentially instead of
reading and parsing the entire batch concurrently. It caps the aggregate
retained notes, MIDI 1.0 events, and opaque UMP events at 200,000 items, the
same ceiling as a single input file. This prevents a permitted 128-file batch
from multiplying per-file limits into unbounded retained project state. Focused
batch/SMF tests passed 79/79; full UI passed 1,118/1,118 across 152 files;
closing or replacing the dialog stops further file reads/parsing after the
current `arrayBuffer()` operation settles. TypeScript, production build,
changed-file oxlint, and `git diff --check` passed.

### Latest continuation — isolate selected MIDI sequence timing (2026-10-04)

When importing with the project-tempo update choice, the initial BPM and meter
are now derived only from the selected sequence's own maps. Missing beat-zero
events use the SMF defaults (120 BPM and 4/4), rather than borrowing Format 2
track 1's values or promoting a later event to beat zero. The same rule keeps
later Format 0/1 tempo and meter changes at their actual beats. Focused timing,
batch, and SMF tests passed 82/82; full UI passed 1,121/1,121 across 153 files;
TypeScript, production build, changed-file oxlint and `git diff --check` passed.
