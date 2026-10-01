// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#include "doctest.h"

#include "project/ProjectSchema.h"
#include "project/ProjectJson.h"
#include "project/MidiRegionLoop.h"
#include "timing/TempoMap.h"
#include "audio/graph/MixGraph.h"
#include "midi/Midi2Compatibility.h"

#include <cmath>
#include <vector>
#include <string>

using namespace resostage;

TEST_SUITE("TimelineMidi") {

TEST_CASE("MidiNote and MidiRegion model integrity and defaults") {
    MidiNote note;
    note.id = 1001;
    note.pitch = 64; // E4
    note.startBeats = 2.5;
    note.durationBeats = 1.25;
    note.velocity = 0.75f;
    note.releaseVelocity = 0.4f;
    note.probability = 0.9f;

    CHECK(note.id == 1001);
    CHECK(note.pitch == 64);
    CHECK(note.startBeats == doctest::Approx(2.5));
    CHECK(note.durationBeats == doctest::Approx(1.25));
    CHECK(note.velocity == doctest::Approx(0.75f));
    CHECK(note.releaseVelocity == doctest::Approx(0.4f));
    CHECK(note.probability == doctest::Approx(0.9f));
    CHECK_FALSE(note.muted);

    MidiRegion region;
    region.id = "region-uuid-1";
    region.trackId = "audio::track:1";
    region.name = "Lead Synth Hook";
    region.startBeats = 4.0;
    region.durationBeats = 16.0;
    region.clipOffsetBeats = 0.0;
    region.loop = true;
    region.loopLengthBeats = 4.0;
    region.notes.push_back(note);

    CHECK(region.id == "region-uuid-1");
    CHECK(region.trackId == "audio::track:1");
    CHECK(region.loop);
    CHECK(region.loopLengthBeats == doctest::Approx(4.0));
    CHECK(region.notes.size() == 1);
}

TEST_CASE("Trimmed MIDI loop source windows preserve phase and exclude the old tail") {
    MidiRegion region;
    region.loop = true;
    region.clipOffsetBeats = 7.0;
    region.loopStartBeats = 7.0;
    region.loopLengthBeats = 5.0;

    CHECK(midiRegionSourceBeat(0.0, region.clipOffsetBeats,
                               region.loopStartBeats, region.loopLengthBeats,
                               region.loop) == doctest::Approx(7.0));
    CHECK(midiRegionSourceBeat(4.999, region.clipOffsetBeats,
                               region.loopStartBeats, region.loopLengthBeats,
                               region.loop) == doctest::Approx(11.999));
    CHECK(midiRegionSourceBeat(5.0, region.clipOffsetBeats,
                               region.loopStartBeats, region.loopLengthBeats,
                               region.loop) == doctest::Approx(7.0));
    CHECK(midiRegionContainsLoopSourceBeat(7.0, region.loopStartBeats,
                                           region.loopLengthBeats));
    CHECK_FALSE(midiRegionContainsLoopSourceBeat(6.999, region.loopStartBeats,
                                                 region.loopLengthBeats));
    CHECK_FALSE(midiRegionContainsLoopSourceBeat(12.0, region.loopStartBeats,
                                                 region.loopLengthBeats));

    // Splitting advances the source phase but must not widen the cropped loop.
    region.clipOffsetBeats = 9.0;
    CHECK(midiRegionSourceBeat(0.0, region.clipOffsetBeats,
                               region.loopStartBeats, region.loopLengthBeats,
                               region.loop) == doctest::Approx(9.0));
    CHECK(midiRegionSourceBeat(3.0, region.clipOffsetBeats,
                               region.loopStartBeats, region.loopLengthBeats,
                               region.loop) == doctest::Approx(7.0));
}

TEST_CASE("Project JSON preserves the MIDI loop source-window start") {
    Project project;
    SongDef song;
    MidiRegion region;
    region.id = "midi-region";
    region.loop = true;
    region.loopStartBeats = 7.0;
    region.clipOffsetBeats = 9.0;
    region.loopLengthBeats = 5.0;
    song.midiRegions.push_back(region);
    project.songs.push_back(song);

    Project restored;
    std::string error;
    REQUIRE(parseProjectJson(serializeProjectJson(project), restored, error));
    REQUIRE(restored.songs.size() == 1);
    REQUIRE(restored.songs[0].midiRegions.size() == 1);
    CHECK(restored.songs[0].midiRegions[0].loopStartBeats == doctest::Approx(7.0));
    CHECK(restored.songs[0].midiRegions[0].clipOffsetBeats == doctest::Approx(9.0));
}

TEST_CASE("MIDI 2.0 compatibility conversion keeps channel data bounded") {
    MidiNote note;
    note.velocity = 0.1f; // The preserved high-resolution field is authoritative.
    note.midi2 = MidiNote::Midi2Data{4, 0x9234, 0x4567, 1, 0x1234};
    CHECK(midi1NoteVelocity(note, true) == 0x9234 >> 9);
    CHECK(midi1NoteVelocity(note, false) == 0x4567 >> 9);
    note.midi2->velocity = 1;
    CHECK(midi1NoteVelocity(note, true) == 1); // MIDI 1.0 zero would mean Note Off.

    MidiUmpEvent cc;
    cc.words = {0x40b20700u, 0x80000000u, 0, 0};
    cc.wordCount = 2;
    const auto converted = umpToMidi1ChannelControl(cc);
    REQUIRE(converted.has_value());
    CHECK(converted->status == 0xb2);
    CHECK(converted->data1 == 7);
    CHECK(converted->data2 == 64);
    CHECK(converted->dataLength == 2);

    MidiUmpEvent bend;
    bend.words = {0x40e20000u, 0x80000000u, 0, 0};
    bend.wordCount = 2;
    const auto center = umpToMidi1ChannelControl(bend);
    REQUIRE(center.has_value());
    CHECK(center->status == 0xe2);
    CHECK(center->data1 == 0);
    CHECK(center->data2 == 64);

    cc.words[0] = 0x40b20600u; // Data Entry is not a standalone MIDI 2.0 CC.
    CHECK_FALSE(umpToMidi1ChannelControl(cc).has_value());

    cc.wordCount = 1; // A truncated MIDI 2.0 UMP packet is never dispatched.
    CHECK_FALSE(umpToMidi1ChannelControl(cc).has_value());
    MidiUmpEvent perNote;
    perNote.words = {0x40623c00u, 0x80000000u, 0, 0};
    perNote.wordCount = 2;
    CHECK_FALSE(umpToMidi1ChannelControl(perNote).has_value());
}

TEST_CASE("Sample-accurate note timing with constant tempo") {
    // 120 BPM: 1 beat = 0.5s = 24000 samples at 48kHz
    TempoMap tm(120.0);
    const double sampleRate = 48000.0;

    MidiNote note;
    note.pitch = 60;
    note.startBeats = 2.0;       // 1.0s = 48000 samples
    note.durationBeats = 1.5;    // 0.75s = 36000 samples

    const int64_t onSample = tm.beatsToSamples(note.startBeats, sampleRate);
    const int64_t offSample = tm.beatsToSamples(note.startBeats + note.durationBeats, sampleRate);

    CHECK(onSample == 48000);
    CHECK(offSample == 84000);
    CHECK(offSample - onSample == 36000);

    // Verify sub-block offset inside a 512-sample buffer
    // Block from 47800 to 48312:
    const int64_t blockStart = 47800;
    const int numSamples = 512;
    CHECK(onSample >= blockStart);
    CHECK(onSample < blockStart + numSamples);
    const int blockOffset = static_cast<int>(onSample - blockStart);
    CHECK(blockOffset == 200);
}

TEST_CASE("Sample-accurate note timing across tempo ramps") {
    // Ramp from 120 BPM at beat 0 to 180 BPM at beat 4
    std::vector<TempoPoint> points = {
        {0.0, 120.0, 0.0, 1.0},
        {4.0, 180.0, 0.0, 0.0}
    };
    TempoMap tm(120.0, points);
    const double sampleRate = 48000.0;

    // At beat 0: BPM is 120
    CHECK(tm.bpmAtBeat(0.0) == doctest::Approx(120.0));
    // At beat 2: BPM is 150
    CHECK(tm.bpmAtBeat(2.0) == doctest::Approx(150.0));
    // At beat 4: BPM is 180
    CHECK(tm.bpmAtBeat(4.0) == doctest::Approx(180.0));

    MidiNote note1;
    note1.pitch = 60;
    note1.startBeats = 0.0;
    note1.durationBeats = 1.0;

    MidiNote note2;
    note2.pitch = 62;
    note2.startBeats = 2.0;
    note2.durationBeats = 1.0;

    const int64_t on1 = tm.beatsToSamples(note1.startBeats, sampleRate);
    const int64_t off1 = tm.beatsToSamples(note1.startBeats + note1.durationBeats, sampleRate);

    const int64_t on2 = tm.beatsToSamples(note2.startBeats, sampleRate);
    const int64_t off2 = tm.beatsToSamples(note2.startBeats + note2.durationBeats, sampleRate);

    CHECK(on1 == 0);
    // Under acceleration, beat 1 arrives sooner than at constant 120 BPM (24000)
    CHECK(off1 < 24000);
    CHECK(off1 > 16000);

    // Note 2 duration in samples should be shorter than note 1 because tempo is faster
    CHECK((off2 - on2) < (off1 - on1));
}

TEST_CASE("Looping region iteration and bounds logic") {
    MidiRegion region;
    region.startBeats = 8.0;
    region.durationBeats = 16.0; // spans beats 8.0 to 24.0
    region.clipOffsetBeats = 0.0;
    region.loop = true;
    region.loopLengthBeats = 4.0; // repeats every 4 beats: at 8, 12, 16, 20

    MidiNote note;
    note.pitch = 72;
    note.startBeats = 1.0;     // fires at 1.0 beat into pattern
    note.durationBeats = 0.5;

    region.notes.push_back(note);

    const double loopLen = region.loopLengthBeats;

    // Check which iterations occur over the region span
    std::vector<double> noteOnTimes;
    for (int k = 0; k < 4; ++k) {
        const double iterOffset = region.startBeats + k * loopLen;
        const double onBeat = iterOffset + note.startBeats;
        if (onBeat >= region.startBeats && onBeat < (region.startBeats + region.durationBeats)) {
            noteOnTimes.push_back(onBeat);
        }
    }

    REQUIRE(noteOnTimes.size() == 4);
    CHECK(noteOnTimes[0] == doctest::Approx(9.0));  // 8 + 1
    CHECK(noteOnTimes[1] == doctest::Approx(13.0)); // 12 + 1
    CHECK(noteOnTimes[2] == doctest::Approx(17.0)); // 16 + 1
    CHECK(noteOnTimes[3] == doctest::Approx(21.0)); // 20 + 1
}

TEST_CASE("Track vs Channel Strip decoupling in MixGraph") {
    Project proj;
    TrackDef track1;
    track1.id = "audio::track:1";
    track1.name = "MIDI Lead 1";
    track1.kind = TrackKind::Instrument;
    track1.stripId = "audio::track:synth"; // Shared synth strip

    TrackDef track2;
    track2.id = "audio::track:2";
    track2.name = "MIDI Lead 2";
    track2.kind = TrackKind::Instrument;
    track2.stripId = "audio::track:synth"; // Shared synth strip

    TrackDef synthStrip;
    synthStrip.id = "audio::track:synth";
    synthStrip.name = "Shared PolySynth";
    synthStrip.kind = TrackKind::Instrument;

    proj.tracks = {track1, track2, synthStrip};

    OutputLaneConfig lanes;
    lanes.totalChannels = 2;

    MixGraph graph = buildMixGraph(proj, lanes);

    // Verify both track 1 and track 2 resolve to the shared synth strip
    CHECK(track1.effectiveStripId() == "audio::track:synth");
    CHECK(track2.effectiveStripId() == "audio::track:synth");
    CHECK(synthStrip.effectiveStripId() == "audio::track:synth");

    const uint32_t stripIndex = graph.find(track1.effectiveStripId());
    CHECK(stripIndex != MixGraph::kNoStrip);
    CHECK(graph.strips[stripIndex].id == "audio::track:synth");
}

} // TEST_SUITE
