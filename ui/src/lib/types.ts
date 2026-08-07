// Mirrors WebServer::buildStateJson() in app/web/WebServer.cpp exactly --
// keep these two in sync by hand (there's no shared schema generator yet).
//
// The wire contract mirrors the on-disk project format's canonical nested keys
// (see core/engine/project/ProjectJson.cpp's project_json_wire DTOs). Send
// levels are the schema's 0-100 LINEAR percent (100 == unity / 0 dB), NOT dB
// values -- see sendLevelToDb/sendDbToLevel on the C++ side.

export type EventTypeWire =
  | "programChange"
  | "cc"
  | "noteOn"
  | "noteOff"
  | "http"
  | "dmx";

/** One aux send from a track/click into a send bus. level is 0-100 LINEAR
 *  percent (100 = unity/0 dB). */
export interface SendConfig {
  bus: string;
  level: number;
  preFader?: boolean;
  enabled?: boolean;
}

/** A track/click source output: main route + aux sends ("main" only ever
 *  means Master; there are no stereo-pair bus objects -- aside from the
 *  send bus css all send buses are per-momo-lane). */
export interface SourceOutput {
  type: "main" | "sends-only" | "ext-out";
  /** null unless type === "ext-out"; a stereo target is a pair of mono
   *  channels joined with a comma. */
  target?: string | null;
  sends: SendConfig[];
}

/**
 * Solo is always scoped to a group, decided engine-side (see SoloGroup in
 * core/engine/audio/MixGraph.h): tracks and the metronome share one, the aux
 * sends have their own, the master is alone in its own. Shipped per row so
 * the mixer greys out exactly the strips the engine is silencing instead of
 * re-deriving the rule here.
 */
export type SoloGroup = "sources" | "sends" | "main" | "none";

export interface Click {
  enabled: boolean;
  name: string;
  /** 1 = mono (force L=R, ignore pan), 2 = stereo. */
  channels: number;
  gainDb: number;
  pan: number;
  mute: boolean;
  /** Joins the same solo group as a TrackDef. */
  solo: boolean;
  soloGroup: SoloGroup;
  soloActiveInGroup: boolean;
  /** Click output -- type is main or sends-only, never ext-out. */
  output: SourceOutput;
}

export interface SongTrackRow {
  id: string;
  name: string;
  /** Route target as a flat legacy string ("" = Sends Only, "audio::main" =
   *  Main, else an ext-out target). Kept for back-compat reads. */
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

/** Per-song flat click mirror (back-compat for SPA code reading song.click). */
/** One aux send row as the send controls consume it. `level` is the schema's
 *  own 0-100 LINEAR percent (100 = unity / 0 dB) -- deliberately NOT dB, so
 *  "set to 0%" and "set to 100%" land on exactly 0 and exactly 100 instead of
 *  whatever a dB round trip happens to produce. */
export interface ClickSendRow {
  busId: string;
  level: number;
  enabled: boolean;
}

export interface RegionSource {
  file: string;
  offsetSeconds: number;
}

export interface RegionFade {
  /** Curvature [-1, 1]: 0 linear, + ease-out, − ease-in. */
  inCurve?: number;
  outCurve?: number;
  inSeconds: number;
  outSeconds: number;
}

export interface RegionLoop {
  /** When true, source content repeats to fill durationSeconds. */
  enabled: boolean;
  /** 0 = remaining source material. */
  lengthSeconds?: number;
}

export interface RegionRow {
  id: string;
  trackId: string;
  startSeconds: number;
  durationSeconds: number;
  gainDb: number;
  source: RegionSource;
  /** View-scoped: absent unless the frame conveys region detail. */
  fade?: RegionFade;
  loop?: RegionLoop;
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

export type LightEffectType =
  | "none"
  | "meter"
  | "strobe"
  | "pulse"
  | "ripple"
  | "converge"
  | "gradientflow"
  | "chase"
  | "helix"
  | "plasma"
  | "twinkle"
  | "sonicboom"
  | "fire"
  | "bouncing"
  | "drip"
  | "fireworks"
  | "colorwaves"
  | "strobeswipe"
  | "vupeak"
  | "geq"
  | "blurz"
  | "scanner"
  | "lightning"
  | "barberpole"
  | "";

export type GradientPreset =
  | "solid"
  | "greenYellowRed"
  | "custom"
  | "vulcanFire"
  | "toxicFire"
  | "cryoFire"
  | "cyberpunkFire"
  | "";

export type LightBlendMode =
  | "normal"
  | "additive"
  | "multiply"
  | "difference"
  | "lighten"
  | "subtractive"
  | "";

// A single light cue block placed on a song's Light timeline -- mirrors
// SectionRow above. Color is fixed for the cue's span; fadeIn/fadeOut ramp
// intensity only (see engine/lighting/LightCueInterpolation.h). Mirrors the
// on-disk LightCue exactly (nested color/effect/gradient/fade).
export interface LightCueRow {
  id: string;
  trackId: string;
  startSeconds: number;
  durationSeconds: number;
  color: { r: number; g: number; b: number }; // 0-255
  intensity: number; // 0-1
  fade: { inSeconds: number; outSeconds: number };
  label?: string;
  // Audio-reactive effect -- persisted, resolved by the exact same
  // engine/lighting/LightOutputResolver.h call LightEngine's real-time DMX
  // thread uses (see lightOutput below).
  effect: {
    type?: LightEffectType | null; // null = no effect
    sourceType: "bus" | "track";
    sourceId?: string | null; // null = master mix / first bus
    intensity: number; // 0-1 depth of the effect
    tempoSync: boolean;
    tempoSubdivision: string; // "2"|"1"|"1/2"|"1/3"|"1/4"|"1/6"|"1/8"|"1/16"|"1/32"|"1/64"
    rateHz: number; // used when tempoSync is false
  };
  gradient: {
    preset: GradientPreset;
    colors?: string | null; // CSV #RRGGBB stops; null/empty = preset/base color
  };
  // See LightBlend.h -- only meaningful when the fixture is driven by another
  // LightTrack active at the same instant.
  blendMode?: LightBlendMode;
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

export interface TrackRow {
  id: string;
  name: string;
  /** 1 = mono (stereo regions summed L+R before pan/sends). */
  channels: number;
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Solo group this strip belongs to, as decided by the engine. */
  soloGroup: SoloGroup;
  /** True when something in `soloGroup` is soloed -- i.e. this strip is
   *  silenced unless it is the soloed one. Draw it dimmed. */
  soloActiveInGroup: boolean;
  output: SourceOutput;
  peakDb: number;
  peakDbL?: number;
  peakDbR?: number;
}

export interface BusRow {
  id: string;
  name: string;
  gainDb: number;
  /** Balance pan on physical outs (-1..+1). Master + aux/sends. */
  pan?: number;
  mute: boolean;
  solo: boolean;
  soloGroup: SoloGroup;
  soloActiveInGroup: boolean;
  isAux: boolean;
  /** True when this is a fabricated global Direct Output bus (derived from
   *  the device's active output channels, never persisted in the project). */
  isDirectOut?: boolean;
  /** True when this direct-out lane's physical output is currently inactive
   *  (device dropped / missing channel). Routing is preserved and silent until
   *  the output returns; shown with a warning in the mixer. */
  unavailable?: boolean;
  startChannel: number;
  channels: number;
  peakDb: number;
  peakDbL?: number;
  peakDbR?: number;
}

// ── Canonical output-routing model ──────────────────────────────────────────
// The wire carries a track's route as the on-disk SourceOutput object
// (type/target/sends). This client-side discriminated Output is the layer the
// mixer UI edits on top of that. Direct egress uses 1-based mono lanes:
//   type main / sends-only → target "audio::main" or "";
//   type ext-out           → target holds 1-based mono lanes ("audio::out:3").
// There are no stereo-pair bus objects; a stereo target is a pair of mono lanes.
// See ui/src/screens/mixer/MixerScreen.tsx and directOutput.ts.

export const OutputTarget = {
  Main: "main",
  SendsOnly: "sends-only",
  ExtOut: "ext-out",
} as const;

export type OutputTarget = (typeof OutputTarget)[keyof typeof OutputTarget];

// Dynamic physical-output channel labels.
export type StereoPairChannel =
  | "1/2"
  | "3/4"
  | "5/6"
  | "7/8"
  | `${number}/${number}`;

export type MonoChannel = "1" | "2" | "3" | "4" | `${number}`;

export type ExtOutChannel = StereoPairChannel | MonoChannel;

/**
 * Send levels: a map of send-bus id -> amount mixed into that bus, in percent
 * 0..100. E.g. { "send-a": 100, "reverb": 50 }.
 */
export type SendLevels<SendId extends string = string> = Record<SendId, number>;

/** Discriminated output target, shared by project tracks / metronome. */
export type Output<SendId extends string = string> =
  | {
      target: "main";
      /** Send mix in percent (0-100). */
      sends: SendLevels<SendId>;
      extOut?: never;
    }
  | {
      target: "sends-only";
      sends: SendLevels<SendId>;
      extOut?: never;
    }
  | {
      target: "ext-out";
      sends: SendLevels<SendId>;
      extOut: ExtOutChannel;
    };

/** Master bus: only Ext. Out — sends are unavailable, "Sends Only" is invalid. */
export type MasterOutput = {
  target: "ext-out";
  sends: never;
  extOut: ExtOutChannel;
};

/** A send (aux/return) bus: can only fold to the master or an Ext. Out. */
export type SendBusOutput =
  | { target: "main"; sends: never }
  | { target: "ext-out"; sends: never; extOut: ExtOutChannel };

export function channelLabelForBus(
  startChannel: number,
  channels: number,
): ExtOutChannel {
  const a = startChannel + 1;
  return channels >= 2 ? (`${a}/${a + 1}` as StereoPairChannel) : (`${a}` as MonoChannel);
}

/** Map back from the edge of a nested SourceOutput (TS direct-output/unrecognized
 *  target strings) onto the canonical Output model. Accepts either the modern
 *  wire object or the legacy flat bus string ("" = sends-only). */
export function outputFromWire(
  output: { type?: string; target?: string | null } | undefined | null,
): Output | null {
  if (!output) return null;
  const type = output.type ?? "main";
  if (type === "sends-only") return { target: "sends-only", sends: {} };
  if (type === "ext-out") {
    const target = (output.target ?? "").trim().replace(/^audio::out:/, "");
    if (!target) return { target: "sends-only", sends: {} };
    const lanes = target.split(",").map((t) => t.trim()).filter(Boolean);
    if (lanes.length >= 2 && Number(lanes[1]) === Number(lanes[0]) + 1)
      return {
        target: "ext-out",
        sends: {},
        extOut: `${lanes[0]}/${lanes[0] + 1}` as StereoPairChannel,
      };
    return { target: "ext-out", sends: {}, extOut: `${lanes[0]}` as MonoChannel };
  }
  // main (or anything unrecognized) → main
  return { target: "main", sends: {} };
}

/** Legacy helper: a flat bus-id string ("", "audio::main", or an ext-out
 *  target) → the canonical Output model. Kept for any code still working with
 *  the flat per-song mirror fields. */
export function outputFromBus(
  busId: string,
  _busses: BusRow[],
  sends: SendLevels,
): Output {
  if (busId === "") return { target: "sends-only", sends };
  const out = outputFromWire({ type: "ext-out", target: busId });
  if (out && out.target === "ext-out") return { ...out, sends };
  return { target: "main", sends };
}

/** Flat legacy bus-id string derived from a nested SourceOutput — the exact
 *  string the old wire carried in TrackRow.busId / clickBusId ("" = Sends
 *  Only, "audio::main" = Main, otherwise the ext-out target). */
export function sourceOutputBusId(
  output: SourceOutput | null | undefined,
): string {
  if (!output) return "";
  if (output.type === "sends-only") return "";
  if (output.type === "main") return "audio::main";
  return output.target ?? "";
}

/** SendConfig.level (0..100 linear percent, 100 = unity / 0 dB) → the dB
 *  value the mixer send strips read/write. Exact mirror of
 *  ProjectJson.h sendLevelToDb(). */
export function sendLevelToDb(level: number): number {
  if (!(level > 0)) return -144;
  return 20 * Math.log10(level / 100);
}

/** The dB a send strip shows → SendConfig.level (0..100 linear percent).
 *  Exact mirror of ProjectJson.h sendDbToLevel(), including its clamp: the
 *  format cannot store a send above unity, so neither can the UI. */
export function sendDbToLevel(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(100, Math.max(0, Math.pow(10, db / 20) * 100));
}

/** Wire sends (output.sends) → the flat {busId, gainDb, enabled} rows the
 *  mixer send controls and the per-song flat click mirror consume. */
export function outputSendsToClickRows(
  output: SourceOutput | null | undefined,
): ClickSendRow[] {
  if (!output) return [];
  return (output.sends ?? []).map((s) => ({
    busId: s.bus,
    level: s.level,
    enabled: s.enabled ?? true,
  }));
}

// One physical light fixture -- project-level roster entry. Nested
// grid/position/rotation/dmx mirror the on-disk LightFixture exactly.
export interface LightFixtureRow {
  id: string;
  name: string;
  kind: "resolight::bar" | "dmx::generic";
  grid: { column: number; row: number };
  ledCount: number;
  addressable: boolean;
  position: { x: number; y: number; z: number };
  /** Yaw around the vertical axis -- independent of mountedHorizontally. */
  rotation: { y: number };
  /** false = standing upright, true = laid on its side (e.g. a truss bar). */
  mountedHorizontally: boolean;
  dmx: {
    universe: number;
    startChannel: number;
    channelCount: number;
  };
  /** Cosmetic-only (3D stage mesh) -- see ui/src/lib/dmxProfiles.ts. */
  shape:
    | "bar"
    | "strip"
    | "ring"
    | "matrix"
    | "par"
    | "wash"
    | "spot"
    | "moving-head";
  /** Only meaningful when shape === "matrix" -- 0 = let the UI pick a default. */
  matrixColumns: number;
  /** Cosmetic-only (sets dmx.const.default when it's a variable field). */
  channelProfile: "dimmer" | "rgb" | "rgbw" | "rgbwa" | "custom";
  /** Cosmetic aim/pitch off vertical (3D stage only) -- 0 = straight up. */
  tiltDegrees: number;
  /** DMX send rate override for this fixture's universe, in Hz. 0 = inherit LightingState.defaultRefreshRateHz. */
  refreshRateHz: number;
  /**
   * Real-hardware transport host (ResoLightBar only). Empty = preview-only
   * (default; no ESP board required). Set to a board's LAN IP to stream
   * live frames over WS binary via LightHardwareServer.
   */
  networkHost: string;
  /** Live: a host is configured for this fixture. */
  hwConfigured?: boolean;
  /** Live: WS link to the board is up. */
  hwConnected?: boolean;
  /** Live: last reported RSSI from the board (dBm, negative). */
  hwRssiDbm?: number;
  /** Live: "esp32" | "esp8266" | "unknown". */
  hwChipType?: string;
}

/** ESP board heard on the LAN discovery UDP beacon (not project data). */
export interface DiscoveredBoardRow {
  mac: string;
  ip: string;
  name: string;
  chipType: string;
  lastSeenSecondsAgo: number;
}

export interface LightingState {
  enabled: boolean;
  kind: "none" | "resolight" | "dmx::generic";
  /** Rig grid (only meaningful when kind === "resolight"). */
  resolight: { columns: number; rows: number };
  idle: {
    /** "hold" | "blackout" | "static" | "effect" */
    behavior: string;
    color: { r: number; g: number; b: number };
    intensity: number;
    effect: { type: string; rateHz: number };
    gradient: { preset: GradientPreset; colors?: string | null };
  };
  defaultRefreshRateHz: number;
  /** Art-Net unicast target; empty = broadcast (255.255.255.255). */
  artNetTargetHost?: string;
  fixtures: LightFixtureRow[];
  /**
   * Light-timeline rows. Nested under `lighting` (not a top-level
   * `lightTracks`) to match LightingConfig::tracks on disk -- the fixture
   * roster and the rows that drive it are one thing.
   */
  tracks: LightTrackRow[];
  /** Live ESP board monitors... */
  discoveredBoards?: DiscoveredBoardRow[];
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
  trigger: "note" | "cc" | ""; // 0 = any channel
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
  /** Whether the "AboutStage Sync" virtual MIDI source is enabled (see settings.setMidiVirtualPort). */
  virtualMidiPortEnabled: boolean;
  /** "browser" = open the SPA in the system browser (default), "electron" = Electron shell. */
  uiRenderEngine?: "browser" | "electron";
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

export interface ProjectCycleRow {
  active: boolean;
  skip: boolean;
  /** Cycle/skip-zone left edge, song-local seconds. */
  startSeconds: number;
  /** Cycle/skip-zone right edge, song-local seconds. */
  endSeconds: number;
  /** Song the locators belong to (-1 = unset). */
  songIndex: number;
}

/** @deprecated Use ProjectCycleRow */
export type SongCycleRow = ProjectCycleRow;

export interface WebUiState {
  projectName: string;
  /** Project-global metronome channel (mirrors ClickChannel; carry the routing
   *  nested exactly like a track. Null when the player/mixer view doesn't
   *  include it. */
  click?: Click;
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
   * lastActionNonce (bumped on every firing, including repeats of the same
   * action) so SettingsScreen can flash only the matching binding row.
   */
  lastAction: string;
  lastActionNonce: number;
  /** Backend's actual current WS send rate for this connection (adaptive, see WebServer.h). */
  wsHz: number;
  songIndex: number;
  songCount: number;
  statusMessage: string;
  busy: boolean;
  /** True while the native app is waiting on a Save/Don't Save/Cancel answer before quitting. */
  quitConfirmPending: boolean;
  /**
   * Mode-switch request from keyboard/MIDI (`player`/`mixer`/`editor`/`settings`).
   * `uiTabSeq` increments on every request so re-selecting the active tab still may fire.
   */
  uiTab?: string;
  uiTabSeq?: number;
  /** Timeline undo/redo availability + a human label for the step that would be applied. */
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  songs: SongRow[];
  /** Single project-wide cycle zone (not per-song). */
  cycle?: ProjectCycleRow;
  meters: MeterRow[];
  tracks: TrackRow[];
  busses: BusRow[];
  /** Project-scoped lighting rig config -- see Settings "Project" card. Always shipped (tiny). */
  lighting: LightingState;
  health: HealthState;
  settings: SettingsState;
}

export const emptyState: WebUiState = {
  projectName: "",
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
  cycle: {
    active: false,
    skip: false,
    startSeconds: 0,
    endSeconds: 4,
    songIndex: -1,
  },
  meters: [],
  tracks: [],
  busses: [],
  lighting: {
    enabled: false,
    kind: "none",
    resolight: { columns: 2, rows: 1 },
    idle: {
      behavior: "hold",
      color: { r: 0, g: 0, b: 0 },
      intensity: 1,
      effect: { type: "none", rateHz: 2 },
      gradient: { preset: "solid" },
    },
    defaultRefreshRateHz: 44,
    artNetTargetHost: "",
    fixtures: [],
    tracks: [],
    discoveredBoards: [],
  },
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