#include "doctest.h"

#include "project/ProjectJson.h"
#include "project/ProjectLoader.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>

using namespace resostage;

namespace {

std::string makeProjectArchive(const std::string& projectJson) {
    namespace fs = std::filesystem;
    const std::string path =
        std::string(std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp") + "/resoset_project_loader_test.rsnraset";

    std::error_code ec;
    fs::remove_all(path, ec);
    fs::create_directories(fs::path(path) / "Audio", ec);

    std::ofstream jsonOfs(fs::path(path) / resostage::kProjectDataFileName, std::ios::binary);
    jsonOfs.write(projectJson.data(), projectJson.size());
    jsonOfs.close();

    const uint8_t wav[] = {'R', 'I', 'F', 'F', 4, 0, 0, 0, 'W', 'A', 'V', 'E'};
    std::ofstream wavOfs(fs::path(path) / "Audio" / "dummy.wav", std::ios::binary);
    wavOfs.write(reinterpret_cast<const char*>(wav), sizeof(wav));
    wavOfs.close();

    return path;
}

constexpr const char* kFullProjectJson = R"JSON(
{
  "format": { "version": 3 },
  "name": "Full Parse Test",
  "sampleRate": 48000,
  "click": { "enabled": false, "name": "Click", "channels": 2, "gainDb": 0, "pan": 0, "mute": false, "solo": false,
             "output": { "type": "sends-only", "target": null, "sends": [] } },
  "main": { "enabled": true, "name": "Main", "channels": 2, "gainDb": -3.0, "pan": 0, "mute": false, "solo": false,
            "output": { "type": "ext-out", "target": "audio::out:1,audio::out:2" } },
  "sends": [],
  "tracks": [
    { "id": "audio::track:1", "name": "Synths", "channels": 2, "gainDb": -1.5, "pan": 0.25, "mute": true, "solo": false,
      "output": { "type": "main", "target": "audio::main", "sends": [] } }
  ],
  "songs": [
    {
      "id": "meta::song:1",
      "name": "Opener",
      "bpm": 140.0,
      "timeSignature": { "numerator": 7, "denominator": 8 },
      "onEnded": "next",
      "regions": [
        { "id": "019fd93b-3662-7f5b-8162-45f5ecad98fa", "trackId": "audio::track:1", "startSeconds": 0.0, "durationSeconds": 4.0,
          "gainDb": 0, "source": { "file": "Audio/dummy.wav", "offsetSeconds": 0 },
          "fade": { "inSeconds": 0, "outSeconds": 0, "inCurve": 0, "outCurve": 0 },
          "loop": { "enabled": false, "lengthSeconds": 0 } }
      ],
      "events": [
        { "id": "ev_pc", "type": "midiProgramChange", "triggerOnLoad": true, "midiChannel": 3, "midiProgram": 12, "latencyCompensationMs": 15.0 },
        { "id": "ev_cc", "type": "midiCC", "timeSeconds": 12.5, "midiChannel": 1, "midiCC": 74, "midiCCValue": 100 },
        { "id": "ev_http", "type": "http", "timeSeconds": 30.0, "httpUrl": "http://example.local/cue", "httpMethod": "POST", "httpBody": "go" },
        { "id": "ev_dmx", "type": "dmx", "timeSeconds": 5.0, "dmxUniverse": 2, "dmxData": [255, 0, 128] }
      ]
    }
  ],
  "cycle": { "active": false, "skip": false, "startSeconds": 0.0, "endSeconds": 4.0, "songIndex": -1 },
  "midi": { "mappings": [
    { "action": "play", "channel": 1, "triggerType": "noteOn", "number": 60 },
    { "action": "next", "channel": 0, "triggerType": "controlChange", "number": 20 }
  ] }
}
)JSON";

} // namespace

TEST_CASE("ProjectLoader parses click, main, sends, tracks, songs, events, and midi mappings") {
    const std::string path = makeProjectArchive(kFullProjectJson);

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    const Project& proj = loader.project();
    CHECK(proj.format.version == 3);
    CHECK(proj.name == "Full Parse Test");
    CHECK(proj.sampleRate == 48000.0);

    CHECK(proj.main.channels == 2);
    CHECK(proj.main.gainDb == doctest::Approx(-3.0));
    CHECK(proj.main.output.type == OutputType::ExtOut);
    REQUIRE(proj.main.output.target.has_value());
    CHECK(*proj.main.output.target == "audio::out:1,audio::out:2");
    CHECK(proj.sends.empty());

    REQUIRE(proj.songs.size() == 1);
    const SongDef& song = proj.songs[0];
    CHECK(song.id == "meta::song:1");
    CHECK(song.bpm == doctest::Approx(140.0));
    CHECK(song.timeSignature.numerator == 7);
    CHECK(song.timeSignature.denominator == 8);
    CHECK(song.onEnded == SongEnd::Next);

    REQUIRE_FALSE(proj.tracks.empty());
    CHECK(proj.tracks[0].output.type == OutputType::Main);
    REQUIRE(song.regions.size() == 1);
    CHECK(song.regions[0].trackId == "audio::track:1");
    CHECK(song.regions[0].source.file == "Audio/dummy.wav");

    REQUIRE(song.events.size() == 4);

    const TimelineEvent& pcEv = song.events[0];
    CHECK(pcEv.type == EventType::MidiProgramChange);
    CHECK(pcEv.triggerOnLoad == true);
    CHECK(pcEv.midiChannel == 3);
    CHECK(pcEv.midiProgram == 12);
    CHECK(pcEv.latencyCompensationMs == doctest::Approx(15.0));

    const TimelineEvent& ccEv = song.events[1];
    CHECK(ccEv.type == EventType::MidiCC);
    CHECK(ccEv.timeSeconds == doctest::Approx(12.5));
    CHECK(ccEv.midiCC == 74);
    CHECK(ccEv.midiCCValue == 100);

    const TimelineEvent& httpEv = song.events[2];
    CHECK(httpEv.type == EventType::Http);
    REQUIRE(httpEv.httpUrl.has_value());
    CHECK(*httpEv.httpUrl == "http://example.local/cue");
    CHECK(httpEv.httpMethod == "POST");
    REQUIRE(httpEv.httpBody.has_value());
    CHECK(*httpEv.httpBody == "go");

    const TimelineEvent& dmxEv = song.events[3];
    CHECK(dmxEv.type == EventType::Dmx);
    CHECK(dmxEv.dmxUniverse == 2);
    REQUIRE(dmxEv.dmxData.size() == 3);
    CHECK(dmxEv.dmxData[0] == 255);
    CHECK(dmxEv.dmxData[1] == 0);
    CHECK(dmxEv.dmxData[2] == 128);

    REQUIRE(proj.midi.mappings.size() == 2);
    CHECK(proj.midi.mappings[0].action == "play");
    CHECK(proj.midi.mappings[0].channel == 1);
    CHECK(proj.midi.mappings[0].triggerType == MidiTriggerType::NoteOn);
    CHECK(proj.midi.mappings[0].number == 60);
    CHECK(proj.midi.mappings[1].action == "next");
    CHECK(proj.midi.mappings[1].triggerType == MidiTriggerType::ControlChange);
    CHECK(proj.midi.mappings[1].number == 20);
}

TEST_CASE("ProjectLoader tolerates missing optional sections") {
    const std::string minimalJson = R"JSON(
{
  "format": { "version": 3 },
  "name": "Minimal",
  "sampleRate": 44100,
  "sends": [],
  "songs": []
}
)JSON";
    const std::string path = makeProjectArchive(minimalJson);

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    const Project& proj = loader.project();
    CHECK(proj.name == "Minimal");
    CHECK(proj.sends.empty());
    CHECK(proj.songs.empty());
    CHECK(proj.midi.mappings.empty());
}

TEST_CASE("ProjectLoader parses and round-trips a sends-only track") {
    // A track with no main/FOH route, routed purely through an aux send --
    // the "only sends, no output" case AudioEngine's staging validation used
    // to reject outright, fixed to treat SendsOnly as "no main route" rather
    // than an error.
    const std::string json = R"JSON(
{
  "format": { "version": 3 }, "name": "SendsOnly", "sampleRate": 48000,
  "main": { "enabled": true, "name": "Main", "channels": 2, "gainDb": 0, "pan": 0, "mute": false, "solo": false,
            "output": { "type": "ext-out", "target": "audio::out:1,audio::out:2" } },
  "sends": [
    { "id": "audio::send:1", "name": "Monitor", "channels": 2, "gainDb": 0, "pan": 0, "mute": false, "solo": false,
      "output": { "type": "ext-out", "target": "audio::out:3,audio::out:4" } }
  ],
  "tracks": [
    { "id": "t1", "name": "Click (monitor only)", "channels": 2, "gainDb": 0, "pan": 0, "mute": false, "solo": false,
      "output": { "type": "sends-only", "target": null,
        "sends": [ { "bus": "audio::send:1", "level": 70.7945784, "preFader": false, "enabled": true } ] } }
  ],
  "songs": [
    { "id": "s1", "name": "S1", "bpm": 120,
      "regions": [
        { "id": "r1", "trackId": "t1", "startSeconds": 0.0, "durationSeconds": 1.0,
          "source": { "file": "Audio/dummy.wav", "offsetSeconds": 0 } }
      ],
      "events": [] }
  ]
}
)JSON";
    const std::string path = makeProjectArchive(json);

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    const Project& proj = loader.project();
    REQUIRE(proj.songs.size() == 1);
    REQUIRE_FALSE(proj.tracks.empty());
    auto tIt = std::find_if(proj.tracks.begin(), proj.tracks.end(), [](const TrackDef& trk) { return trk.id == "t1"; });
    REQUIRE(tIt != proj.tracks.end());
    const TrackDef& t = *tIt;
    CHECK(t.output.type == OutputType::SendsOnly);
    REQUIRE(t.output.sends.size() == 1);
    CHECK(t.output.sends[0].bus == "audio::send:1");
    CHECK(t.output.sends[0].level == doctest::Approx(70.7945784));

    const std::string outPath =
        std::string(std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp")
        + "/resoset_sendsonly_roundtrip.rsnraset";
    REQUIRE(loader.saveAs(outPath, error));

    ProjectLoader reopened;
    REQUIRE(reopened.open(outPath, error));
    REQUIRE(reopened.project().songs.size() == 1);
    REQUIRE_FALSE(reopened.project().tracks.empty());
    auto rIt = std::find_if(reopened.project().tracks.begin(), reopened.project().tracks.end(), [](const TrackDef& trk) { return trk.id == "t1"; });
    REQUIRE(rIt != reopened.project().tracks.end());
    CHECK(rIt->output.type == OutputType::SendsOnly);
    REQUIRE(rIt->output.sends.size() == 1);
    CHECK(rIt->output.sends[0].bus == "audio::send:1");

    std::remove(outPath.c_str());
}

TEST_CASE("ProjectLoader rejects outdated format version 1 with migration error") {
    const std::string json = R"JSON({"formatVersion": 1, "name": "LegacyProject", "sampleRate": 48000})JSON";
    const std::string path = makeProjectArchive(json);

    ProjectLoader loader;
    std::string error;
    CHECK_FALSE(loader.open(path, error));
    CHECK(error.find("pnpm migrate") != std::string::npos);

    std::remove(path.c_str());
}

TEST_CASE("ProjectLoader rejects a current-format event with an unknown type") {
    const std::string badJson = R"JSON(
{
  "format": { "version": 3 }, "name": "Bad", "sampleRate": 48000, "sends": [],
  "songs": [
    { "id": "s1", "name": "S1", "bpm": 120,
      "events": [ { "id": "e1", "type": "notARealType" } ] }
  ]
}
)JSON";
    const std::string path = makeProjectArchive(badJson);

    ProjectLoader loader;
    std::string error;
    CHECK_FALSE(loader.open(path, error));
    CHECK_FALSE(error.empty());
}

TEST_CASE("serializeProjectJson round-trips through ProjectLoader") {
    const std::string path = makeProjectArchive(kFullProjectJson);

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    // Mutate a few fields as the Builder would.
    loader.project().name = "Round Trip";
    loader.project().songs[0].bpm = 99.5;
    loader.project().tracks[0].gainDb = -6.0;
    loader.project().main.output.target = "audio::out:5,audio::out:6";

    const std::string outPath =
        std::string(std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp")
        + "/resoset_project_roundtrip.rsnraset";

    REQUIRE(loader.saveAs(outPath, error));

    ProjectLoader loader2;
    REQUIRE(loader2.open(outPath, error));
    const Project& p = loader2.project();
    CHECK(p.name == "Round Trip");
    REQUIRE_FALSE(p.songs.empty());
    CHECK(p.songs[0].bpm == doctest::Approx(99.5));
    REQUIRE_FALSE(p.tracks.empty());
    CHECK(p.tracks[0].gainDb == doctest::Approx(-6.0));
    CHECK(p.main.output.target.value_or("") == "audio::out:5,audio::out:6");
    // Events preserved
    REQUIRE(p.songs[0].events.size() == 4);
    REQUIRE(p.songs[0].events[2].httpUrl.has_value());
    CHECK(*p.songs[0].events[2].httpUrl == "http://example.local/cue");
    REQUIRE(p.midi.mappings.size() == 2);
    CHECK(p.midi.mappings[0].action == "play");

    std::remove(outPath.c_str());
}

TEST_CASE("lighting data (fixtures, light tracks, light cues) round-trips through save/load") {
    const std::string path = makeProjectArchive(kFullProjectJson);

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    Project& p = loader.project();
    p.lighting.enabled = true;
    p.lighting.kind = LightingKind::ResoLight;
    p.lighting.resolight.columns = 3;
    p.lighting.resolight.rows = 2;
    p.lighting.idle.behavior = "static";
    p.lighting.idle.color.r = 12;
    p.lighting.idle.color.g = 34;
    p.lighting.idle.color.b = 56;
    p.lighting.idle.intensity = 0.4;
    p.lighting.defaultRefreshRateHz = 30.0;

    LightFixture fx;
    fx.id = "light::bar:1";
    fx.name = "Bar 1";
    fx.kind = LightFixture::Kind::ResoLightBar;
    fx.grid.column = 1;
    fx.grid.row = 0;
    fx.ledCount = 60;
    fx.addressable = true;
    fx.position.x = 1.5;
    fx.position.y = 0.0;
    fx.position.z = -2.25;
    fx.rotation.y = 15.0;
    fx.shape = "matrix";
    fx.matrixColumns = 6;
    fx.refreshRateHz = 15.0;
    p.lighting.fixtures.push_back(fx);

    LightFixture generic;
    generic.id = "light::fixture:2";
    generic.name = "House Left Mover";
    generic.kind = LightFixture::Kind::DmxGeneric;
    generic.dmx.universe = 2;
    generic.dmx.startChannel = 17;
    generic.dmx.channelCount = 16;
    generic.shape = "moving-head";
    generic.channelProfile = "rgbw";
    generic.tiltDegrees = 32.5;
    p.lighting.fixtures.push_back(generic);

    LightTrack track;
    track.id = "light::track:1";
    track.name = "Front Wash";
    track.fixtureIds = {"light::bar:1", "light::fixture:2"};
    p.lighting.tracks.push_back(track);

    LightCue cue;
    cue.id = "019fd93c-d272-785e-8100-7d648e9a3273";
    cue.trackId = "light::track:1";
    cue.startSeconds = 4.0;
    cue.durationSeconds = 8.0;
    cue.color = RgbColor{200, 40, 10};
    cue.intensity = 0.75;
    cue.fade.inSeconds = 0.5;
    cue.fade.outSeconds = 1.0;
    cue.label = "Chorus wash";
    cue.effect.type = "meter";
    cue.effect.sourceType = "track";
    cue.effect.sourceId = "audio::track:1";
    cue.effect.intensity = 0.65;
    cue.effect.tempoSync = true;
    cue.effect.tempoSubdivision = "1/8";
    cue.effect.rateHz = 3.5;
    cue.gradient.preset = "greenYellowRed";
    p.songs[0].lightCues.push_back(cue);

    const std::string outPath =
        std::string(std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp")
        + "/resoset_lighting_roundtrip.rsnraset";
    REQUIRE(loader.saveAs(outPath, error));

    ProjectLoader loader2;
    REQUIRE(loader2.open(outPath, error));
    const Project& p2 = loader2.project();

    CHECK(p2.lighting.enabled == true);
    CHECK(p2.lighting.kind == LightingKind::ResoLight);
    CHECK(p2.lighting.resolight.columns == 3);
    CHECK(p2.lighting.resolight.rows == 2);
    CHECK(p2.lighting.idle.behavior == "static");
    CHECK(p2.lighting.idle.color.r == 12);
    CHECK(p2.lighting.idle.color.g == 34);
    CHECK(p2.lighting.idle.color.b == 56);
    CHECK(p2.lighting.idle.intensity == doctest::Approx(0.4));
    CHECK(p2.lighting.defaultRefreshRateHz == doctest::Approx(30.0));
    REQUIRE(p2.lighting.fixtures.size() == 2);

    const LightFixture& fx2 = p2.lighting.fixtures[0];
    CHECK(fx2.id == "light::bar:1");
    CHECK(fx2.name == "Bar 1");
    CHECK(fx2.kind == LightFixture::Kind::ResoLightBar);
    CHECK(fx2.grid.column == 1);
    CHECK(fx2.ledCount == 60);
    CHECK(fx2.addressable == true);
    CHECK(fx2.position.x == doctest::Approx(1.5));
    CHECK(fx2.position.z == doctest::Approx(-2.25));
    CHECK(fx2.rotation.y == doctest::Approx(15.0));
    CHECK(fx2.shape == "matrix");
    CHECK(fx2.matrixColumns == 6);
    CHECK(fx2.refreshRateHz == doctest::Approx(15.0));

    const LightFixture& generic2 = p2.lighting.fixtures[1];
    CHECK(generic2.kind == LightFixture::Kind::DmxGeneric);
    CHECK(generic2.dmx.universe == 2);
    CHECK(generic2.dmx.startChannel == 17);
    CHECK(generic2.dmx.channelCount == 16);
    CHECK(generic2.shape == "moving-head");
    CHECK(generic2.channelProfile == "rgbw");
    CHECK(generic2.tiltDegrees == doctest::Approx(32.5));

    REQUIRE(p2.lighting.tracks.size() == 1);
    CHECK(p2.lighting.tracks[0].id == "light::track:1");
    CHECK(p2.lighting.tracks[0].name == "Front Wash");
    REQUIRE(p2.lighting.tracks[0].fixtureIds.size() == 2);
    CHECK(p2.lighting.tracks[0].fixtureIds[0] == "light::bar:1");
    CHECK(p2.lighting.tracks[0].fixtureIds[1] == "light::fixture:2");

    REQUIRE_FALSE(p2.songs.empty());
    REQUIRE(p2.songs[0].lightCues.size() == 1);
    const LightCue& cue2 = p2.songs[0].lightCues[0];
    CHECK(cue2.trackId == "light::track:1");
    CHECK(cue2.startSeconds == doctest::Approx(4.0));
    CHECK(cue2.durationSeconds == doctest::Approx(8.0));
    CHECK(cue2.color.r == 200);
    CHECK(cue2.color.g == 40);
    CHECK(cue2.color.b == 10);
    CHECK(cue2.intensity == doctest::Approx(0.75));
    CHECK(cue2.fade.inSeconds == doctest::Approx(0.5));
    CHECK(cue2.fade.outSeconds == doctest::Approx(1.0));
    REQUIRE(cue2.label.has_value());
    CHECK(*cue2.label == "Chorus wash");
    REQUIRE(cue2.effect.type.has_value());
    CHECK(*cue2.effect.type == "meter");
    CHECK(cue2.effect.sourceType == "track");
    REQUIRE(cue2.effect.sourceId.has_value());
    CHECK(*cue2.effect.sourceId == "audio::track:1");
    CHECK(cue2.effect.intensity == doctest::Approx(0.65));
    CHECK(cue2.effect.tempoSync == true);
    CHECK(cue2.effect.tempoSubdivision == "1/8");
    CHECK(cue2.effect.rateHz == doctest::Approx(3.5));
    CHECK(cue2.gradient.preset == "greenYellowRed");

    std::remove(outPath.c_str());
}

TEST_CASE("lighting defaults to disabled/none with no fixtures for a project with no lighting section") {
    const std::string path = makeProjectArchive(kFullProjectJson);
    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));
    const Project& p = loader.project();
    CHECK(p.lighting.enabled == false);
    CHECK(p.lighting.kind == LightingKind::None);
    CHECK(p.lighting.idle.behavior == "hold");
    CHECK(p.lighting.fixtures.empty());
    CHECK(p.lighting.tracks.empty());
    CHECK(p.songs[0].lightCues.empty());
}

TEST_CASE("newProject creates an unsaved project that can be saved for the first time") {
    // Regression coverage for the "empty project on startup" path: before a
    // real .rsnraset ever existed on disk, saveAs()/saveAsWithExtras() used
    // to hard-require a source archive to be open (to copy Audio/* entries
    // from), which made it impossible to ever save a project that was never
    // loaded from a file.
    ProjectLoader loader;
    CHECK_FALSE(loader.isOpen());
    CHECK(loader.archivePath().empty());

    loader.newProject("Fresh Project");
    CHECK_FALSE(loader.isOpen());
    CHECK(loader.project().name == "Fresh Project");
    CHECK(loader.project().main.output.type == OutputType::ExtOut);
    REQUIRE_FALSE(loader.project().tracks.empty());
    CHECK(loader.project().tracks[0].id == "audio::track:1");

    loader.project().songs.push_back(SongDef{});
    loader.project().songs[0].id = "song1";
    loader.project().songs[0].name = "Song One";
    loader.project().songs[0].bpm = 128.0;

    const std::string outPath =
        std::string(std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp")
        + "/resoset_new_project.rsnraset";
    std::remove(outPath.c_str());

    std::string error;
    REQUIRE(loader.saveAs(outPath, error));

    ProjectLoader reopened;
    REQUIRE(reopened.open(outPath, error));
    CHECK(reopened.project().name == "Fresh Project");
    REQUIRE_FALSE(reopened.project().songs.empty());
    CHECK(reopened.project().songs[0].name == "Song One");
    CHECK(reopened.project().songs[0].bpm == doctest::Approx(128.0));

    std::remove(outPath.c_str());
}

TEST_CASE("jsonEscapeString escapes control characters") {
    CHECK(jsonEscapeString("a\"b\\c") == "a\\\"b\\\\c");
    CHECK(jsonEscapeString("line\nbreak") == "line\\nbreak");
}
