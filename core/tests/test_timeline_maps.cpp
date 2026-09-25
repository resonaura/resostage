#include "doctest.h"

#include "project/ProjectJson.h"
#include "project/ProjectSchema.h"
#include "timing/TempoMap.h"

#include <cmath>
#include <string>

using namespace resostage;

TEST_SUITE("TimelineMaps") {

TEST_CASE("TempoMap: constant tempo conversions") {
    TempoMap map(120.0); // 120 BPM => 0.5s per quarter note

    CHECK(map.fallbackBpm() == doctest::Approx(120.0));
    CHECK(map.points().size() == 1);

    // Beats to seconds
    CHECK(map.beatsToSeconds(0.0) == doctest::Approx(0.0));
    CHECK(map.beatsToSeconds(1.0) == doctest::Approx(0.5));
    CHECK(map.beatsToSeconds(4.0) == doctest::Approx(2.0));
    CHECK(map.beatsToSeconds(120.0) == doctest::Approx(60.0));

    // Seconds to beats
    CHECK(map.secondsToBeats(0.0) == doctest::Approx(0.0));
    CHECK(map.secondsToBeats(0.5) == doctest::Approx(1.0));
    CHECK(map.secondsToBeats(2.0) == doctest::Approx(4.0));
    CHECK(map.secondsToBeats(60.0) == doctest::Approx(120.0));

    // Sample conversions at 48000 Hz
    CHECK(map.beatsToSamples(4.0, 48000.0) == 96000);
    CHECK(map.samplesToBeats(96000, 48000.0) == doctest::Approx(4.0));

    // BPM queries
    CHECK(map.bpmAtBeat(0.0) == doctest::Approx(120.0));
    CHECK(map.bpmAtBeat(16.0) == doctest::Approx(120.0));
    CHECK(map.bpmAtSeconds(10.0) == doctest::Approx(120.0));
}

TEST_CASE("TempoMap: multi-step tempo changes") {
    // Step 0: 0 to 4 beats @ 120 BPM (duration: 4 * 0.5s = 2.0s)
    // Step 1: 4 to 8 beats @ 60 BPM  (duration: 4 * 1.0s = 4.0s, total 6.0s at beat 8)
    // Step 2: 8+ beats    @ 240 BPM (duration: 0.25s per beat)
    std::vector<TempoPoint> points = {
        {0.0, 120.0, 0.0, 0.0},
        {4.0, 60.0, 0.0, 0.0},
        {8.0, 240.0, 0.0, 0.0}
    };

    TempoMap map(120.0, points);

    REQUIRE(map.points().size() == 3);
    CHECK(map.points()[0].timeSeconds == doctest::Approx(0.0));
    CHECK(map.points()[1].timeSeconds == doctest::Approx(2.0));
    CHECK(map.points()[2].timeSeconds == doctest::Approx(6.0));

    // Section 1 (120 BPM)
    CHECK(map.beatsToSeconds(2.0) == doctest::Approx(1.0));
    CHECK(map.beatsToSeconds(4.0) == doctest::Approx(2.0));
    CHECK(map.bpmAtBeat(2.0) == doctest::Approx(120.0));

    // Section 2 (60 BPM)
    CHECK(map.beatsToSeconds(6.0) == doctest::Approx(4.0));
    CHECK(map.beatsToSeconds(8.0) == doctest::Approx(6.0));
    CHECK(map.bpmAtBeat(6.0) == doctest::Approx(60.0));

    // Section 3 (240 BPM)
    CHECK(map.beatsToSeconds(10.0) == doctest::Approx(6.5));
    CHECK(map.bpmAtBeat(10.0) == doctest::Approx(240.0));

    // Inverse queries
    CHECK(map.secondsToBeats(1.0) == doctest::Approx(2.0));
    CHECK(map.secondsToBeats(2.0) == doctest::Approx(4.0));
    CHECK(map.secondsToBeats(4.0) == doctest::Approx(6.0));
    CHECK(map.secondsToBeats(6.0) == doctest::Approx(8.0));
    CHECK(map.secondsToBeats(6.5) == doctest::Approx(10.0));
}

TEST_CASE("TempoMap: linear BPM ramp") {
    // Ramp from 60 BPM at beat 0 to 120 BPM at beat 4
    std::vector<TempoPoint> points = {
        {0.0, 60.0, 0.0, 1.0},
        {4.0, 120.0, 0.0, 0.0}
    };

    TempoMap map(60.0, points);

    // Mid-point tempo
    CHECK(map.bpmAtBeat(0.0) == doctest::Approx(60.0));
    CHECK(map.bpmAtBeat(2.0) == doctest::Approx(90.0));
    CHECK(map.bpmAtBeat(4.0) == doctest::Approx(120.0));

    const double t4 = map.beatsToSeconds(4.0);
    // Integral of 60 / (60 + 15x) dx from 0 to 4:
    // (60 / 15) * ln(120 / 60) = 4 * ln(2) ~= 2.772588722s
    const double expectedT4 = 4.0 * std::log(2.0);
    CHECK(t4 == doctest::Approx(expectedT4).epsilon(1e-4));

    // Invert seconds to beats along the ramp
    CHECK(map.secondsToBeats(0.0) == doctest::Approx(0.0));
    CHECK(map.secondsToBeats(t4) == doctest::Approx(4.0).epsilon(1e-4));

    const double t2 = map.beatsToSeconds(2.0);
    CHECK(map.secondsToBeats(t2) == doctest::Approx(2.0).epsilon(1e-4));
}

TEST_CASE("SignatureMap: bar and beat calculations") {
    // Default 4/4
    SignatureMap sig44(4, 4);

    int bar = 0;
    double beatInBar = 0.0;

    sig44.beatToBarBeat(0.0, bar, beatInBar);
    CHECK(bar == 1);
    CHECK(beatInBar == doctest::Approx(1.0));

    sig44.beatToBarBeat(3.5, bar, beatInBar);
    CHECK(bar == 1);
    CHECK(beatInBar == doctest::Approx(4.5));

    sig44.beatToBarBeat(4.0, bar, beatInBar);
    CHECK(bar == 2);
    CHECK(beatInBar == doctest::Approx(1.0));

    CHECK(sig44.barBeatToBeats(2, 1.0) == doctest::Approx(4.0));
    CHECK(sig44.barBeatToBeats(3, 2.5) == doctest::Approx(9.5));

    // Metric modulation:
    // Bar 1..4 (16 beats): 4/4
    // Bar 5..6 (6 beats): 3/4  (3 beats per bar, ending at beat 22)
    // Bar 7+  : 7/8 (3.5 quarter notes per bar)
    std::vector<SignaturePoint> points = {
        {0.0, 4, 4, 1},
        {16.0, 3, 4, 1},
        {22.0, 7, 8, 1}
    };

    SignatureMap modSig(4, 4, points);
    REQUIRE(modSig.points().size() == 3);
    CHECK(modSig.points()[0].bar == 1);
    CHECK(modSig.points()[1].bar == 5);
    CHECK(modSig.points()[2].bar == 7);

    // In 4/4 section
    modSig.beatToBarBeat(8.0, bar, beatInBar);
    CHECK(bar == 3);
    CHECK(beatInBar == doctest::Approx(1.0));

    // In 3/4 section
    modSig.beatToBarBeat(16.0, bar, beatInBar);
    CHECK(bar == 5);
    CHECK(beatInBar == doctest::Approx(1.0));

    modSig.beatToBarBeat(19.0, bar, beatInBar);
    CHECK(bar == 6);
    CHECK(beatInBar == doctest::Approx(1.0));

    // In 7/8 section (3.5 beats per bar)
    modSig.beatToBarBeat(22.0, bar, beatInBar);
    CHECK(bar == 7);
    CHECK(beatInBar == doctest::Approx(1.0));

    modSig.beatToBarBeat(25.5, bar, beatInBar);
    CHECK(bar == 8);
    CHECK(beatInBar == doctest::Approx(1.0));
}

TEST_CASE("ProjectJson: DAW TrackKind, stripId, and MIDI round-trip serialization") {
    Project p;
    p.name = "DAW Foundation Test";

    // Track 1: Instrument track with custom stripId
    TrackDef instTrack;
    instTrack.id = "inst::track:1";
    instTrack.name = "Analog Lead";
    instTrack.kind = TrackKind::Instrument;
    instTrack.stripId = "audio::strip:synth";
    instTrack.channels = 2;
    instTrack.output.type = OutputType::Main;
    CHECK(instTrack.effectiveStripId() == "audio::strip:synth");
    p.tracks.push_back(instTrack);

    // Track 2: Standard Audio track defaulting stripId
    TrackDef audioTrack;
    audioTrack.id = "audio::track:1";
    audioTrack.name = "Vocal Lead";
    audioTrack.kind = TrackKind::Audio;
    audioTrack.output.type = OutputType::Main;
    CHECK(audioTrack.effectiveStripId() == "audio::track:1");
    p.tracks.push_back(audioTrack);

    // Song with MidiRegion, TempoPoints, and SignaturePoints
    SongDef song;
    song.id = "meta::song:1";
    song.name = "Verse 1";
    song.bpm = 128.0;

    MidiRegion mreg;
    mreg.id = "018f-midi-region-1";
    mreg.trackId = "inst::track:1";
    mreg.name = "Arp Pattern";
    mreg.startBeats = 4.0;
    mreg.durationBeats = 16.0;
    mreg.loop = true;
    mreg.loopLengthBeats = 4.0;

    MidiNote n1;
    n1.id = 1001;
    n1.pitch = 60; // Middle C
    n1.startBeats = 0.0;
    n1.durationBeats = 0.5;
    n1.velocity = 0.85f;
    n1.probability = 1.0f;
    mreg.notes.push_back(n1);

    MidiNote n2;
    n2.id = 1002;
    n2.pitch = 64; // E4
    n2.startBeats = 0.5;
    n2.durationBeats = 0.5;
    n2.velocity = 0.70f;
    n2.tuningOffsetCents = 12;
    mreg.notes.push_back(n2);

    song.midiRegions.push_back(mreg);

    song.tempoPoints = {
        {0.0, 128.0, 0.0, 0.0},
        {32.0, 140.0, 15.0, 0.5}
    };

    song.signaturePoints = {
        {0.0, 4, 4, 1},
        {16.0, 7, 8, 5}
    };

    p.songs.push_back(song);

    // Serialize to JSON
    const std::string json = serializeProjectJson(p);
    REQUIRE(!json.empty());

    // Parse back
    Project loaded;
    std::string err;
    REQUIRE(parseProjectJson(json, loaded, err));

    REQUIRE(loaded.tracks.size() == 2);
    CHECK(loaded.tracks[0].id == "inst::track:1");
    CHECK(loaded.tracks[0].kind == TrackKind::Instrument);
    REQUIRE(loaded.tracks[0].stripId.has_value());
    CHECK(*loaded.tracks[0].stripId == "audio::strip:synth");
    CHECK(loaded.tracks[0].effectiveStripId() == "audio::strip:synth");

    CHECK(loaded.tracks[1].id == "audio::track:1");
    CHECK(loaded.tracks[1].kind == TrackKind::Audio);
    CHECK(loaded.tracks[1].effectiveStripId() == "audio::track:1");

    REQUIRE(loaded.songs.size() == 1);
    const auto& s = loaded.songs[0];
    CHECK(s.bpm == doctest::Approx(128.0));

    REQUIRE(s.midiRegions.size() == 1);
    const auto& r = s.midiRegions[0];
    CHECK(r.id == "018f-midi-region-1");
    CHECK(r.trackId == "inst::track:1");
    CHECK(r.startBeats == doctest::Approx(4.0));
    CHECK(r.loop == true);

    REQUIRE(r.notes.size() == 2);
    CHECK(r.notes[0].pitch == 60);
    CHECK(r.notes[0].velocity == doctest::Approx(0.85f));
    CHECK(r.notes[1].pitch == 64);
    CHECK(r.notes[1].tuningOffsetCents == 12);

    REQUIRE(s.tempoPoints.size() == 2);
    CHECK(s.tempoPoints[1].bpm == doctest::Approx(140.0));
    CHECK(s.tempoPoints[1].curve == doctest::Approx(0.5));

    REQUIRE(s.signaturePoints.size() == 2);
    CHECK(s.signaturePoints[1].numerator == 7);
    CHECK(s.signaturePoints[1].denominator == 8);
    CHECK(s.signaturePoints[1].bar == 5);
}

TEST_CASE("ProjectJson: backward compatibility with projects missing DAW fields") {
    // Project JSON representing an existing format 4 or format 3 project without kind, stripId, midiRegions
    constexpr const char* kLegacyJson = R"JSON(
{
  "format": { "version": 4 },
  "name": "Legacy V4 Project",
  "sampleRate": 48000,
  "click": { "enabled": false, "name": "Click", "channels": 2, "gainDb": 0, "pan": 0, "mute": false, "solo": false,
             "output": { "type": "main", "sends": [] } },
  "main": { "enabled": true, "name": "Main", "channels": 2, "gainDb": 0, "pan": 0, "mute": false, "solo": false,
            "output": { "type": "ext-out", "target": "audio::out:1,audio::out:2" } },
  "sends": [],
  "tracks": [
    { "id": "audio::track:1", "name": "Drums", "channels": 2, "gainDb": 0, "pan": 0, "mute": false, "solo": false,
      "output": { "type": "main", "sends": [] } }
  ],
  "songs": [
    {
      "id": "meta::song:1",
      "name": "Old Song",
      "bpm": 120.0,
      "timeSignature": { "numerator": 4, "denominator": 4 },
      "onEnded": "stop",
      "regions": [],
      "events": []
    }
  ],
  "cycle": { "active": false, "skip": false, "startSeconds": 0.0, "endSeconds": 4.0, "songIndex": -1 },
  "midi": { "mappings": [] }
}
)JSON";

    Project p;
    std::string err;
    REQUIRE(parseProjectJson(kLegacyJson, p, err));

    CHECK(p.name == "Legacy V4 Project");
    REQUIRE(p.tracks.size() == 1);

    // Must default to Audio track kind and match effectiveStripId() == track.id
    CHECK(p.tracks[0].kind == TrackKind::Audio);
    CHECK(p.tracks[0].effectiveStripId() == "audio::track:1");

    REQUIRE(p.songs.size() == 1);
    CHECK(p.songs[0].midiRegions.empty());
    CHECK(p.songs[0].tempoPoints.empty());
    CHECK(p.songs[0].signaturePoints.empty());
}

} // TEST_SUITE
