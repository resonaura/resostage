// Mirrors WebServer::buildStateJson() in app/web/WebServer.cpp exactly --
// keep these two in sync by hand (there's no shared schema generator yet).

export interface SongRow {
  name: string;
  bpm: number;
  mode: "auto" | "wait";
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
