import { apiUrl } from "./backend";
import type { AllPeaksResponse, EventTypeWire, PeaksResponse } from "./types";

// Mirrors WebServer::handleHttpApi().
async function post(path: string, body?: unknown): Promise<void> {
  try {
    await fetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
    });
  } catch {
    // Best-effort, matches the embedded reference client -- a dropped
    // command just means the next state frame won't reflect it and the
    // user can press again; there's nothing useful to surface here.
  }
}

export const transport = {
  play: () => post("/api/v1/transport/play"),
  stop: () => post("/api/v1/transport/stop"),
  next: () => post("/api/v1/transport/next"),
  prev: () => post("/api/v1/transport/prev"),
  select: (index: number) => post("/api/v1/transport/select", { index }),
  // Mirrors TimelineView.cpp's click/drag-to-seek (AudioEngine::
  // seekToSeconds) -- restages the song, so the caller should throttle
  // repeated calls during a drag gesture (same reason the native timeline
  // does) rather than firing on every pointermove. `songIndex` is optional:
  // pass it to seek into a *different* song in one atomic call (preserves
  // playback state), instead of a separate select() + seek() pair.
  seek: (seconds: number, songIndex?: number) =>
    post("/api/v1/transport/seek", songIndex !== undefined ? { seconds, songIndex } : { seconds }),
};

// Per-track peak-overview waveform data for the currently-staged song (see
// MainComponent::buildPeaksJson()). Not part of the live WS state -- fetch
// on demand (mount + whenever state.songIndex changes).
export async function fetchPeaks(): Promise<PeaksResponse> {
  const res = await fetch(apiUrl("/api/v1/player/peaks"));
  return (await res.json()) as PeaksResponse;
}

// Peak data for every song, powering the continuous multi-song Timeline.
// Larger/slower than fetchPeaks() (whole project, not just the staged
// song) -- fetch once on Timeline mount and poll at a slow interval rather
// than on every state tick.
export async function fetchAllPeaks(): Promise<AllPeaksResponse> {
  const res = await fetch(apiUrl("/api/v1/player/peaks-all"));
  return (await res.json()) as AllPeaksResponse;
}

export interface WaveformRawResponse {
  sampleRate: number;
  startSec: number;
  samples: number[];
}

// True per-sample window for extreme zoom-in, where even the finest cached
// pyramid level (see PeakLevelData) is coarser than one pixel. `file` is the
// region's archive-relative WAV path (RegionRow.file). Bounded to a few
// seconds server-side -- only call this for a genuinely small visible range.
const rawWaveformCache = new Map<string, WaveformRawResponse>();

export async function fetchWaveformRaw(
  file: string,
  startSec: number,
  endSec: number
): Promise<WaveformRawResponse> {
  const cacheKey = `${file}:${startSec.toFixed(2)}:${endSec.toFixed(2)}`;
  if (rawWaveformCache.has(cacheKey)) {
    return rawWaveformCache.get(cacheKey)!;
  }
  const url = apiUrl(
    `/api/v1/player/waveform-raw?file=${encodeURIComponent(file)}&start=${startSec}&end=${endSec}`
  );
  const res = await fetch(url);
  const data = (await res.json()) as WaveformRawResponse;
  if (data && data.samples) {
    rawWaveformCache.set(cacheKey, data);
  }
  return data;
}

// Mixer parity -- same calls the native MixerStrip/MixerPanel make, just
// routed from here. `index` is relative to the currently-staged song for
// track commands (matching the native convention), or the bus list for bus
// commands. See AudioEngine::setTrackGainDb et al. and
// MainComponent::drainWebCommands() for the C++ side.
export const mixer = {
  setTrackGain: (index: number, value: number) => post("/api/v1/track/gain", { index, value }),
  setTrackPan: (index: number, value: number) => post("/api/v1/track/pan", { index, value }),
  setTrackMute: (index: number, value: boolean) => post("/api/v1/track/mute", { index, value }),
  setTrackSolo: (index: number, value: boolean) => post("/api/v1/track/solo", { index, value }),
  // Bus assignment for the track's main output -- matches the MixerStrip
  // outputBusBox in the native UI. Empty busId = "(sends only)".
  setTrackBus: (index: number, busId: string) =>
    builder.trackUpdate({ index, busId }),
  setBusGain: (index: number, value: number) => post("/api/v1/bus/gain", { index, value }),
  setBusMute: (index: number, value: boolean) => post("/api/v1/bus/mute", { index, value }),
  setBusSolo: (index: number, value: boolean) => post("/api/v1/bus/solo", { index, value }),
  // Ableton-style send knob: find-or-create this track's send to busId at
  // gainDb. Matches native MixerStrip::onSendChanged -- turning a knob up
  // from its floor implicitly creates the send, no separate "add" call
  // needed. See MainComponent::setTrackSendFromJson().
  setTrackSend: (trackIndex: number, busId: string, gainDb: number) =>
    post("/api/v1/mixer/track/send", { trackIndex, busId, gainDb }),
};

// Project lifecycle. New/loadDialog/save/saveAs just ask the native app to
// do exactly what its own top-bar buttons do -- correct whether this page is
// embedded in the app's webview or not, since any native dialog they pop
// shows up in that same on-screen window (see lib/embedded.ts). upload/
// exportAndDownload are the browser-only equivalents for a client that has
// no such window: a normal <input type=file> upload, and a poll-until-ready
// then <a download> for the reverse direction (avoids ever blocking the
// server's single lws thread on the save that produces the download).
export const project = {
  new: () => post("/api/v1/project/new"),
  loadDialog: () => post("/api/v1/project/load-dialog"),
  save: () => post("/api/v1/project/save"),
  saveAs: () => post("/api/v1/project/save-as"),

  async upload(file: File): Promise<void> {
    try {
      await fetch(apiUrl("/api/v1/project/upload"), { method: "POST", body: file });
    } catch {
      // Best-effort, matches post() -- surfaced via statusMessage instead.
    }
  },

  async exportAndDownload(): Promise<void> {
    await post("/api/v1/project/export");
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        const res = await fetch(apiUrl("/api/v1/project/export-status"));
        const body = (await res.json()) as { ready: boolean; fileName: string };
        if (body.ready) {
          const link = document.createElement("a");
          link.href = apiUrl("/api/v1/project/download");
          link.download = body.fileName || "project.rsnraset";
          document.body.appendChild(link);
          link.click();
          link.remove();
          return;
        }
      } catch {
        return;
      }
    }
  },
};

// Builder structural-edit parity -- mirrors BuilderPanel.cpp's
// addItem/removeItem/moveItem/apply*Settings, one call per operation. Every
// payload is a plain JSON object forwarded byte-for-byte to
// MainComponentBuilder.cpp, which does the actual field parsing -- see
// app/web/BuilderJson.h.
export const builder = {
  // noSeed=true skips the default-track scaffolding (clone of the first
  // song's tracks, or the 8 standard names for the very first song) --
  // for callers that build their own exact track list right after (see
  // ImportStemsModal.tsx), since otherwise the seeded tracks silently
  // shift every index the caller assumes is fresh.
  songAdd: (noSeed = false) => post("/api/v1/builder/song/add", { noSeed }),
  songImportFolder: () => post("/api/v1/builder/song/import-folder"),
  songRemove: (index: number) => post("/api/v1/builder/song/remove", { index }),
  songMove: (index: number, delta: number) => post("/api/v1/builder/song/move", { index, delta }),
  songUpdate: (patch: {
    index: number;
    name: string;
    bpm: number;
    mode: "auto" | "wait";
    tsNum: number;
    tsDen: number;
    click: boolean;
    clickBusId: string;
    clickSends: { busId: string; gainDb: number; enabled: boolean }[];
  }) => post("/api/v1/builder/song/update", patch),

  trackAdd: (songIndex: number) => post("/api/v1/builder/track/add", { songIndex }),
  trackRemove: (songIndex: number, index: number) =>
    post("/api/v1/builder/track/remove", { songIndex, index }),
  trackMove: (songIndex: number, index: number, delta: number) =>
    post("/api/v1/builder/track/move", { songIndex, index, delta }),
  trackUpdate: (patch: {
    songIndex?: number;
    index: number;
    name?: string;
    busId?: string;
    gainDb?: number;
    pan?: number;
    mute?: boolean;
    solo?: boolean;
  }) => post("/api/v1/builder/track/update", patch),

  regionAdd: (patch: {
    songIndex: number;
    trackId: string;
    file?: string;
    startSeconds?: number;
    sourceOffsetSeconds?: number;
    durationSeconds?: number;
    gainDb?: number;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
  }) => post("/api/v1/builder/region/add", patch),
  regionRemove: (songIndex: number, regionId: string) =>
    post("/api/v1/builder/region/remove", { songIndex, regionId }),
  regionUpdate: (patch: {
    songIndex: number;
    regionId: string;
    trackId?: string;
    file?: string;
    startSeconds?: number;
    sourceOffsetSeconds?: number;
    durationSeconds?: number;
    gainDb?: number;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
  }) => post("/api/v1/builder/region/update", patch),

  async trackImportWav(songIndex: number, index: number, file: File): Promise<void> {
    await post("/api/v1/builder/track/import-wav/begin", { songIndex, index, fileName: file.name });
    try {
      await fetch(apiUrl("/api/v1/builder/track/import-wav/upload"), { method: "POST", body: file });
    } catch {
      // Best-effort -- surfaced via statusMessage.
    }
  },

  busAdd: () => post("/api/v1/builder/bus/add"),
  busRemove: (index: number) => post("/api/v1/builder/bus/remove", { index }),
  busMove: (index: number, delta: number) => post("/api/v1/builder/bus/move", { index, delta }),
  busUpdate: (patch: {
    index: number;
    name: string;
    channels: number;
    startChannel: number;
    gainDb: number;
    mute: boolean;
    solo: boolean;
    isAux: boolean;
  }) => post("/api/v1/builder/bus/update", patch),

  eventAdd: (songIndex: number) => post("/api/v1/builder/event/add", { songIndex }),
  eventRemove: (songIndex: number, index: number) =>
    post("/api/v1/builder/event/remove", { songIndex, index }),
  eventMove: (songIndex: number, index: number, delta: number) =>
    post("/api/v1/builder/event/move", { songIndex, index, delta }),
  eventUpdate: (patch: {
    songIndex: number;
    index: number;
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
  }) => post("/api/v1/builder/event/update", patch),
};

// Settings parity -- mirrors SettingsPanel.cpp's AudioDeviceSelectorComponent
// callbacks and MIDI/keybinding row handlers. See MainComponentSettings.cpp.
export const settings = {
  setAudioOutputDevice: (name: string) => post("/api/v1/settings/audio-device", { name }),
  setSampleRate: (value: number) => post("/api/v1/settings/sample-rate", { value }),
  setBufferSize: (value: number) => post("/api/v1/settings/buffer-size", { value }),
  setMidiOutput: (name: string) => post("/api/v1/settings/midi-output", { name }),
  setMidiInput: (name: string) => post("/api/v1/settings/midi-input", { name }),
  setKeybinding: (action: string, key: string) => post("/api/v1/settings/keybinding", { action, key }),
  // `channels` is the full list of active channel indices (0-based) -- the
  // caller sends the complete set every time, matching the native checkbox
  // list's "whole BigInteger bitmask" semantics.
  setOutputChannels: (channels: number[]) => post("/api/v1/settings/output-channels", { channels }),
};
