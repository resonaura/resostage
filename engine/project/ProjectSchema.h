#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace resoset {

// One aux send from a track into an Aux bus (post-fader by default).
// Multiple sends let a stem feed FOH + drummer monitor + guitarist mono, etc.
struct TrackSendDef {
    std::string busId;     // must reference a BusDef with isAux == true (or any bus)
    double gainDb = 0.0;   // send level relative to unity
    bool preFader = false; // if true, ignores track fader/mute (still respects solo)
    bool enabled = true;
};

struct TrackDef {
    std::string id;
    std::string name;
    std::string file;  // path within the archive, e.g. "Audio/song1_synths1.wav"
    std::string busId; // main (FOH) bus assignment
    double gainDb = 0.0;
    double pan = 0.0; // -1..+1
    bool mute = false;
    bool solo = false; // if any track is soloed, non-solo tracks are silenced
    std::vector<TrackSendDef> sends; // aux matrix rows for this track

    // Clip trim boundaries, set via the Builder's waveform trim preview.
    // Both 0.0 means "untrimmed" (the full file). NOTE: persisted metadata
    // only -- the playback engine does not yet clip reads to this range;
    // see ClipTrimEditor's doc comment.
    double trimStartSeconds = 0.0;
    double trimEndSeconds = 0.0;
};

struct TimeSignature {
    int numerator = 4;
    int denominator = 4;
};

enum class PlaybackMode {
    WaitForTrigger,
    AutoplayNext,
};

// A single timeline-triggered action. `type` selects which fields apply.
// Fired either at an absolute time within the song (timeSeconds) or once
// when the song is staged/loaded (triggerOnLoad -- e.g. sending a Program
// Change to prepare outboard gear before the player presses Play).
enum class EventType {
    MidiNoteOn,
    MidiNoteOff,
    MidiCC,
    MidiProgramChange,
    Http,
    Dmx,
};

struct TimelineEvent {
    std::string id;
    EventType type = EventType::MidiProgramChange;
    double timeSeconds = 0.0;
    bool triggerOnLoad = false;

    // MIDI fields (type == MidiNoteOn/MidiNoteOff/MidiCC/MidiProgramChange)
    int midiChannel = 1; // 1-16
    int midiNote = 60;
    int midiVelocity = 100;
    int midiCC = 0;
    int midiCCValue = 0;
    int midiProgram = 0;

    // HTTP fields (type == Http)
    std::string httpUrl;
    std::string httpMethod = "POST";
    std::string httpBody;

    // DMX fields (type == Dmx). Untested without real Art-Net hardware --
    // see DmxDispatcher's doc comment.
    int dmxUniverse = 0;
    std::vector<uint8_t> dmxData;

    // Positive value fires the event earlier to compensate for a downstream
    // device's own processing/transmission delay.
    double latencyCompensationMs = 0.0;
};

// A named structural marker on the timeline ruler (Intro/Verse/Chorus/
// Bridge/Outro/Custom). Sections are points, not explicit ranges -- the
// region a section covers is implicitly "from this marker to the next one
// (or song end)", matching how markers work in most DAWs.
struct SongSection {
    std::string id;
    std::string name = "Section";
    double startSeconds = 0.0;
    int colorIndex = 0; // index into ui::Accent's cycle, see UiColors.h
};

struct SongDef {
    std::string id;
    std::string name;
    double bpm = 120.0;
    TimeSignature timeSignature;
    PlaybackMode playbackMode = PlaybackMode::WaitForTrigger;
    std::vector<TrackDef> tracks;
    std::vector<TimelineEvent> events;
    std::vector<SongSection> sections;

    // Built-in programmatic click generator (see ClickGenerator). Separate
    // from and compatible with a user-supplied click.wav routed as an
    // ordinary track -- bands can use either or both.
    bool builtInClickEnabled = false;
    std::string builtInClickBusId;
    double builtInClickGainDb = -6.0;
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
    bool mute = false;
    bool solo = false; // if any bus is soloed, non-solo busses are silenced
    // Aux buses are primarily fed by TrackSendDef rows (monitor mixes).
    // Main buses are the default track.busId destinations (FOH stems).
    bool isAux = false;
};

// action name (e.g. "play", "stop", "next", "prev") -> key description string
// parseable by juce::KeyPress::createFromDescription (e.g. "space", "n", "cmd + p").
using KeyBindingMap = std::unordered_map<std::string, std::string>;

enum class MidiTriggerType {
    NoteOn,
    ControlChange,
};

struct MidiMapping {
    std::string action;
    int channel = 0; // 1-16, 0 = any channel
    MidiTriggerType triggerType = MidiTriggerType::NoteOn;
    int number = 0; // note number or CC number
};

struct Project {
    int formatVersion = 1;
    std::string name;
    double sampleRate = 48000.0;
    std::vector<BusDef> busses;
    std::vector<SongDef> songs;
    KeyBindingMap keybindings;
    std::vector<MidiMapping> midiMappings;
};

} // namespace resoset
