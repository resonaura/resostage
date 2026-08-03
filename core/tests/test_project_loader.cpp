#include "doctest.h"

#include "miniz.h"
#include "project/ProjectJson.h"
#include "project/ProjectLoader.h"

#include <cstdio>
#include <cstring>
#include <string>

using namespace resostage;

namespace {

std::string makeProjectArchive(const std::string& projectJson) {
    const std::string path =
        std::string(std::getenv("TMPDIR") != nullptr ? std::getenv("TMPDIR") : "/tmp") + "/resoset_project_loader_test.rsnraset";

    mz_zip_archive zip;
    std::memset(&zip, 0, sizeof(zip));
    mz_zip_writer_init_file(&zip, path.c_str(), 0);
    mz_zip_writer_add_mem(&zip, "project.json", projectJson.data(), projectJson.size(), MZ_BEST_SPEED);
    // A tiny placeholder WAV so track file references resolve if ever opened.
    const uint8_t wav[] = {'R', 'I', 'F', 'F', 4, 0, 0, 0, 'W', 'A', 'V', 'E'};
    mz_zip_writer_add_mem(&zip, "Audio/dummy.wav", wav, sizeof(wav), MZ_BEST_SPEED);
    mz_zip_writer_finalize_archive(&zip);
    mz_zip_writer_end(&zip);
    return path;
}

constexpr const char* kFullProjectJson = R"JSON(
{
  "formatVersion": 1,
  "name": "Full Parse Test",
  "sampleRate": 48000,
  "busses": [
    { "id": "bus_main", "name": "Main", "channels": 2, "output": { "startChannel": 0 }, "gainDb": -3.0 }
  ],
  "songs": [
    {
      "id": "song_1",
      "name": "Opener",
      "bpm": 140.0,
      "timeSignature": { "numerator": 7, "denominator": 8 },
      "playbackMode": "autoplayNext",
      "tracks": [
        { "id": "trk_1", "name": "Synths", "file": "Audio/dummy.wav", "bus": "bus_main", "gainDb": -1.5, "pan": 0.25, "mute": true }
      ],
      "events": [
        { "id": "ev_pc", "type": "midiProgramChange", "triggerOnLoad": true, "midiChannel": 3, "midiProgram": 12, "latencyCompensationMs": 15.0 },
        { "id": "ev_cc", "type": "midiCC", "timeSeconds": 12.5, "midiChannel": 1, "midiCC": 74, "midiCCValue": 100 },
        { "id": "ev_http", "type": "http", "timeSeconds": 30.0, "httpUrl": "http://example.local/cue", "httpMethod": "POST", "httpBody": "go" },
        { "id": "ev_dmx", "type": "dmx", "timeSeconds": 5.0, "dmxUniverse": 2, "dmxData": [255, 0, 128] }
      ]
    }
  ],
  "keybindings": { "play": "space", "next": "n" },
  "midiMappings": [
    { "action": "play", "channel": 1, "triggerType": "noteOn", "number": 60 },
    { "action": "next", "channel": 0, "triggerType": "controlChange", "number": 20 }
  ]
}
)JSON";

} // namespace

TEST_CASE("ProjectLoader parses busses, songs, tracks, events, keybindings, and midiMappings") {
    const std::string path = makeProjectArchive(kFullProjectJson);

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    const Project& proj = loader.project();
    CHECK(proj.formatVersion == 1);
    CHECK(proj.name == "Full Parse Test");
    CHECK(proj.sampleRate == 48000.0);

    REQUIRE(proj.busses.size() == 1);
    CHECK(proj.busses[0].id == "bus_main");
    CHECK(proj.busses[0].channels == 2);
    CHECK(proj.busses[0].output.startChannel == 0);
    CHECK(proj.busses[0].gainDb == doctest::Approx(-3.0));

    REQUIRE(proj.songs.size() == 1);
    const SongDef& song = proj.songs[0];
    CHECK(song.id == "song_1");
    CHECK(song.bpm == doctest::Approx(140.0));
    CHECK(song.timeSignature.numerator == 7);
    CHECK(song.timeSignature.denominator == 8);
    CHECK(song.playbackMode == PlaybackMode::AutoplayNext);

    REQUIRE_FALSE(proj.tracks.empty());
    REQUIRE(song.regions.size() == 1);
    CHECK(song.regions[0].trackId == "trk_1");
    CHECK(song.regions[0].file == "Audio/dummy.wav");

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
    CHECK(httpEv.httpUrl == "http://example.local/cue");
    CHECK(httpEv.httpMethod == "POST");
    CHECK(httpEv.httpBody == "go");

    const TimelineEvent& dmxEv = song.events[3];
    CHECK(dmxEv.type == EventType::Dmx);
    CHECK(dmxEv.dmxUniverse == 2);
    REQUIRE(dmxEv.dmxData.size() == 3);
    CHECK(dmxEv.dmxData[0] == 255);
    CHECK(dmxEv.dmxData[1] == 0);
    CHECK(dmxEv.dmxData[2] == 128);

    REQUIRE(proj.keybindings.size() == 2);
    CHECK(proj.keybindings.at("play") == "space");
    CHECK(proj.keybindings.at("next") == "n");

    REQUIRE(proj.midiMappings.size() == 2);
    CHECK(proj.midiMappings[0].action == "play");
    CHECK(proj.midiMappings[0].channel == 1);
    CHECK(proj.midiMappings[0].triggerType == MidiTriggerType::NoteOn);
    CHECK(proj.midiMappings[0].number == 60);
    CHECK(proj.midiMappings[1].action == "next");
    CHECK(proj.midiMappings[1].triggerType == MidiTriggerType::ControlChange);
    CHECK(proj.midiMappings[1].number == 20);
}

TEST_CASE("ProjectLoader tolerates missing optional sections") {
    const std::string minimalJson = R"JSON(
{
  "formatVersion": 1,
  "name": "Minimal",
  "sampleRate": 44100,
  "busses": [],
  "songs": []
}
)JSON";
    const std::string path = makeProjectArchive(minimalJson);

    ProjectLoader loader;
    std::string error;
    REQUIRE(loader.open(path, error));

    const Project& proj = loader.project();
    CHECK(proj.name == "Minimal");
    CHECK(proj.busses.empty());
    CHECK(proj.songs.empty());
    CHECK(proj.keybindings.empty());
    CHECK(proj.midiMappings.empty());
}

TEST_CASE("ProjectLoader parses and round-trips a sends-only track (empty bus)") {
    // A track with no main/FOH bus, routed purely through aux sends -- the
    // "only sends, no output" case AudioEngine's staging validation used to
    // reject outright (empty busId treated as a dangling reference), fixed
    // to treat an empty busId as "no main route" rather than an error.
    const std::string json = R"JSON(
{
  "formatVersion": 1, "name": "SendsOnly", "sampleRate": 48000,
  "busses": [
    { "id": "bus_main", "name": "Main", "channels": 2, "output": { "startChannel": 0 } },
    { "id": "bus_aux", "name": "Monitor", "channels": 2, "output": { "startChannel": 2 }, "isAux": true }
  ],
  "songs": [
    { "id": "s1", "name": "S1", "bpm": 120, "tracks": [
        { "id": "t1", "name": "Click (monitor only)", "file": "Audio/dummy.wav", "bus": "",
          "sends": [ { "bus": "bus_aux", "gainDb": -3.0 } ] }
      ], "events": [] }
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
    CHECK(t.busId.empty());
    REQUIRE(t.sends.size() == 1);
    CHECK(t.sends[0].busId == "bus_aux");

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
    CHECK(rIt->busId.empty());
    REQUIRE(rIt->sends.size() == 1);
    CHECK(rIt->sends[0].busId == "bus_aux");

    std::remove(outPath.c_str());
}

TEST_CASE("ProjectLoader rejects an event with an unknown type") {
    const std::string badJson = R"JSON(
{
  "formatVersion": 1, "name": "Bad", "sampleRate": 48000, "busses": [],
  "songs": [
    { "id": "s1", "name": "S1", "bpm": 120, "tracks": [],
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
    loader.project().busses[0].output.startChannel = 4;

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
    REQUIRE_FALSE(p.busses.empty());
    CHECK(p.busses[0].output.startChannel == 4);
    // Events preserved
    REQUIRE(p.songs[0].events.size() == 4);
    CHECK(p.songs[0].events[2].httpUrl == "http://example.local/cue");
    CHECK(p.keybindings.at("play") == "space");

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
    p.lighting.resoLightColumns = 3;
    p.lighting.resoLightRows = 2;
    p.lighting.idleBehavior = "staticColor";
    p.lighting.idleColorR = 12;
    p.lighting.idleColorG = 34;
    p.lighting.idleColorB = 56;
    p.lighting.idleIntensity = 0.4;
    p.lighting.defaultRefreshRateHz = 30.0;

    LightFixture fx;
    fx.id = "bar_1";
    fx.name = "Bar 1";
    fx.kind = LightFixture::Kind::ResoLightBar;
    fx.gridColumn = 1;
    fx.gridRow = 0;
    fx.ledCount = 60;
    fx.addressable = true;
    fx.posX = 1.5;
    fx.posY = 0.0;
    fx.posZ = -2.25;
    fx.rotationYDeg = 15.0;
    fx.shape = "matrix";
    fx.matrixCols = 6;
    fx.refreshRateHz = 15.0;
    p.lighting.fixtures.push_back(fx);

    LightFixture generic;
    generic.id = "mover_1";
    generic.name = "House Left Mover";
    generic.kind = LightFixture::Kind::DmxGeneric;
    generic.dmxUniverse = 2;
    generic.dmxStartChannel = 17;
    generic.dmxChannelCount = 16;
    generic.shape = "movingHead";
    generic.channelProfile = "rgbw";
    generic.tiltDeg = 32.5;
    p.lighting.fixtures.push_back(generic);

    LightTrack track;
    track.id = "lt_1";
    track.name = "Front Wash";
    track.fixtureIds = {"bar_1", "mover_1"};
    p.lightTracks.push_back(track);

    LightCue cue;
    cue.id = "cue_1";
    cue.trackId = "lt_1";
    cue.startSeconds = 4.0;
    cue.durationSeconds = 8.0;
    cue.colorR = 200;
    cue.colorG = 40;
    cue.colorB = 10;
    cue.intensity = 0.75;
    cue.fadeInSeconds = 0.5;
    cue.fadeOutSeconds = 1.0;
    cue.label = "Chorus wash";
    cue.effectType = "meter";
    cue.effectSourceType = "track";
    cue.effectSourceId = "trk_3";
    cue.effectIntensity = 0.65f;
    cue.tempoSync = true;
    cue.tempoSubdiv = "1/8";
    cue.effectRateHz = 3.5f;
    cue.gradientPreset = "greenYellowRed";
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
    CHECK(p2.lighting.resoLightColumns == 3);
    CHECK(p2.lighting.resoLightRows == 2);
    CHECK(p2.lighting.idleBehavior == "staticColor");
    CHECK(p2.lighting.idleColorR == 12);
    CHECK(p2.lighting.idleColorG == 34);
    CHECK(p2.lighting.idleColorB == 56);
    CHECK(p2.lighting.idleIntensity == doctest::Approx(0.4));
    CHECK(p2.lighting.defaultRefreshRateHz == doctest::Approx(30.0));
    REQUIRE(p2.lighting.fixtures.size() == 2);

    const LightFixture& fx2 = p2.lighting.fixtures[0];
    CHECK(fx2.id == "bar_1");
    CHECK(fx2.name == "Bar 1");
    CHECK(fx2.kind == LightFixture::Kind::ResoLightBar);
    CHECK(fx2.gridColumn == 1);
    CHECK(fx2.ledCount == 60);
    CHECK(fx2.addressable == true);
    CHECK(fx2.posX == doctest::Approx(1.5));
    CHECK(fx2.posZ == doctest::Approx(-2.25));
    CHECK(fx2.rotationYDeg == doctest::Approx(15.0));
    CHECK(fx2.shape == "matrix");
    CHECK(fx2.matrixCols == 6);
    CHECK(fx2.refreshRateHz == doctest::Approx(15.0));

    const LightFixture& generic2 = p2.lighting.fixtures[1];
    CHECK(generic2.kind == LightFixture::Kind::DmxGeneric);
    CHECK(generic2.dmxUniverse == 2);
    CHECK(generic2.dmxStartChannel == 17);
    CHECK(generic2.dmxChannelCount == 16);
    CHECK(generic2.shape == "movingHead");
    CHECK(generic2.channelProfile == "rgbw");
    CHECK(generic2.tiltDeg == doctest::Approx(32.5));

    REQUIRE(p2.lightTracks.size() == 1);
    CHECK(p2.lightTracks[0].id == "lt_1");
    CHECK(p2.lightTracks[0].name == "Front Wash");
    REQUIRE(p2.lightTracks[0].fixtureIds.size() == 2);
    CHECK(p2.lightTracks[0].fixtureIds[0] == "bar_1");
    CHECK(p2.lightTracks[0].fixtureIds[1] == "mover_1");

    REQUIRE_FALSE(p2.songs.empty());
    REQUIRE(p2.songs[0].lightCues.size() == 1);
    const LightCue& cue2 = p2.songs[0].lightCues[0];
    CHECK(cue2.trackId == "lt_1");
    CHECK(cue2.startSeconds == doctest::Approx(4.0));
    CHECK(cue2.durationSeconds == doctest::Approx(8.0));
    CHECK(cue2.colorR == 200);
    CHECK(cue2.colorG == 40);
    CHECK(cue2.colorB == 10);
    CHECK(cue2.intensity == doctest::Approx(0.75));
    CHECK(cue2.fadeInSeconds == doctest::Approx(0.5));
    CHECK(cue2.fadeOutSeconds == doctest::Approx(1.0));
    CHECK(cue2.label == "Chorus wash");
    CHECK(cue2.effectType == "meter");
    CHECK(cue2.effectSourceType == "track");
    CHECK(cue2.effectSourceId == "trk_3");
    CHECK(cue2.effectIntensity == doctest::Approx(0.65));
    CHECK(cue2.tempoSync == true);
    CHECK(cue2.tempoSubdiv == "1/8");
    CHECK(cue2.effectRateHz == doctest::Approx(3.5));
    CHECK(cue2.gradientPreset == "greenYellowRed");

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
    CHECK(p.lighting.idleBehavior == "holdLast");
    CHECK(p.lighting.fixtures.empty());
    CHECK(p.lightTracks.empty());
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
    REQUIRE_FALSE(loader.project().busses.empty());
    CHECK(loader.project().busses[0].id == "main");

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
