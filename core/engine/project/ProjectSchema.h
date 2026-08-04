#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace resostage {

// One aux send from a track into an Aux bus (post-fader by default).
// Multiple sends let a stem feed FOH + drummer monitor + guitarist mono, etc.
struct TrackSendDef {
    std::string busId;     // must reference a BusDef with isAux == true (or any bus)
    double gainDb = 0.0;   // send level relative to unity
    bool preFader = false; // if true, ignores track fader/mute (still respects solo)
    bool enabled = true;
};

// An audio clip placed on a global track for a specific song.
struct Region {
    std::string id;
    std::string trackId; // references a TrackDef.id in Project::tracks
    std::string file;    // archive path, e.g. "Audio/song1_synths1.wav"
    double startSeconds = 0.0;        // position within the song timeline
    double sourceOffsetSeconds = 0.0; // start offset into source audio file
    double durationSeconds = 0.0;     // clip duration in seconds (0 = full file)
    double gainDb = 0.0;
    double fadeInSeconds = 0.0;
    double fadeOutSeconds = 0.0;
    // Fade curvature in [-1, +1]: 0 = linear. Positive = ease-out (fast
    // attack / more area late), negative = ease-in (slow attack). Applied
    // as pow(t, 2^(-curve*2)) so the UI drag direction matches DAW feel.
    double fadeInCurve = 0.0;
    double fadeOutCurve = 0.0;
    // When true, source audio from sourceOffset..(source end) is repeated
    // to fill durationSeconds on the timeline (clip may be longer than the
    // remaining source material). When false, timeline duration is clamped
    // to the remaining source length and silence fills any overrun.
    bool loop = false;
    double loopLengthSeconds = 0.0; // 0 = remaining source material from sourceOffset
};

struct TrackDef {
    std::string id;
    std::string name;
    std::string busId; // main (FOH) bus assignment
    double gainDb = 0.0;
    double pan = 0.0; // -1..+1
    bool mute = false;
    bool solo = false; // if any track is soloed, non-solo tracks are silenced
    // Force mono: stereo regions are summed L+R → mono before pan/send.
    bool mono = false;
    std::vector<TrackSendDef> sends; // aux matrix rows for this track
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

// One physical light fixture in the rig -- project-level roster entry,
// mirrors TrackDef's relationship to Region (fixtures are patched once here;
// LightCue placements on a song's timeline reference a LightTrack, which in
// turn references one or more fixtures it drives in unison).
struct LightFixture {
    std::string id;
    std::string name;
    enum class Kind {
        // ResoStage's own product: a vertical LED bar, positioned in 3D via
        // the settings-card editor. See RESTORE_POINT.md Feature 6.
        ResoLightBar,
        // Any third-party DMX/Art-Net fixture: a flat channel range, no
        // fixture personality/profile system in Phase A (see RESTORE_POINT.md's
        // "explicitly deferred" list) -- just enough to place cues that fire
        // through the existing ArtNetPacket/EventDispatcher transport.
        DmxGeneric,
    };
    Kind kind = Kind::ResoLightBar;

    // ResoLightBar fields. Nominal position comes from (gridColumn, gridRow)
    // when the rig is first sized in the settings card; (posX, posY, posZ)
    // is the real placement the user drags to in the 3D editor and is what
    // actually drives rendering -- grid indices are not re-derived from it.
    int gridColumn = 0;
    int gridRow = 0;
    int ledCount = 120;
    // true = every LED individually addressable (3 DMX channels each);
    // false = one RGB triplet drives the whole bar uniformly.
    bool addressable = true;
    double posX = 0.0;
    double posY = 0.0;
    double posZ = 0.0;
    // Yaw around the vertical (world Y) axis -- which way the bar's face
    // points. Independent of `mountedHorizontally`: a bar mounted flat can
    // still yaw to point in any direction along the ground.
    double rotationYDeg = 0.0;
    // false = standing upright (the common case); true = laid on its side
    // (e.g. a horizontal truss bar). A physically distinct mount, not a
    // rotation value -- do not encode this as a magic rotationYDeg instead.
    bool mountedHorizontally = false;

    // DmxGeneric fields.
    int dmxUniverse = 0;
    int dmxStartChannel = 1; // 1-based
    int dmxChannelCount = 3;
    // Purely cosmetic/informational for DmxGeneric fixtures -- neither
    // field feeds resolveLightOutputs/writeDmxChannels (a fixture's actual
    // wire behavior is entirely a function of addressable/ledCount and the
    // resolved cue value). `shape` picks the 3D stage's mesh so a rig
    // reads as a mix of real fixture types instead of every DMX fixture
    // rendering as a generic bar; `channelProfile` is a named preset the
    // web UI uses to set dmxChannelCount and label each channel's role
    // (e.g. "Ch1 Dimmer, Ch2 R, ...") -- purely a data-entry convenience,
    // not consulted by the engine. See ui/src/lib/dmxProfiles.ts for the
    // canonical profile -> channel-count/role table.
    // `shape` also applies to ResoLightBar fixtures, not just DmxGeneric --
    // "bar" is the ResoLightBar default (a vertical addressable tube);
    // "strip"/"ring"/"matrix" rearrange the SAME linear ledCount LEDs into a
    // different physical layout (flat tape / horizontal ring / grid panel),
    // purely a 3D position transform in ui/src/components/light/
    // ResoLightStage3D.tsx -- the addressing model stays one linear array
    // either way, resolveLedWireColors doesn't know or care how the 3D
    // stage arranges the LEDs it hands back. "par"/"wash"/"spot"/
    // "movingHead" only make sense for DmxGeneric (a single non-addressable
    // point has nothing to rearrange). See ui/src/lib/dmxProfiles.ts for
    // the shape catalogue split by kind.
    std::string shape = "bar";          // "bar" | "strip" | "ring" | "matrix" | "par" | "wash" | "spot" | "movingHead"
    // Only meaningful when shape == "matrix" -- how many columns the linear
    // LED array wraps into (rows = ceil(ledCount / matrixCols)). 0 means
    // "let the UI pick a default (roughly sqrt(ledCount))". Cosmetic only,
    // like shape itself.
    int matrixCols = 0;
    std::string channelProfile = "rgb"; // "dimmer" | "rgb" | "rgbw" | "rgbwa" | "custom" -- see ui/src/lib/dmxProfiles.ts for why leading-channel personalities (Dimmer+RGB, Pan/Tilt+...) aren't offered
    // Cosmetic pitch (3D stage only, like the pair above) -- a real moving
    // head/PAR/spot is aimed at an angle off vertical via its yoke bracket,
    // not standing bolt upright like a ResoLightBar; this is that aim
    // angle. 0 = straight up. Not consulted by the engine.
    double tiltDeg = 0.0;
    // DMX output refresh rate for THIS fixture, in Hz. 0 means "inherit
    // LightingConfig::defaultRefreshRateHz". Unlike shape/channelProfile/
    // tiltDeg above, this DOES reach the real output path: LightEngine
    // throttles how often it actually sends a universe's frame (see
    // LightEngine.cpp's threadLoop), using the SLOWEST rate among every
    // fixture patched into that universe -- a universe is one shared wire,
    // so it can only go out at one rate, and the slowest configured
    // fixture is the one a faster rate could actually hurt (flicker/
    // dropped frames on older or glitchy gear). Applies to both fixture
    // kinds; a real DMX fixture can be just as rate-sensitive as a
    // ResoLight bar.
    double refreshRateHz = 0.0;
};

enum class LightingKind {
    None,
    ResoLight,
    DmxGeneric,
};

// Project-scoped (not rig-wide AppSettings -- this is per-show data, see
// RESTORE_POINT.md Feature 6). Lives on Project, edited from Settings'
// "Project" card. Disabled by default: an audio-only rig should see nothing
// new anywhere in the UI.
struct LightingConfig {
    bool enabled = false;
    LightingKind kind = LightingKind::None;
    // Nominal ResoLight rig size (columns x rows of vertical bars) used to
    // seed `fixtures` with a default layout; editing fixture count/position
    // afterward doesn't retroactively resize this, it's a seed, not a
    // constraint.
    int resoLightColumns = 2;
    int resoLightRows = 1;
    std::vector<LightFixture> fixtures;

    // What every fixture should show while the transport is stopped (not
    // just between cues mid-song -- see MasterClock::isRunning()/
    // AudioEngine::isPlaying()). "holdLast" is the original behavior: the
    // rig keeps showing whatever the frozen playhead position resolves to,
    // same as before this setting existed. "blackout" forces every fixture
    // off; "staticColor" forces every fixture to idleColorR/G/B at
    // idleIntensity -- e.g. a house-color wash between songs instead of
    // whatever the last cue happened to leave lit; "effect" runs a
    // rhythm-independent effect (idleEffectType, e.g. Strobe/Chase/Plasma)
    // over the whole rig at idleEffectRateHz, with idleColorR/G/B as the
    // effect's base color -- the effect keeps animating off wall-clock time
    // even though the transport is stopped. See LightOutputResolver.h's
    // buildIdleTarget, the single place both LightEngine's real DMX output
    // and the web preview apply this.
    std::string idleBehavior = "holdLast"; // "holdLast" | "blackout" | "staticColor" | "effect"
    uint8_t idleColorR = 0;
    uint8_t idleColorG = 0;
    uint8_t idleColorB = 0;
    double idleIntensity = 1.0;
    // Effect run by idleBehavior "effect" (see parseEffectType's string
    // catalog). Audio-driven effects (Meter/VuPeak/Geq/Blurz) are excluded:
    // with the transport stopped there is no running audio to drive them.
    std::string idleEffectType = "none";
    double idleEffectRateHz = 2.0;
    // Gradient palette for idle effects that have their own color (Fire,
    // Fireworks, ColorWaves, Plasma, Helix, GradientFlow, Barberpole -- i.e.
    // effects that ignore the base R/G/B and draw from a built-in palette).
    // Same values as LightCue::gradientPreset; "solid" means use idleColorR/G/B.
    std::string idleGradientPreset = "solid";
    // Custom gradient stops (CSV #RRGGBB, same format as LightCue::gradientColors).
    // Only consulted when idleGradientPreset == "custom".
    std::string idleGradientColors;

    // Default DMX output refresh rate (Hz) for every fixture that doesn't
    // set its own LightFixture::refreshRateHz override. 44 Hz matches
    // LightEngine's original hardcoded rate exactly, so a project that
    // never touches this setting behaves identically to before it existed.
    double defaultRefreshRateHz = 44.0;
};

// A named row on the Light timeline -- project-level roster, mirrors
// TrackDef/Region's relationship (LightCue placements below reference this
// by id, the same way Region::trackId references TrackDef::id).
struct LightTrack {
    std::string id;
    std::string name;
    std::vector<std::string> fixtureIds; // LightFixture.id refs, driven in unison
};

// A single light cue block placed on a song's Light timeline. Color is
// fixed for the cue's whole span; fadeIn/fadeOut ramp INTENSITY only (color
// snaps to full value at t=0, matching how a dimmer fade normally works on
// a lighting console -- see engine/lighting/LightCueInterpolation.h for the
// exact envelope math and Phase A's simplifications).
struct LightCue {
    std::string id;
    std::string trackId; // references LightTrack.id
    double startSeconds = 0.0;
    double durationSeconds = 1.0;
    uint8_t colorR = 255;
    uint8_t colorG = 255;
    uint8_t colorB = 255;
    double intensity = 1.0; // 0..1, the cue's own held-region intensity
    double fadeInSeconds = 0.0;
    double fadeOutSeconds = 0.0;
    std::string label;

    // Audio-reactive effect. Resolved by engine/lighting/LightOutputResolver.h,
    // called from BOTH LightEngine's real-time DMX thread and MainComponent's
    // ~30Hz WebUiState push -- one resolution function, so the live preview
    // the user sees can never show something the real hardware isn't also
    // doing. "none" | "meter" | "strobe" | "pulse" | "ripple"
    std::string effectType;
    // "bus" | "track" -- which meter pool effectSourceId is looked up in.
    std::string effectSourceType = "bus";
    // Id of the bus or track to read audio level from ("" = master mix /
    // first bus, only meaningful when effectSourceType == "bus").
    std::string effectSourceId;
    float effectIntensity = 0.8f;  // 0..1 depth of the effect
    // Rate control: either direct Hz or tempo-synced subdivision.
    bool  tempoSync    = false;
    // tempoSync=true: "2"|"1"|"1/2"|"1/3"|"1/4"|"1/6"|"1/8"|"1/16"|"1/32"|"1/64"
    std::string tempoSubdiv = "1/4";
    float effectRateHz = 2.0f;     // used when tempoSync=false

    // Meter effect only, addressable fixtures only: how the lit LEDs (bottom
    // -> up, progressive fill, like a real VU meter) are colored.
    // "solid" = the cue's own colorR/G/B for every lit LED.
    // "greenYellowRed" = classic VU coloring by position, ignores colorR/G/B.
    std::string gradientPreset = "solid";
    // Optional user palette, two or more CSS-style #RRGGBB stops separated
    // by commas. Empty means the selected built-in preset.
    std::string gradientColors;

    // How this cue composites onto whatever's already resolved for a
    // fixture this frame from OTHER tracks driving the same fixture
    // simultaneously (base/accent layering -- see LightBlend.h). Only
    // matters when a LightFixture is listed in more than one LightTrack's
    // fixtureIds; a fixture driven by a single track (the common case)
    // ignores this entirely. "normal" | "additive" | "multiply" |
    // "difference" | "lighten" | "subtractive".
    std::string blendMode = "normal";
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
    std::vector<Region> regions;
    std::vector<TimelineEvent> events;
    std::vector<SongSection> sections;
    std::vector<LightCue> lightCues;

    // Legacy per-song click fields -- kept only for load migration from older
    // archives. Live routing and new saves use Project::builtInClick* below
    // (metronome is project-global, same for every song).
    bool builtInClickEnabled = false;
    std::string builtInClickBusId;
    double builtInClickGainDb = -6.0;
    std::vector<TrackSendDef> builtInClickSends;
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
    // ── Project-global metronome (ClickGenerator). Same for every song. ──
    // On/off, main bus, aux sends, gain, pan, solo all live here -- not on
    // SongDef (legacy song fields are load-only migration).
    bool builtInClickEnabled = false;
    // Empty = Sends Only (no main target bus).
    std::string builtInClickBusId;
    // Aux monitor mixes the click is also mixed into.
    std::vector<TrackSendDef> builtInClickSends;
    double builtInClickGainDb = -6.0;
    // Project-global metronome pan (-1..+1).
    double builtInClickPan = 0.0;
    // Soloing the metronome joins the same solo group as TrackDef::solo --
    // when true, every regular track is silenced exactly as if one of them
    // (rather than the click) had solo engaged. See AudioEngine::
    // publishRoutingSnapshot()'s anyTrackSolo.
    bool builtInClickSolo = false;
    std::vector<BusDef> busses;
    std::vector<TrackDef> tracks;
    std::vector<SongDef> songs;
    KeyBindingMap keybindings;
    std::vector<MidiMapping> midiMappings;
    LightingConfig lighting;
    std::vector<LightTrack> lightTracks;
};

} // namespace resostage
