// Mirrors WebServer::buildStateJson() in app/web/WebServer.cpp exactly --
// keep these two in sync by hand (there's no shared schema generator yet).

export type EventTypeWire = "programChange" | "cc" | "noteOn" | "noteOff" | "http" | "dmx";

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

export interface SongRow {
  name: string;
  bpm: number;
  mode: "auto" | "wait";
  tsNum: number;
  tsDen: number;
  click: boolean;
  clickBusId: string;
  tracks: SongTrackRow[];
  events: SongEventRow[];
}

export interface MeterRow {
  id: string;
  peakDb: number;
  shortTermLufs: number;
}

export interface TrackRow {
  id: string;
  name: string;
  busId: string;
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  sends: number;
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

export interface HealthState {
  cpuPercent: number;
  rssBytes: number;
  freeBytes: number;
  underrunCount: number;
  audioCallbackCount: number;
  webClientCount: number;
}

export interface WebUiState {
  projectName: string;
  songName: string;
  playheadSeconds: number;
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
}

export const emptyState: WebUiState = {
  projectName: "",
  songName: "",
  playheadSeconds: 0,
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
  },
};
