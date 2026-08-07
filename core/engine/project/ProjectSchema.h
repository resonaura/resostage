#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace resostage {

// Bumped whenever the on-disk shape changes. ProjectLoader refuses to open
// anything below this and tells the user to run `pnpm migrate <project>`
// (scripts/migrate.mjs) -- there is deliberately NO in-engine migration path.
// The app is pre-public-beta, so a one-shot external converter is the whole
// story: when the format finally freezes, delete scripts/migrate.mjs and the
// version gate in ProjectLoader::reparseProject() and nothing else changes.
//
// Identifier canon, applied everywhere in this file:
//   * namespaced ids     "<ns>::<kind>:<n>"  -- audio::track:1, audio::send:2,
//                                               audio::out:11, light::bar:1,
//                                               light::track:3, meta::song:1
//   * namespaced singletons "<ns>::<kind>"   -- audio::main
//   * namespaced enum values "<ns>::<value>" -- resolight::bar, dmx::generic
//   * churn-heavy rows (regions, cues, sections) use UUIDv7 (see Uuid.h)
//     because they're created and destroyed constantly while editing, so a
//     dense counter would collide across copy/paste and undo.
// Optional strings are std::optional and serialize as JSON null, never "".
inline constexpr int kCurrentFormatVersion = 3;

struct ProjectFormat {
    int version = kCurrentFormatVersion;
};

// One aux send from a track/click into a send bus (post-fader by default).
struct SendConfig {
    std::string bus;      // target send bus id, e.g. "audio::send:1"
    double level = 100.0; // 0-100, LINEAR percent: gain = level / 100. 100 = unity (0 dB).
    bool preFader = false; // if true, ignores the source's own mute (still respects solo)
    bool enabled = true;
};

enum class OutputType {
    Main,      // fold pre-egress into Master's own signal (Master's gain/pan/mute govern it)
    SendsOnly, // no main route, audible only via `sends`
    ExtOut,    // exclusive physical channel(s), see `target`
    // Main route into an aux/group bus, `target` = that bus id. Distinct from
    // an `sends` row: this is where the source's signal GOES, not an extra
    // tap off it. Not spelled "send" because `sends` already means the aux
    // taps, and a type named after them would read as one.
    Bus,
};

// A track/click's output: may fan out to aux sends in addition to its main
// route. `target` is set for ExtOut -- a single physical channel
// ("audio::out:11") or a stereo pair as two comma-joined mono channels
// ("audio::out:3,audio::out:4"); there are no persisted stereo-pair bus
// objects, a stereo target is always a pair of mono physical channels -- and
// for Bus, where it is the destination bus id ("audio::send:2").
struct SourceOutput {
    OutputType type = OutputType::Main;
    std::optional<std::string> target; // null unless type is ExtOut or Bus
    std::vector<SendConfig> sends;
};

// Master/send-bus output: a bus doesn't fan out to further sends, it either
// owns physical channels directly (ExtOut) or folds pre-egress into Master
// (Main) -- SendsOnly is not a valid bus output. Named BusRoute (not
// BusOutput) to avoid colliding with the render-side resostage::BusOutput
// in engine/audio/RoutingTypes.h -- a different concept (this is *project
// data*: a bus's configured destination; that one is the *runtime* physical
// egress point RoutingEngine publishes to the audio thread).
struct BusRoute {
    OutputType type = OutputType::ExtOut;
    std::optional<std::string> target; // null unless type == ExtOut
};

// The project-global metronome. Same shape as a track (gain/pan/mute/solo/
// channels/output) so it goes through the identical mix path instead of a
// hand-duplicated one -- see Milestone 2 of the routing rewrite plan.
struct ClickChannel {
    bool enabled = false;
    std::string name = "Click";
    int channels = 2; // 1 = mono (force L=R, ignore pan)
    double gainDb = 0.0;
    double pan = 0.0; // -1..+1
    bool mute = false;
    bool solo = false;   // joins the same solo group as TrackDef::solo
    SourceOutput output; // any of the three types -- the click is routed exactly like a track
};

// Master (FOH) bus. Always owns its physical output channels directly
// (output.type == ExtOut) -- Master never folds into anything else, and
// nothing should silently share its physical channels (see BusRoute's
// Main variant: sends that should be governed by Master's own gain/pan/mute
// point AT Master via `type: Main`, they don't independently target
// Master's physical channels).
struct MasterChannel {
    bool enabled = true;
    std::string name = "Main";
    int channels = 2;
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false; // solo group of one -- inert for now, see routing plan Milestone 2
    BusRoute output;
};

// An aux/monitor/FX send bus. Fed by TrackDef::sends / ClickChannel::sends
// rows (post- or pre-fader). Its own solo group is independent of
// tracks+click's group.
struct SendBus {
    std::string id;   // "audio::send:N"
    std::string name;
    int channels = 2; // 1 = mono
    double gainDb = 0.0;
    double pan = 0.0;
    bool mute = false;
    bool solo = false;
    BusRoute output;
};

struct TrackDef {
    std::string id;   // "audio::track:N"
    std::string name;
    int channels = 2; // 1 = mono: stereo regions are summed L+R before pan/sends (replaces old TrackDef::mono bool)
    double gainDb = 0.0;
    double pan = 0.0; // -1..+1
    bool mute = false;
    bool solo = false; // joins the same solo group as ClickChannel::solo
    SourceOutput output;
};

struct RegionSource {
    std::string file; // archive path, e.g. "Audio/song1_synths1.wav"
    double offsetSeconds = 0.0; // start offset into source audio file
};

struct RegionFade {
    double inSeconds = 0.0;
    double outSeconds = 0.0;
    // Fade curvature in [-1, +1]: 0 = linear. Positive = ease-out, negative =
    // ease-in. Applied as pow(t, 2^(-curve*2)).
    double inCurve = 0.0;
    double outCurve = 0.0;
};

struct RegionLoop {
    // When true, source audio from source.offsetSeconds..(source end) repeats
    // to fill durationSeconds (clip may be longer than remaining source
    // material). lengthSeconds == 0 means "remaining source material".
    bool enabled = false;
    double lengthSeconds = 0.0;
};

// An audio clip placed on a global track for a specific song. Ids are
// UUIDv7 (see Uuid.h) -- regions are created/deleted constantly while
// editing a timeline, unlike tracks/busses/songs which are edited in place.
struct Region {
    std::string id;
    std::string trackId; // references TrackDef.id
    double startSeconds = 0.0;    // position within the song timeline
    double durationSeconds = 0.0; // 0 = full file
    double gainDb = 0.0;
    RegionSource source;
    RegionFade fade;
    RegionLoop loop;
};

struct TimeSignature {
    int numerator = 4;
    int denominator = 4;
};

// What the transport does when a song reaches its end. Serialized as
// SongDef::onEnded ("stop" | "next").
enum class SongEnd {
    Stop, // hold at the end and wait for the next trigger
    Next, // roll straight into the following song
};

enum class EventType {
    MidiNoteOn,
    MidiNoteOff,
    MidiCC,
    MidiProgramChange,
    Http,
    Dmx,
};

// A single timeline-triggered action. `type` selects which fields apply.
struct TimelineEvent {
    std::string id;
    EventType type = EventType::MidiProgramChange;
    double timeSeconds = 0.0;
    bool triggerOnLoad = false;

    int midiChannel = 1; // 1-16
    int midiNote = 60;
    int midiVelocity = 100;
    int midiCC = 0;
    int midiCCValue = 0;
    int midiProgram = 0;

    std::optional<std::string> httpUrl;
    std::string httpMethod = "POST";
    std::optional<std::string> httpBody;

    int dmxUniverse = 0;
    std::vector<uint8_t> dmxData;

    // Positive value fires the event earlier to compensate for a downstream
    // device's own processing/transmission delay.
    double latencyCompensationMs = 0.0;
};

// One physical light fixture in the rig. Kind/shape/channelProfile keep the
// exact same value sets as before this rewrite (unrelated to routing) --
// only the container shape (grid/position/rotation/dmx nesting) changes.
struct LightFixture {
    std::string id; // "light::bar:N"
    std::string name;
    enum class Kind {
        ResoLightBar,
        DmxGeneric,
    };
    Kind kind = Kind::ResoLightBar;

    struct Grid {
        int column = 0;
        int row = 0;
    } grid;
    int ledCount = 120;
    bool addressable = true;

    struct Position {
        double x = 0.0;
        double y = 0.0;
        double z = 0.0;
    } position;
    struct Rotation {
        double y = 0.0; // yaw around the vertical axis
    } rotation;
    bool mountedHorizontally = false;

    struct Dmx {
        int universe = 0;
        int startChannel = 1; // 1-based
        int channelCount = 3;
    } dmx;

    std::string shape = "bar";          // "bar" | "strip" | "ring" | "matrix" | "par" | "wash" | "spot" | "moving-head"
    int matrixColumns = 0;              // only meaningful when shape == "matrix"
    std::string channelProfile = "rgb"; // "dimmer" | "rgb" | "rgbw" | "rgbwa" | "custom"
    double tiltDegrees = 0.0;
    double refreshRateHz = 0.0; // 0 = inherit LightingConfig::defaultRefreshRateHz
    std::optional<std::string> networkHost; // null = preview-only, no hardware
};

enum class LightingKind {
    None,
    ResoLight,
    DmxGeneric,
};

struct RgbColor {
    uint8_t r = 255;
    uint8_t g = 255;
    uint8_t b = 255;
};

struct LightingIdleEffect {
    std::string type = "none";
    double rateHz = 2.0;
};

struct LightGradient {
    std::string preset = "solid";
    std::optional<std::string> colors; // null = use the preset/base color; CSV #RRGGBB stops when set
};

// What every fixture shows while the transport is stopped.
// "hold" | "blackout" | "static" | "effect".
struct LightingIdle {
    std::string behavior = "hold";
    RgbColor color{0, 0, 0};
    double intensity = 1.0;
    LightingIdleEffect effect;
    LightGradient gradient;
};

// A named row on the Light timeline -- project-level roster, mirrors
// TrackDef's relationship to Region.
struct LightTrack {
    std::string id; // "light::track:N"
    std::string name;
    std::vector<std::string> fixtureIds; // LightFixture.id refs, driven in unison
};

// Project-scoped lighting rig config (per-show data, not rig-wide
// AppSettings). Disabled by default. Owns BOTH halves of the rig: the
// physical roster (`fixtures`) and the authoring roster (`tracks`) -- they
// are meaningless apart, so they live under one key instead of `fixtures`
// here and a stray top-level `lightTracks` next to `songs`.
struct LightingConfig {
    bool enabled = false;
    LightingKind kind = LightingKind::None;
    struct ResoLight {
        int columns = 2;
        int rows = 1;
    } resolight;
    LightingIdle idle;
    double defaultRefreshRateHz = 44.0;
    std::optional<std::string> artNetTargetHost; // null = broadcast
    std::vector<LightFixture> fixtures;
    std::vector<LightTrack> tracks;
};

struct LightCueFade {
    double inSeconds = 0.0;
    double outSeconds = 0.0;
};

// Audio-reactive effect for a LightCue. Resolved by
// engine/lighting/LightOutputResolver.h.
struct LightEffect {
    std::optional<std::string> type; // null = no effect; "fire" | "pulse" | "strobe" | ... | "meter" | ...
    std::string sourceType = "bus";  // "bus" | "track" -- which meter pool sourceId is looked up in
    std::optional<std::string> sourceId; // null = master mix / first bus
    double intensity = 0.8; // 0..1 depth of the effect
    bool tempoSync = false;
    std::string tempoSubdivision = "1/4"; // "2"|"1"|"1/2"|"1/3"|"1/4"|"1/6"|"1/8"|"1/16"|"1/32"|"1/64"
    double rateHz = 2.0; // used when tempoSync == false
};

// A single light cue block placed on a song's Light timeline. Ids are
// UUIDv7, same rationale as Region.
struct LightCue {
    std::string id;
    std::string trackId; // references LightTrack.id
    double startSeconds = 0.0;
    double durationSeconds = 1.0;
    std::optional<std::string> label;
    RgbColor color{255, 255, 255};
    double intensity = 1.0; // 0..1, the cue's own held-region intensity
    LightCueFade fade;
    LightEffect effect;
    LightGradient gradient;
    // How this cue composites onto another track's simultaneously-active cue
    // on the same fixture. "normal" | "additive" | "multiply" | "difference"
    // | "lighten" | "subtractive".
    std::string blendMode = "normal";
};

// A named structural marker on the timeline ruler (Intro/Verse/Chorus/...).
// A point, not a range -- the region a marker covers is implicitly "from
// here to the next marker (or song end)".
struct SongSection {
    std::string id; // UUIDv7 -- same churn rationale as Region/LightCue
    std::string name = "Section";
    double startSeconds = 0.0;
    int colorIndex = 0; // cosmetic track colour index for the SPA
};

struct SongDef {
    std::string id; // "meta::song:N"
    std::string name;
    double bpm = 120.0;
    TimeSignature timeSignature;
    SongEnd onEnded = SongEnd::Stop;
    std::vector<Region> regions;
    std::vector<TimelineEvent> events;
    std::vector<SongSection> sections;
    std::vector<LightCue> lightCues;
};

// ONE project-wide Logic-style cycle (not per-song). start/end are song-local
// seconds on `songIndex`. Coordinates persist when inactive so toggling
// cycle on restores the range.
struct ProjectCycle {
    bool active = false;
    // When true: jump over [startSeconds, endSeconds) instead of looping it.
    bool skip = false;
    double startSeconds = 0.0;
    double endSeconds = 4.0;
    int songIndex = -1; // -1 = unset / no song yet
};

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

struct MidiConfig {
    std::vector<MidiMapping> mappings;
};

struct Project {
    ProjectFormat format;
    std::string name;
    double sampleRate = 48000.0;
    ClickChannel click;
    MasterChannel main;
    std::vector<SendBus> sends;
    std::vector<TrackDef> tracks;
    LightingConfig lighting; // fixtures + light tracks both live in here
    std::vector<SongDef> songs;
    ProjectCycle cycle; // single project-wide cycle zone, not per-song
    MidiConfig midi;
    // Keybindings are no longer project data -- they're rig-wide, managed by
    // AppSettings (see core/app/config/AppSettings.cpp's keybindings map).
};

} // namespace resostage
