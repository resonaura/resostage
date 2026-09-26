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
inline constexpr int kCurrentFormatVersion = 4;
// Format 4 only added optional insert chains. Version 3 projects have the
// same routing/timeline shape and can therefore be upgraded losslessly while
// parsing by supplying empty chains. Older revisions changed identifiers and
// ownership and still require the explicit migrator.
inline constexpr int kMinimumReadableFormatVersion = 3;

// The single on-disk project data file (holds the full WProject schema, i.e.
// everything that used to live in project.json). Chosen so double-clicking it
// is the file-association hook -- the parent directory is the .rsnraset package.
inline constexpr const char* kProjectDataFileName = "project.rsnrasetmeta";
// Legacy file that held the same data before the merge; still read + migrated
// (parsed, re-written as kProjectDataFileName, then deleted) on open.
inline constexpr const char* kLegacyProjectFileName = "project.json";

struct ProjectFormat {
    int version = kCurrentFormatVersion;
};

enum class SendTap : uint8_t {
    PreFader = 0,
    PostFader = 1,
    PostPan = 2,
};

inline std::string sendTapToString(SendTap tap) {
    switch (tap) {
        case SendTap::PreFader: return "pre-fader";
        case SendTap::PostFader: return "post-fader";
        case SendTap::PostPan:
        default: return "post-pan";
    }
}

inline SendTap sendTapFromString(const std::string& str, bool fallbackPreFader = false) {
    if (str == "pre" || str == "pre-fader" || str == "prefader") return SendTap::PreFader;
    if (str == "post-fader" || str == "postfader") return SendTap::PostFader;
    if (str == "post" || str == "post-pan" || str == "postpan") return SendTap::PostPan;
    return fallbackPreFader ? SendTap::PreFader : SendTap::PostPan;
}

// One aux send from a track/click into a send bus (post-pan by default).
struct SendConfig {
    std::string bus;      // target send bus id, e.g. "audio::send:1"
    double level = 100.0; // 0-100, LINEAR percent: gain = level / 100. 100 = unity (0 dB).
    bool preFader = false; // if true, ignores the source's own mute (still respects solo)
    bool enabled = true;
    bool lowLatencySafe = false;
    SendTap tap = SendTap::PostPan;
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

// Stable catalog identity plus human-readable fallback metadata. The host
// resolves `identifier` against its device-local catalog; the remaining fields
// let another machine explain what is missing without guessing from a path.
struct PluginReference {
    std::string identifier;
    std::string format;
    std::string name;
    std::string manufacturer;
    std::string fileOrIdentifier;
    bool instrument = false;
};

// One ordered insert in a strip's pre-fader chain. Opaque vendor state is a
// separate package resource (normally Plugins/<slot-id>.state), never base64
// inside project.rsnrasetmeta. A missing effect degrades to pass-through.
struct PluginSlot {
    std::string id; // UUIDv7; stable across reorder/save/load
    PluginReference plugin;
    bool bypassed = false;
    std::optional<std::string> stateResource;
    bool keepAwake = false; // Exclude from power management / auto-suspension
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
    bool soloSafe = false;
    SourceOutput output; // any of the three types -- the click is routed exactly like a track
    std::vector<PluginSlot> plugins;
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
    bool soloSafe = false;
    BusRoute output;
    std::vector<PluginSlot> plugins;
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
    bool soloSafe = false;
    BusRoute output;
    std::vector<PluginSlot> plugins;
};

enum class TrackKind {
    Audio,
    Instrument,
    MIDI,
    ExternalMIDI,
    Lighting,
    Folder,
    BusTimeline,
};

inline const char* trackKindToString(TrackKind kind) {
    switch (kind) {
        case TrackKind::Audio: return "audio";
        case TrackKind::Instrument: return "instrument";
        case TrackKind::MIDI: return "midi";
        case TrackKind::ExternalMIDI: return "externalMidi";
        case TrackKind::Lighting: return "lighting";
        case TrackKind::Folder: return "folder";
        case TrackKind::BusTimeline: return "busTimeline";
    }
    return "audio";
}

inline TrackKind trackKindFromString(const std::string& s) {
    if (s == "instrument") return TrackKind::Instrument;
    if (s == "midi") return TrackKind::MIDI;
    if (s == "externalMidi") return TrackKind::ExternalMIDI;
    if (s == "lighting") return TrackKind::Lighting;
    if (s == "folder") return TrackKind::Folder;
    if (s == "busTimeline") return TrackKind::BusTimeline;
    return TrackKind::Audio;
}

enum class ExecutionTarget {
    Local,
    RemotePeer,
};

inline const char* executionTargetToString(ExecutionTarget target) {
    switch (target) {
        case ExecutionTarget::Local: return "local";
        case ExecutionTarget::RemotePeer: return "remotePeer";
    }
    return "local";
}

inline ExecutionTarget executionTargetFromString(const std::string& s) {
    if (s == "remotePeer" || s == "remote") return ExecutionTarget::RemotePeer;
    return ExecutionTarget::Local;
}

enum class PolarityMask : uint8_t {
    None = 0,
    Left = 1,
    Right = 2,
    Both = 3,
};

inline std::string polarityToString(PolarityMask mask) {
    switch (mask) {
        case PolarityMask::Left: return "left";
        case PolarityMask::Right: return "right";
        case PolarityMask::Both: return "both";
        case PolarityMask::None:
        default: return "none";
    }
}

inline PolarityMask polarityFromString(const std::string& str, bool fallbackPhaseInvert = false) {
    if (str == "left") return PolarityMask::Left;
    if (str == "right") return PolarityMask::Right;
    if (str == "both") return PolarityMask::Both;
    if (str == "none") return fallbackPhaseInvert ? PolarityMask::Both : PolarityMask::None;
    return fallbackPhaseInvert ? PolarityMask::Both : PolarityMask::None;
}

struct TrackDef {
    std::string id;   // "audio::track:N"
    std::string name;
    TrackKind kind = TrackKind::Audio;
    // Decoupled MixStrip ID: defaults to track id ("audio::track:N").
    // Multiple tracks can target the same instrument strip or bus strip.
    std::optional<std::string> stripId;
    ExecutionTarget target = ExecutionTarget::Local;
    std::optional<std::string> peerNodeId;
    int channels = 2; // 1 = mono: stereo regions are summed L+R before pan/sends (replaces old TrackDef::mono bool)
    double gainDb = 0.0;
    double pan = 0.0; // -1..+1
    bool mute = false;
    bool solo = false; // joins the same solo group as ClickChannel::solo
    bool soloSafe = false;
    SourceOutput output;
    std::vector<PluginSlot> plugins;
    bool recordArmed = false;
    bool inputMonitoring = false;
    std::string inputSource = "none";
    int midiInputChannel = 0; // 0 = omni, 1..16
    std::string midiInputDevice = "all";
    double inputTrimDb = 0.0;
    bool phaseInvert = false;
    PolarityMask polarity = PolarityMask::None;

    [[nodiscard]] const std::string& effectiveStripId() const noexcept {
        return (stripId && !stripId->empty()) ? *stripId : id;
    }
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

// Per-region playback treatment: how fast, how high, which way round.
//
// All three need RANDOM ACCESS to the source, which the streaming ring cannot
// give -- it decodes strictly forwards and holds only a window around the
// playhead. They are therefore served from the resident (fully in-RAM) copy of
// a region, and a region carrying any of them is pinned resident for as long
// as it does. See StreamingTrackBuffer::tryLoadResident and the resident
// branch of its read().
struct RegionPlayback {
    // Playback rate. 1.0 is untouched. Pitch follows speed, as on tape --
    // independent pitch needs a phase vocoder, which is a separate path.
    double speed = 1.0;
    // Transpose in semitones, independent of speed. Requires the stretcher;
    // 0 means "leave it alone", which is the only value the tape path honours.
    double semitones = 0.0;
    // Play the region's source window backwards. Exact: no resampling, just
    // a mirrored read, so it is lossless and costs nothing extra.
    bool reverse = false;
};

struct RegionLoop {
    // When true, source audio from source.offsetSeconds..(source end) repeats
    // to fill durationSeconds (clip may be longer than remaining source
    // material). lengthSeconds == 0 means "remaining source material".
    bool enabled = false;
    double lengthSeconds = 0.0;
};
enum class AutomationDomain : uint8_t {
    Strip = 0,    // Mixer strip parameters (gainDb, pan, send levels, mute)
    Plugin = 1,   // Hosted VST3/AU plugin parameters
    MidiCC = 2,   // MIDI Continuous Controllers & Channel Voice messages
    Lighting = 3  // DMX channel, universe master, fixture attributes
};

inline const char* automationDomainToString(AutomationDomain domain) {
    switch (domain) {
        case AutomationDomain::Strip: return "strip";
        case AutomationDomain::Plugin: return "plugin";
        case AutomationDomain::MidiCC: return "midiCC";
        case AutomationDomain::Lighting: return "lighting";
    }
    return "strip";
}

inline AutomationDomain automationDomainFromString(const std::string& s) {
    if (s == "plugin") return AutomationDomain::Plugin;
    if (s == "midiCC" || s == "midicc" || s == "midi") return AutomationDomain::MidiCC;
    if (s == "lighting" || s == "light") return AutomationDomain::Lighting;
    return AutomationDomain::Strip;
}

enum class ParameterValueType : uint8_t {
    FloatNormalized = 0, // 0.0 to 1.0 (used by VST3 and generic controls)
    Decibels = 1,        // -inf to +12.0 dB (audio faders)
    FrequencyHz = 2,     // 20 Hz to 20,000 Hz (EQ, filters)
    Milliseconds = 3,    // 0.1 ms to 10,000 ms (delays, reverb times)
    Boolean = 4,         // 0 or 1 (mutes, solos, bypass toggles)
    Integer = 5,         // Discrete steps (e.g. waveform selector, MIDI CC 0-127)
    ColorRgb = 6         // 24-bit RGB packed for lighting
};

inline const char* parameterValueTypeToString(ParameterValueType type) {
    switch (type) {
        case ParameterValueType::FloatNormalized: return "floatNormalized";
        case ParameterValueType::Decibels: return "decibels";
        case ParameterValueType::FrequencyHz: return "frequencyHz";
        case ParameterValueType::Milliseconds: return "milliseconds";
        case ParameterValueType::Boolean: return "boolean";
        case ParameterValueType::Integer: return "integer";
        case ParameterValueType::ColorRgb: return "colorRgb";
    }
    return "floatNormalized";
}

inline ParameterValueType parameterValueTypeFromString(const std::string& s) {
    if (s == "decibels" || s == "db") return ParameterValueType::Decibels;
    if (s == "frequencyHz" || s == "hz") return ParameterValueType::FrequencyHz;
    if (s == "milliseconds" || s == "ms") return ParameterValueType::Milliseconds;
    if (s == "boolean" || s == "bool") return ParameterValueType::Boolean;
    if (s == "integer" || s == "int") return ParameterValueType::Integer;
    if (s == "colorRgb" || s == "rgb") return ParameterValueType::ColorRgb;
    return ParameterValueType::FloatNormalized;
}

enum class AutomationWriteMode : uint8_t {
    Read = 0,
    Touch = 1,
    Latch = 2,
    Write = 3
};

inline const char* automationWriteModeToString(AutomationWriteMode mode) {
    switch (mode) {
        case AutomationWriteMode::Read: return "read";
        case AutomationWriteMode::Touch: return "touch";
        case AutomationWriteMode::Latch: return "latch";
        case AutomationWriteMode::Write: return "write";
    }
    return "read";
}

inline AutomationWriteMode automationWriteModeFromString(const std::string& s) {
    if (s == "touch") return AutomationWriteMode::Touch;
    if (s == "latch") return AutomationWriteMode::Latch;
    if (s == "write") return AutomationWriteMode::Write;
    return AutomationWriteMode::Read;
}

enum class AutomationScope : uint8_t {
    Track = 0,      // Locked to global song timeline
    Region = 1,     // Local to region, moves/loops with region
    Modulation = 2  // Relative bipolar delta (+- delta)
};

inline const char* automationScopeToString(AutomationScope scope) {
    switch (scope) {
        case AutomationScope::Track: return "track";
        case AutomationScope::Region: return "region";
        case AutomationScope::Modulation: return "modulation";
    }
    return "track";
}

inline AutomationScope automationScopeFromString(const std::string& s) {
    if (s == "region") return AutomationScope::Region;
    if (s == "modulation") return AutomationScope::Modulation;
    return AutomationScope::Track;
}

struct AutomationTarget {
    AutomationDomain domain = AutomationDomain::Strip;
    std::string entityId;       // Strip ID ("audio::track:1"), Plugin Slot UUID, or Fixture ID
    std::string parameterId;    // "faderGainDb", "pan", "mute", "send:0", "param:104", "cc:1", "intensity"
    ParameterValueType valueType = ParameterValueType::FloatNormalized;
    float defaultValue = 0.0f;
    float minValue = 0.0f;
    float maxValue = 1.0f;
};

struct AutomationPoint {
    double timeBeats = 0.0;     // Position in musical beats relative to lane origin
    float value = 0.0f;         // Normalized or typed target value
    float curve = 0.0f;         // Curvature in [-1.0, +1.0]: 0 = linear. Formula: pow(t, 2^(-curve * 2))
};

struct AutomationLane {
    std::string id;             // UUIDv7
    AutomationTarget target;
    AutomationScope scope = AutomationScope::Track;
    bool enabled = true;
    bool muted = false;
    AutomationWriteMode writeMode = AutomationWriteMode::Read;
    std::vector<AutomationPoint> points;
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
    RegionPlayback playback;
    std::vector<AutomationLane> automationLanes;
};

struct TimeSignature {
    int numerator = 4;
    int denominator = 4;
};

struct MidiNote {
    uint64_t id = 0;              // Unique note ID
    uint8_t pitch = 60;           // 0-127 (60 = C4)
    double startBeats = 0.0;      // Beat offset relative to region start
    double durationBeats = 1.0;   // Note duration in musical beats
    float velocity = 0.8f;        // Normalized 0.0 - 1.0
    float releaseVelocity = 0.5f; // Normalized 0.0 - 1.0
    float probability = 1.0f;     // 0.0 - 1.0
    int8_t pan = -1;              // -1 = unassigned/default, 0-127 MIDI 2.0 per-note pan
    int8_t tuningOffsetCents = 0; // -100 to +100 cents detune
    bool muted = false;
};

// A MIDI region containing notes placed on a track. Ids are UUIDv7.
struct MidiRegion {
    std::string id;
    std::string trackId;          // References TrackDef.id
    std::string name;
    double startBeats = 0.0;      // Song-local start position in beats
    double durationBeats = 16.0;  // Total region span in beats
    double clipOffsetBeats = 0.0; // Offset into internal note loop
    bool loop = false;
    double loopLengthBeats = 16.0;
    bool muted = false;
    std::string color = "#3b82f6";
    std::vector<MidiNote> notes;  // Note container, sorted by startBeats
    std::vector<AutomationLane> automationLanes;
};

struct TempoPoint {
    double beat = 0.0;
    double bpm = 120.0;
    double timeSeconds = 0.0;
    double curve = 0.0;           // 0 = step, >0 = linear BPM ramp to next point
};

struct SignaturePoint {
    double beat = 0.0;
    int numerator = 4;
    int denominator = 4;
    int bar = 1;                  // 1-based bar number
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
    // Where the song ENDS, in song-local seconds -- the Logic-style project
    // end marker, per song because a setlist has many.
    //
    // 0 means "derive it from the content" (the longest region / furthest
    // event), which is what every project did before this field existed and
    // what a freshly imported song still wants. Any positive value is an
    // authored decision and wins over the content: that is the whole point --
    // a song with one 8-bar loop can be four minutes long, and an empty song
    // can have a length at all, which is what made an empty timeline
    // impossible to work in.
    //
    // Seconds, not PPQN ticks: every other time in this schema is seconds
    // (regions, events, cues, the cycle), and one field in a different unit
    // would need converting at every boundary it crosses. Tempo-relative
    // behaviour is a separate change to make deliberately, everywhere at once.
    double endSeconds = 0.0;
    std::vector<Region> regions;
    std::vector<MidiRegion> midiRegions;
    std::vector<AutomationLane> automationLanes;
    std::vector<TempoPoint> tempoPoints;
    std::vector<SignaturePoint> signaturePoints;
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
