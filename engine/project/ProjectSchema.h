#pragma once

#include <string>
#include <vector>

namespace resoset {

struct TrackDef {
    std::string id;
    std::string name;
    std::string file;  // path within the archive, e.g. "Audio/song1_synths1.wav"
    std::string busId; // references BusDef::id
    double gainDb = 0.0;
    double pan = 0.0; // -1..+1
    bool mute = false;
};

struct TimeSignature {
    int numerator = 4;
    int denominator = 4;
};

enum class PlaybackMode {
    WaitForTrigger,
    AutoplayNext,
};

struct SongDef {
    std::string id;
    std::string name;
    double bpm = 120.0;
    TimeSignature timeSignature;
    PlaybackMode playbackMode = PlaybackMode::WaitForTrigger;
    std::vector<TrackDef> tracks;
    // `events` (MIDI/DMX/HTTP timeline events), `keybindings` and `midiMappings`
    // are present in project.json for forward-compatibility but intentionally
    // not modeled/parsed yet -- they land in a later milestone.
};

struct BusOutputDef {
    int startChannel = 0;
};

struct BusDef {
    std::string id;
    std::string name;
    int channels = 2;
    BusOutputDef output;
    double gainDb = 0.0;
};

struct Project {
    int formatVersion = 1;
    std::string name;
    double sampleRate = 48000.0;
    std::vector<BusDef> busses;
    std::vector<SongDef> songs;
};

} // namespace resoset
