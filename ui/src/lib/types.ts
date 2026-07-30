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
  /** Monotonically incremented on every native keyDown (settings dot indicator). */
  keyStrokeNonce: number;
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
  keyStrokeNonce: 0,
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
  },
};
