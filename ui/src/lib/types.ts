// Mirrors WebServer::buildStateJson() in app/web/WebServer.cpp exactly --
// keep these two in sync by hand (there's no shared schema generator yet).

export type EventTypeWire =
  | "programChange"
  | "cc"
  | "noteOn"
  | "noteOff"
  | "http"
  | "dmx";

export interface SongTrackRow {
  id: string;
  name: string;
  busId: string;
  file: string;
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  sendsCount: number;
}

export interface SongEventRow {
  id: string;
  type: EventTypeWire;
  timeSeconds: number;
  triggerOnLoad: boolean;
  latencyMs: number;
  midiChannel: number;
  midiProgram: number;
  midiCC: number;
  midiCCValue: number;
  midiNote: number;
  midiVelocity: number;
  httpUrl: string;
}

export interface ClickSendRow {
  busId: string;
  gainDb: number;
  enabled: boolean;
}

export interface RegionRow {
  id: string;
  trackId: string;
  file: string;
  startSeconds: number;
  sourceOffsetSeconds: number;
  durationSeconds: number;
  gainDb: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  /** Fade curvature [-1, 1]: 0 linear, + ease-out, − ease-in. */
  fadeInCurve?: number;
  fadeOutCurve?: number;
  /** When true, source content repeats to fill durationSeconds. */
  loop?: boolean;
  loopLengthSeconds?: number;
}

// Structural marker (Intro/Verse/Chorus/Bridge/Outro/Solo/custom). A point,
// not a range -- the region a marker covers is implicitly "from here to the
// next marker (or song end)".
export interface SectionRow {
  id: string;
  name: string;
  startSeconds: number;
  colorIndex: number;
}

// A single light cue block placed on a song's Light timeline -- mirrors
// SectionRow above. Color is fixed for the cue's span; fadeIn/fadeOut ramp
// intensity only (see engine/lighting/LightCueInterpolation.h).
export interface LightCueRow {
  id: string;
  trackId: string;
  startSeconds: number;
  durationSeconds: number;
  colorR: number; // 0-255
  colorG: number;
  colorB: number;
  intensity: number; // 0-1
  fadeInSeconds: number;
  fadeOutSeconds: number;
  label: string;
  // Audio-reactive effect -- mirrors LightCue's own fields in
  // ProjectSchema.h exactly (persisted, resolved by LightEngine AND
  // MainComponent's WebUiState push through the same
  // engine/lighting/LightOutputResolver.h call -- see lightOutput below).
  effectType: "none" | "meter" | "strobe" | "pulse" | "ripple" | "converge" | "gradientflow" | "chase" | "helix" | "plasma" | "twinkle" | "sonicboom" | "fire" | "bouncing" | "drip" | "fireworks" | "colorwaves" | "strobeswipe" | "vupeak" | "geq" | "blurz" | "scanner" | "lightning" | "barberpole" | "";
  effectSourceType: "bus" | "track" | "";
  effectSourceId: string;
  effectIntensity: number; // 0-1 depth of the effect
  tempoSync: boolean;
  tempoSubdiv: string; // "2"|"1"|"1/2"|"1/3"|"1/4"|"1/6"|"1/8"|"1/16"|"1/32"|"1/64"
  effectRateHz: number; // used when tempoSync is false
  gradientPreset: "solid" | "greenYellowRed" | "custom" | "vulcanFire" | "toxicFire" | "cryoFire" | "cyberpunkFire" | "";
  gradientColors?: string;
  // How this cue composites onto another track's simultaneously-active cue
  // on the same fixture (base/accent layering) -- see LightBlend.h. No
  // effect unless the fixture is driven by more than one LightTrack.
  blendMode?: "normal" | "additive" | "multiply" | "difference" | "lighten" | "subtractive" | "";
}

export interface SongRow {
  name: string;
  bpm: number;
  mode: "auto" | "wait";
  tsNum: number;
  tsDen: number;
  click: boolean;
  clickBusId: string;
  clickGainDb?: number;
  clickSends: ClickSendRow[];
  tracks: SongTrackRow[];
  regions?: RegionRow[];
  events: SongEventRow[];
  sections?: SectionRow[];
  lightCues?: LightCueRow[];
}

export interface MeterRow {
  id: string;
  peakDb: number;
  peakDbL?: number;
  peakDbR?: number;
  shortTermLufs: number;
}

export interface TrackSendRow {
  busId: string;
  gainDb: number;
}

export interface TrackRow {
  id: string;
  name: string;
  busId: string;
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Force mono sum of the stem before pan/sends. */
  mono?: boolean;
  sends: TrackSendRow[];
  peakDb: number;
  peakDbL?: number;
  peakDbR?: number;
}

export interface BusRow {
  id: string;
  name: string;
  gainDb: number;
  mute: boolean;
  solo: boolean;
  isAux: boolean;
  startChannel: number;
  channels: number;
  peakDb: number;
  peakDbL?: number;
  peakDbR?: number;
}

// One physical light fixture -- project-level roster entry, mirrors
// TrackRow's relationship to SongTrackRow (fixtures are patched once here;
// LightTrackRow groups fixtures for a Light-timeline row to drive in unison).
export interface LightFixtureRow {
  id: string;
  name: string;
  kind: "resoLightBar" | "dmxGeneric";
  gridColumn: number;
  gridRow: number;
  ledCount: number;
  addressable: boolean;
  posX: number;
  posY: number;
  posZ: number;
  /** Yaw around the vertical axis -- independent of mountedHorizontally. */
  rotationYDeg: number;
  /** false = standing upright, true = laid on its side (e.g. a truss bar). */
  mountedHorizontally: boolean;
  dmxUniverse: number;
  dmxStartChannel: number;
  dmxChannelCount: number;
  /** Cosmetic-only (3D stage mesh) -- see ui/src/lib/dmxProfiles.ts. */
  shape: "bar" | "strip" | "ring" | "matrix" | "par" | "wash" | "spot" | "movingHead";
  /** Only meaningful when shape === "matrix" -- 0 = let the UI pick a default. */
  matrixCols: number;
  /** Cosmetic-only (sets dmxChannelCount + channel-role labels in the UI). */
  channelProfile: "dimmer" | "rgb" | "rgbw" | "rgbwa" | "custom";
  /** Cosmetic aim/pitch off vertical (3D stage only) -- 0 = straight up. */
  tiltDeg: number;
  /** DMX send rate override for this fixture's universe, in Hz. 0 = inherit LightingState.defaultRefreshRateHz. */
  refreshRateHz: number;
}

export interface LightingState {
  enabled: boolean;
  kind: "none" | "resoLight" | "dmxGeneric";
  resoLightColumns: number;
  resoLightRows: number;
  /** What every fixture shows while the transport is stopped. */
  idleBehavior: "holdLast" | "blackout" | "staticColor" | "effect";
  idleColorR: number;
  idleColorG: number;
  idleColorB: number;
  idleIntensity: number;
  /** Effect run while stopped when idleBehavior === "effect". */
  idleEffectType: string;
  /** Animation rate (Hz) of the stopped-stopped effect. */
  idleEffectRateHz: number;
  /** Default DMX send rate (Hz) for fixtures that don't set their own refreshRateHz. */
  defaultRefreshRateHz: number;
  fixtures: LightFixtureRow[];
}

export interface LightTrackRow {
  id: string;
  name: string;
  fixtureIds: string[];
}

export interface ProcessHealthEntry {
  pid: number;
  name: string;
  rssBytes: number;
  cpuPercent: number;
}

export interface HealthState {
  cpuPercent: number;
  rssBytes: number;
  freeBytes: number;
  underrunCount: number;
  audioCallbackCount: number;
  webClientCount: number;
  processes: ProcessHealthEntry[];
}

export interface KeybindingRow {
  action: string;
  key: string;
}

export interface MidiBindingRow {
  action: string;
  /** "note" | "cc" | "" when unbound */
  trigger: string;
  channel: number;
  number: number;
}

export interface RecentProjectEntry {
  path: string;
  displayName: string;
  /** ISO-8601 timestamp of the most recent load/save. */
  lastOpenedIso: string;
}

export interface SettingsState {
  currentOutputDevice: string;
  outputDevices: string[];
  sampleRate: number;
  availableSampleRates: number[];
  bufferSize: number;
  availableBufferSizes: number[];
  outputChannelNames: string[];
  activeOutputChannels: boolean[];
  midiOutputs: string[];
  midiInputs: string[];
  /** Whether the "ResoStage Sync" virtual MIDI source is enabled (see settings.setMidiVirtualPort). */
  virtualMidiPortEnabled: boolean;
  keybindings: KeybindingRow[];
  midiBindings?: MidiBindingRow[];
  /** Non-empty while MIDI-learn is armed for this action. */
  midiLearnAction?: string;
  /** Rig-wide MRU project list, most-recent-first, always shipped (used by the always-visible ProjectMenu). */
  recentProjects: RecentProjectEntry[];
}

// One pyramid level of a track's peak overview -- parallel arrays (not
// array-of-objects) to keep JSON parse cost down for the coarser/whole-file
// levels. samplesPerBin lets the renderer pick the level closest to the
// current samples-per-pixel without the server needing to know the zoom.
export interface PeakLevelData {
  samplesPerBin: number;
  min: number[];
  max: number[];
  rms: number[];
}

export interface TrackPeaks {
  id: string;
  durationSeconds: number;
  levels: PeakLevelData[];
}

export interface PeaksResponse {
  tracks: TrackPeaks[];
}

// Peak data for every song's tracks (not just the currently-staged one) --
// see AudioEngine::ensureAllSongPeaksBuilt()/MainComponent::buildAllPeaksJson().
// Powers the continuous multi-song Timeline view.
export interface AllPeaksResponse {
  songs: { tracks: TrackPeaks[] }[];
}

export interface WebUiState {
  projectName: string;
  /** Project-global metronome level (dB). */
  clickGainDb: number;
  /** Project-global metronome pan (-1..+1). */
  clickPan?: number;
  /** Metronome solo -- joins the same solo group as track solo. */
  clickSolo?: boolean;
  /** Metronome-only peak (not the bus it routes into). */
  clickPeakDb?: number;
  clickPeakDbL?: number;
  clickPeakDbR?: number;
  /** Stream feeder: min ring buffer seconds (non-resident stems). */
  streamBufferMinSec?: number;
  streamBufferAvgSec?: number;
  streamResidentTracks?: number;
  streamStreamingTracks?: number;
  streamBufferUrgent?: boolean;
  streamResidentMiB?: number;
  songName: string;
  playheadSeconds: number;
  /** Cumulative whole-project position (does not reset at song boundaries). */
  globalPlayheadSeconds: number;
  globalBeatsElapsed: number;
  sampleRate: number;
  drift: number;
  bpm: number;
  playing: boolean;
  hardwareAlarm: boolean;
  /**
   * Action id last executed via native hotkey, MIDI, or the macOS menu bar
   * (all three funnel through MainComponent::performAction). Paired with
   * lastActionNonce (bumped every firing, including repeats of the same
   * action) so SettingsScreen can flash only the matching binding row.
   */
  lastAction: string;
  lastActionNonce: number;
  /** Backend's actual current WS send rate for this connection (adaptive, see WebServer.cpp). */
  wsHz: number;
  songIndex: number;
  songCount: number;
  statusMessage: string;
  busy: boolean;
  /** True while the native app is waiting on a Save/Don't Save/Cancel answer before quitting. */
  quitConfirmPending: boolean;
  /**
   * Mode-switch request from keyboard/MIDI (`player`/`mixer`/`editor`/`settings`).
   * `uiTabSeq` increments on every request so re-selecting the active tab still applies.
   */
  uiTab?: string;
  uiTabSeq?: number;
  /** Timeline undo/redo availability + a human label for the step that would be applied. */
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  songs: SongRow[];
  meters: MeterRow[];
  tracks: TrackRow[];
  busses: BusRow[];
  /** Project-scoped lighting rig config -- see Settings' "Project" card. Always shipped (tiny). */
  lighting: LightingState;
  lightTracks: LightTrackRow[];
  health: HealthState;
  settings: SettingsState;
}

export const emptyState: WebUiState = {
  projectName: "",
  clickGainDb: -6,
  clickPan: 0,
  clickSolo: false,
  clickPeakDb: -100,
  clickPeakDbL: -100,
  clickPeakDbR: -100,
  streamBufferMinSec: 0,
  streamBufferAvgSec: 0,
  streamResidentTracks: 0,
  streamStreamingTracks: 0,
  streamBufferUrgent: false,
  streamResidentMiB: 0,
  songName: "",
  playheadSeconds: 0,
  globalPlayheadSeconds: 0,
  globalBeatsElapsed: 0,
  sampleRate: 48000,
  drift: 1,
  bpm: 0,
  playing: false,
  hardwareAlarm: false,
  lastAction: "",
  lastActionNonce: 0,
  wsHz: 0,
  songIndex: -1,
  songCount: 0,
  statusMessage: "",
  busy: false,
  quitConfirmPending: false,
  uiTab: "",
  uiTabSeq: 0,
  canUndo: false,
  canRedo: false,
  undoLabel: "",
  redoLabel: "",
  songs: [],
  meters: [],
  tracks: [],
  busses: [],
  lighting: {
    enabled: false,
    kind: "none",
    resoLightColumns: 2,
    resoLightRows: 1,
    idleBehavior: "holdLast",
    idleColorR: 0,
    idleColorG: 0,
    idleColorB: 0,
    idleIntensity: 1,
    idleEffectType: "none",
    idleEffectRateHz: 2,
    defaultRefreshRateHz: 44,
    fixtures: [],
  },
  lightTracks: [],
  health: {
    cpuPercent: 0,
    rssBytes: 0,
    freeBytes: 0,
    underrunCount: 0,
    audioCallbackCount: 0,
    webClientCount: 0,
    processes: [],
  },
  settings: {
    currentOutputDevice: "",
    outputDevices: [],
    sampleRate: 0,
    availableSampleRates: [],
    bufferSize: 0,
    availableBufferSizes: [],
    outputChannelNames: [],
    activeOutputChannels: [],
    midiOutputs: [],
    midiInputs: [],
    virtualMidiPortEnabled: false,
    keybindings: [],
    midiBindings: [],
    midiLearnAction: "",
    recentProjects: [],
  },
};
