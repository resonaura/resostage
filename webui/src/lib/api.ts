import { apiUrl } from "./backend";
import type { EventTypeWire } from "./types";

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
};

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
  setBusGain: (index: number, value: number) => post("/api/v1/bus/gain", { index, value }),
  setBusMute: (index: number, value: boolean) => post("/api/v1/bus/mute", { index, value }),
  setBusSolo: (index: number, value: boolean) => post("/api/v1/bus/solo", { index, value }),
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
  songAdd: () => post("/api/v1/builder/song/add"),
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
  }) => post("/api/v1/builder/song/update", patch),

  trackAdd: (songIndex: number) => post("/api/v1/builder/track/add", { songIndex }),
  trackRemove: (songIndex: number, index: number) =>
    post("/api/v1/builder/track/remove", { songIndex, index }),
  trackMove: (songIndex: number, index: number, delta: number) =>
    post("/api/v1/builder/track/move", { songIndex, index, delta }),
  trackUpdate: (patch: {
    songIndex: number;
    index: number;
    name: string;
    busId: string;
    gainDb: number;
    pan: number;
    mute: boolean;
    solo: boolean;
  }) => post("/api/v1/builder/track/update", patch),

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
