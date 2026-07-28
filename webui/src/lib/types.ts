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
}

export interface MeterRow {
  id: string;
  peakDb: number;
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
  sends: TrackSendRow[];
  peakDb: number;
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
  keybindings: KeybindingRow[];
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
  songIndex: number;
  songCount: number;
  statusMessage: string;
  busy: boolean;
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
  songName: "",
  playheadSeconds: 0,
  globalPlayheadSeconds: 0,
  globalBeatsElapsed: 0,
  sampleRate: 48000,
  drift: 1,
  bpm: 0,
  playing: false,
  hardwareAlarm: false,
  songIndex: -1,
  songCount: 0,
  statusMessage: "",
  busy: false,
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
    keybindings: [],
  },
};
