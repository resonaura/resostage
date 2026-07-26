import { apiUrl } from "./backend";

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
