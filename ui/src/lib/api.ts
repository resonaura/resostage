import { apiUrl } from "./backend";
import type { MixGraphPayload } from "../components/audio/signalFlowLayout";
import type {
  AllPeaksResponse,
  EventTypeWire,
  LightCueRow,
  PeaksResponse,
} from "./types";

// ── Immediate-refetch hook ────────────────────────────────────────────────────
// In UDP/embedded mode the structural state arrives via a 1 s HTTP poll. Any
// user action (solo, mute, gain commit …) should be reflected without waiting
// for the next poll tick, so we ask the state layer to fetch immediately after
// the command lands. WS mode never registers a handler (server pushes state).
//
// The handler is debounced: rapid-fire actions (e.g. multiple mixer toggles in
// quick succession) coalesce into one fetch instead of stampeding the server.
let _refetchHandler: (() => void) | null = null;
let _refetchTimer: ReturnType<typeof setTimeout> | null = null;

export function registerRefetchHandler(fn: () => void): void {
  _refetchHandler = fn;
}
export function unregisterRefetchHandler(): void {
  _refetchHandler = null;
}

function _triggerRefetch(): void {
  if (!_refetchHandler) return;
  if (_refetchTimer !== null) return; // already pending
  _refetchTimer = setTimeout(() => {
    _refetchTimer = null;
    _refetchHandler?.();
  }, 50);
}

// Mirrors WebServer::handleHttpApi().
async function post(path: string, body?: unknown): Promise<void> {
  try {
    await fetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
    });
    _triggerRefetch();
  } catch {
    // Best-effort, matches the embedded reference client -- a dropped
    // command just means the next state frame won't reflect it and the
    // user can press again; there's nothing useful to surface here.
  }
}

// ── Continuous parameter coalescing ──────────────────────────────────────────
// High-frequency dragging (faders, pan knobs, send knobs) can generate hundreds
// of updates per second. Over LAN/Wi-Fi, spamming un-throttled HTTP POSTs floods
// Chromium's 6-connection pool and causes multi-second queue lag.
//
// postContinuous ensures that if a request is already in-flight for a specific
// target, subsequent intermediate values replace each other in a pending slot,
// and only the latest value is sent as soon as the in-flight POST finishes.
const _continuousInFlight = new Map<string, { pending: unknown; busy: boolean }>();

async function postContinuous(path: string, body: unknown): Promise<void> {
  const targetKey = `${path}:${(body as Record<string, unknown>)?.index ?? (body as Record<string, unknown>)?.trackIndex ?? ""}`;
  let state = _continuousInFlight.get(targetKey);
  if (!state) {
    state = { pending: null, busy: false };
    _continuousInFlight.set(targetKey, state);
  }

  if (state.busy) {
    state.pending = body;
    return;
  }

  state.busy = true;
  let nextPayload: unknown = body;

  try {
    while (nextPayload !== null) {
      state.pending = null;
      await fetch(apiUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextPayload),
      });
      nextPayload = state.pending;
    }
  } catch {
    /* best effort */
  } finally {
    state.busy = false;
    if (state.pending === null) {
      _continuousInFlight.delete(targetKey);
    }
  }
}

export const transport = {
  play: () => post("/api/v1/transport/play"),
  // Pause -- freezes in place, resumed by play(). Used by the Play/Pause
  // toggle + spacebar. See AudioEngine::stop()'s doc comment.
  stop: () => post("/api/v1/transport/stop"),
  // Dedicated "Stop" button -- see AudioEngine::stopToStart(): first press
  // rewinds the current song to its start, a second press (already there)
  // rewinds to the very start of the whole project. Distinct from stop()
  // above, which never moves the playhead.
  stopToStart: () => post("/api/v1/transport/stop-to-start"),
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
    post(
      "/api/v1/transport/seek",
      songIndex !== undefined ? { seconds, songIndex } : { seconds },
    ),
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

/**
 * The signal flow the audio thread is rendering right now -- a verbatim
 * projection of the engine's MixGraph (core/engine/audio/MixGraph.h).
 *
 * Deliberately its own endpoint rather than part of the 30 Hz state frame:
 * it only changes when routing does, and only one screen ever wants it.
 */
export async function fetchMixGraph(): Promise<MixGraphPayload> {
  const res = await fetch(apiUrl("/api/v1/audio/mixgraph"));
  const body = (await res.json()) as { mixGraph?: MixGraphPayload };
  return body.mixGraph ?? { strips: [], edges: [] };
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
  endSec: number,
): Promise<WaveformRawResponse> {
  const cacheKey = `${file}:${startSec.toFixed(2)}:${endSec.toFixed(2)}`;
  if (rawWaveformCache.has(cacheKey)) {
    return rawWaveformCache.get(cacheKey)!;
  }
  // startSec / endSec, not start / end: the server reads those exact names
  // (WebServer::serveWaveformRaw) and answers 400 to anything else. It had
  // been answering 400 to every single one of these, so the deepest zoom
  // level quietly fell back to binned peaks instead of real samples.
  const url = apiUrl(
    `/api/v1/player/waveform-raw?file=${encodeURIComponent(file)}` +
      `&startSec=${startSec}&endSec=${endSec}`,
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
  setTrackGain: (index: number, value: number) =>
    postContinuous("/api/v1/track/gain", { index, value }),
  setTrackPan: (index: number, value: number) =>
    postContinuous("/api/v1/track/pan", { index, value }),
  setTrackMute: (index: number, value: boolean) =>
    post("/api/v1/track/mute", { index, value }),
  setTrackSolo: (index: number, value: boolean) =>
    post("/api/v1/track/solo", { index, value }),
  setTrackMono: (index: number, mono: boolean) =>
    post("/api/v1/track/mono", { index, value: mono }),
  // Bus assignment for the track's main output -- matches the MixerStrip
  // outputBusBox in the native UI. Empty busId = "(sends only)".
  setTrackBus: (index: number, busId: string) =>
    builder.trackUpdate({ index, busId }),
  setBusGain: (index: number, value: number) =>
    postContinuous("/api/v1/bus/gain", { index, value }),
  setBusPan: (index: number, value: number) =>
    postContinuous("/api/v1/bus/pan", { index, value }),
  setBusMute: (index: number, value: boolean) =>
    post("/api/v1/bus/mute", { index, value }),
  setBusSolo: (index: number, value: boolean) =>
    post("/api/v1/bus/solo", { index, value }),
  // Metronome solo -- joins the same solo group as setTrackSolo, silencing
  // every regular track exactly as if one of them had solo engaged. See
  // AudioEngine::setClickSolo(). `index` is unused (server ignores it).
  setClickSolo: (value: boolean) =>
    post("/api/v1/click/solo", { index: 0, value }),
  /**
   * Find-or-create this track's send to busId at `level`, the schema's own
   * 0-100 LINEAR percent (100 = unity / 0 dB). Turning a knob up from its
   * floor implicitly creates the send, so there is no separate "add" call.
   *
   * `enabled` is optional and omitted by the knob: leaving it out means
   * "just move the level", so muting a send from the context menu and then
   * nudging its knob doesn't silently switch it back on.
   */
  setTrackSend: (
    trackIndex: number,
    busId: string,
    level: number,
    enabled?: boolean,
    /** Collapses a knob drag into one undo entry -- see lib/editGesture. */
    gestureId?: string,
  ) =>
    postContinuous("/api/v1/mixer/track/send", {
      trackIndex,
      gestureId,
      busId,
      level,
      ...(enabled === undefined ? {} : { enabled }),
    }),
  // Actually erases the track's TrackSendDef for busId (as opposed to setting
  // its level to 0 or disabling it, both of which keep the send entry). Still
  // used by "Remove all sends" in the strip context menu.
  removeTrackSend: (trackIndex: number, busId: string) =>
    post("/api/v1/mixer/track/send/remove", { trackIndex, busId }),
};

// Project lifecycle. New/loadDialog/save/saveAs just ask the native app to
// do exactly what its own top-bar buttons do -- correct whether this page is
// embedded in the app's webview or not, since any native dialog they pop
// shows up in that same on-screen window (see lib/embedded.ts). upload/
// exportAndDownload are the browser-only equivalents for a client that has
// no such window: a normal <input type=file> upload, and a poll-until-ready
// then <a download> for the reverse direction (avoids ever blocking the
// server's single lws thread on the save that produces the download).
const QUIT_DECISION_INDEX = { cancel: 0, save: 1, discard: 2 } as const;

export const project = {
  new: () => post("/api/v1/project/new"),
  loadDialog: () => post("/api/v1/project/load-dialog"),
  save: () => post("/api/v1/project/save"),
  saveAs: () => post("/api/v1/project/save-as"),
  // Recent-projects parity -- native-only (no filesystem path model makes
  // sense in a plain browser tab, see ProjectMenu's IS_EMBEDDED gating).
  openRecent: (path: string) => post("/api/v1/project/open-recent", { path }),
  clearRecent: () => post("/api/v1/project/clear-recent"),
  // Renames the loaded project directly (Project::name), independent of
  // any file path a save/export happens to use -- see WebCommandKind::
  // SetProjectName. Needed because a plain-browser "download" Save As can't
  // otherwise drive the archive's internal name at all (JS never learns the
  // filename the user picked in the OS's own save sheet).
  setName: (name: string) => post("/api/v1/project/name", { name }),
  // Answers the in-webview "Unsaved Changes" quit prompt (WebUiState.
  // quitConfirmPending) -- see WebCommandKind::QuitDecision.
  resolveQuit: (choice: "save" | "discard" | "cancel") =>
    post("/api/v1/project/quit-decision", {
      index: QUIT_DECISION_INDEX[choice],
    }),
  // Answers the in-webview "Unsaved Changes" prompt shown before opening an
  // externally-requested project (WebUiState.openConfirmPending) -- see
  // WebCommandKind::OpenDecision.
  resolveOpen: (choice: "save" | "discard" | "cancel") =>
    post("/api/v1/project/open-decision", {
      index: QUIT_DECISION_INDEX[choice],
    }),

  async upload(file: File): Promise<void> {
    try {
      await fetch(apiUrl("/api/v1/project/upload"), {
        method: "POST",
        body: file,
      });
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
  /**
   * Move a song's end marker. `endSeconds <= 0` clears the override and lets
   * the song go back to being as long as its content.
   *
   * `gestureId` coalesces a drag into ONE undo entry -- pass the same string
   * for every frame of one drag, and omit it for a discrete edit.
   */
  songEnd: (index: number, endSeconds: number, gestureId?: string) =>
    post("/api/v1/builder/song/end", { index, endSeconds, gestureId }),
  songMove: (index: number, delta: number) =>
    post("/api/v1/builder/song/move", { index, delta }),
  songUpdate: (patch: {
    index: number;
    name: string;
    bpm: number;
    mode: "auto" | "wait";
    tsNum: number;
    tsDen: number;
    click: boolean;
    clickBusId: string;
    clickGainDb?: number;
    clickPan?: number;
    clickMono?: boolean;
    clickName?: string;
    clickSends: { busId: string; level: number; enabled: boolean }[];
  }) => post("/api/v1/builder/song/update", patch),

  trackAdd: (songIndex: number) =>
    post("/api/v1/builder/track/add", { songIndex }),
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
    mono?: boolean;
  }) => post("/api/v1/builder/track/update", patch),

  // `gestureId`: pass the same id across several regionAdd/regionRemove/
  // regionUpdate calls that belong to one user gesture (split/duplicate/
  // paste/multi-select delete) so the backend's undo history collapses them
  // into a single undo step instead of N. Leave unset for a normal
  // single-region edit (always its own undo step). See ProjectHistory.h.
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
    fadeInCurve?: number;
    fadeOutCurve?: number;
    loop?: boolean;
    gestureId?: string;
  }) => post("/api/v1/builder/region/add", patch),
  regionRemove: (songIndex: number, regionId: string, gestureId?: string) =>
    post("/api/v1/builder/region/remove", { songIndex, regionId, gestureId }),
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
    fadeInCurve?: number;
    fadeOutCurve?: number;
    loop?: boolean;
    loopLengthSeconds?: number;
    /** Playback rate; pitch follows it, as on tape. */
    speed?: number;
    semitones?: number;
    reverse?: boolean;
    gestureId?: string;
  }) => post("/api/v1/builder/region/update", patch),

  async trackImportWav(
    songIndex: number,
    index: number,
    file: File,
  ): Promise<void> {
    await post("/api/v1/builder/track/import-wav/begin", {
      songIndex,
      index,
      fileName: file.name,
    });
    try {
      await fetch(apiUrl("/api/v1/builder/track/import-wav/upload"), {
        method: "POST",
        body: file,
      });
    } catch {
      // Best-effort -- surfaced via statusMessage.
    }
  },

  // Native "Open Audio File" picker (embedded webview only -- see
  // IS_EMBEDDED gating in AudioTrackLanes.tsx; a plain browser tab has no
  // native window to show the dialog in and keeps the file-input fallback).
  // The Core side pops a JUCE FileChooser and imports the picked file
  // straight from disk, so no upload round-trip happens here.
  trackImportWavDialog: (songIndex: number, index: number) =>
    post("/api/v1/builder/track/import-wav/dialog", { songIndex, index }),

  busAdd: () => post("/api/v1/builder/bus/add"),
  busRemove: (index: number) => post("/api/v1/builder/bus/remove", { index }),
  busMove: (index: number, delta: number) =>
    post("/api/v1/builder/bus/move", { index, delta }),
  busUpdate: (patch: {
    index: number;
    name: string;
    channels: number;
    startChannel: number;
    gainDb: number;
    pan?: number;
    mute: boolean;
    solo: boolean;
    isAux: boolean;
  }) => post("/api/v1/builder/bus/update", patch),

  eventAdd: (songIndex: number) =>
    post("/api/v1/builder/event/add", { songIndex }),
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

  // Structural song markers (Intro/Verse/Chorus/Bridge/Outro/Solo/custom).
  // Identity is by sectionId (like regions), not positional index (like
  // events) -- repositioning a marker (drag) is just a startSeconds update.
  sectionAdd: (songIndex: number, startSeconds: number, name?: string) =>
    post("/api/v1/builder/section/add", { songIndex, startSeconds, name }),
  sectionRemove: (songIndex: number, sectionId: string) =>
    post("/api/v1/builder/section/remove", { songIndex, sectionId }),
  sectionUpdate: (patch: {
    songIndex: number;
    sectionId: string;
    name?: string;
    startSeconds?: number;
    colorIndex?: number;
  }) => post("/api/v1/builder/section/update", patch),

  // Per-song cycle locators (Logic-style loop/skip). Coordinates persist even
  // when inactive; AudioEngine applies seeks so every connected client hears
  // the same loop without SPA-side racing.
  cycleUpdate: (patch: {
    songIndex: number;
    active?: boolean;
    skip?: boolean;
    leftSec?: number;
    rightSec?: number;
    gestureId?: string;
  }) => post("/api/v1/builder/cycle/update", patch),
};

// Lighting rig config + fixture roster + Light-timeline tracks/cues -- see
// MainComponentLighting.cpp and RESTORE_POINT.md Feature 6. Mirrors
// `builder` above: same raw-JSON-passthrough routing, field parsing happens
// server-side.
export const lighting = {
  setConfig: (patch: {
    enabled?: boolean;
    kind?: "none" | "resolight" | "dmx::generic";
    resolightColumns?: number;
    resolightRows?: number;
    idleBehavior?: "hold" | "blackout" | "static" | "effect";
    idleColorR?: number;
    idleColorG?: number;
    idleColorB?: number;
    idleIntensity?: number;
    idleEffectType?: string;
    idleEffectRateHz?: number;
    idleGradientPreset?: string;
    idleGradientColors?: string;
    defaultRefreshRateHz?: number;
    artNetTargetHost?: string;
  }) => post("/api/v1/lighting/config", patch),

  fixtureAdd: (name?: string) => post("/api/v1/lighting/fixture/add", { name }),
  fixtureDuplicate: (fixtureId: string) =>
    post("/api/v1/lighting/fixture/duplicate", { fixtureId }),
  fixtureRemove: (fixtureId: string) =>
    post("/api/v1/lighting/fixture/remove", { fixtureId }),

  fixtureUpdate: (patch: {
    fixtureId: string;
    name?: string;
    ledCount?: number;
    addressable?: boolean;
    posX?: number;
    posY?: number;
    posZ?: number;
    rotationYDeg?: number;
    mountedHorizontally?: boolean;
    gridColumn?: number;
    gridRow?: number;
    dmxUniverse?: number;
    dmxStartChannel?: number;
    dmxChannelCount?: number;
    shape?:
      | "bar"
      | "strip"
      | "ring"
      | "matrix"
      | "par"
      | "wash"
      | "spot"
      | "moving-head";
    matrixCols?: number;
    channelProfile?: "dimmer" | "rgb" | "rgbw" | "rgbwa" | "custom";
    tiltDeg?: number;
    refreshRateHz?: number;
    /** Empty string clears the host (back to preview-only). Port is protocol-fixed. */
    networkHost?: string;
  }) => post("/api/v1/lighting/fixture/update", patch),

  trackAdd: () => post("/api/v1/lighting/track/add"),
  trackRemove: (index: number) =>
    post("/api/v1/lighting/track/remove", { index }),
  trackMove: (index: number, delta: number) =>
    post("/api/v1/lighting/track/move", { index, delta }),
  trackUpdate: (patch: {
    index: number;
    name?: string;
    fixtureIds?: string[];
  }) => post("/api/v1/lighting/track/update", patch),

  cueAdd: (
    songIndex: number,
    trackId: string,
    startSeconds: number,
    durationSeconds = 2.0,
    extra?: Partial<LightCueRow> & { gestureId?: string },
  ) =>
    post("/api/v1/lighting/cue/add", {
      songIndex,
      trackId,
      startSeconds,
      durationSeconds,
      ...extra,
    }),
  cueRemove: (songIndex: number, cueId: string) =>
    post("/api/v1/lighting/cue/remove", { songIndex, cueId }),
  cueUpdate: (patch: {
    songIndex: number;
    cueId: string;
    trackId?: string;
    startSeconds?: number;
    durationSeconds?: number;
    colorR?: number;
    colorG?: number;
    colorB?: number;
    intensity?: number;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
    label?: string;
    // Audio-reactive effect (resolved by both LightEngine and the per-LED
    // websocket stream -- see liveLevels.ts for the live result).
    effectType?:
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
      | "barberpole";
    effectSourceType?: "bus" | "track";
    effectSourceId?: string;
    effectIntensity?: number;
    tempoSync?: boolean;
    tempoSubdiv?: string;
    effectRateHz?: number;
    gradientPreset?:
      | "solid"
      | "greenYellowRed"
      | "custom"
      | "vulcanFire"
      | "toxicFire"
      | "cryoFire"
      | "cyberpunkFire";
    gradientColors?: string;
    blendMode?:
      | "normal"
      | "additive"
      | "multiply"
      | "difference"
      | "lighten"
      | "subtractive";
    gestureId?: string;
  }) => post("/api/v1/lighting/cue/update", patch),
};

// Timeline undo/redo (regions + sections of the currently loaded project).
// See ProjectHistory.h / AudioEngine::undoTimelineEdit()/redoTimelineEdit().
export const timelineHistory = {
  undo: () => post("/api/v1/timeline/undo"),
  redo: () => post("/api/v1/timeline/redo"),
};

// Settings parity -- mirrors SettingsPanel.cpp's AudioDeviceSelectorComponent
// callbacks and MIDI/keybinding row handlers. See MainComponentSettings.cpp.
export const settings = {
  setAudioOutputDevice: (name: string) =>
    post("/api/v1/settings/audio-device", { name }),
  /** Switch host audio API (ASIO / CoreAudio / ALSA / JACK / Windows Audio). */
  setAudioDriver: (type: string) =>
    post("/api/v1/settings/audio-driver", { type }),
  showAudioControlPanel: () =>
    post("/api/v1/settings/audio-control-panel", {}),
  setSampleRate: (value: number) =>
    post("/api/v1/settings/sample-rate", { value }),
  setBufferSize: (value: number) =>
    post("/api/v1/settings/buffer-size", { value }),
  setMidiOutput: (name: string) =>
    post("/api/v1/settings/midi-output", { name }),
  setMidiInput: (name: string) => post("/api/v1/settings/midi-input", { name }),
  /** Toggles the "ResoStage Sync" virtual MIDI source, for testing DAW clock/transport sync. */
  setMidiVirtualPort: (enabled: boolean) =>
    post("/api/v1/settings/midi-virtual-port", { enabled }),
  setUiRenderEngine: (engine: "browser" | "electron") =>
    post("/api/v1/settings/ui-render-engine", { engine }),
  setTheme: (theme: string) => post("/api/v1/settings/theme", { theme }),
  /** Relaunch ResoStage so a changed UI engine takes effect (performAction "restart_app"). */
  restart: () => post("/api/v1/action", { action: "restart_app" }),
  setKeybinding: (action: string, key: string) =>
    post("/api/v1/settings/keybinding", { action, key }),
  // `channels` is the full list of active channel indices (0-based) -- the
  // caller sends the complete set every time, matching the native checkbox
  // list's "whole BigInteger bitmask" semantics.
  setOutputChannels: (channels: number[]) =>
    post("/api/v1/settings/output-channels", { channels }),
  /** Arm MIDI-learn for `action` -- next Note On / CC from the remote is bound. */
  midiLearn: (action: string) =>
    post("/api/v1/settings/midi-learn", { action }),
  midiLearnCancel: () => post("/api/v1/settings/midi-learn-cancel", {}),
  /** Drop any MIDI mapping for `action`. */
  midiClear: (action: string) =>
    post("/api/v1/settings/midi-clear", { action }),
};
