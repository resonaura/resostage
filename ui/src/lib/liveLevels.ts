/**
 * Live audio-level channel for the web UI.
 *
 * Structural project state is rAF-coalesced (can drop intermediate WS frames).
 * Meter levels use a separate path: every WS frame updates this store, and
 * ballistics poll it every animation frame.
 *
 * For sparse impulses (metronome):
 *  - On each WS frame: interval-max into `pending`.
 *  - Once per animation frame (shared ticker): pending → display, pending
 *    resets to the latest wire value. L/R getters only read — no consume race.
 * That is the true max of what arrived since the last paint, not a sticky
 * hold after silence.
 */

export type LiveLevels = {
  clickPeakDb: number;
  clickPeakDbL: number;
  clickPeakDbR: number;
  tracks: { peakDb: number; peakDbL: number; peakDbR: number }[];
  meters: { id: string; peakDb: number; peakDbL: number; peakDbR: number }[];
  seq: number;
};

const FLOOR = -144;

let latestClick = FLOOR;
let latestClickL = FLOOR;
let latestClickR = FLOOR;
/** Max of click peaks since the last paint roll. */
let pendingClickMax = FLOOR;
let pendingClickMaxL = FLOOR;
let pendingClickMaxR = FLOOR;
/** Value frozen for the current animation frame (after roll). */
let displayClick = FLOOR;
let displayClickL = FLOOR;
let displayClickR = FLOOR;

let tracks: LiveLevels["tracks"] = [];
let meters: LiveLevels["meters"] = [];
let meterIds: string[] = [];
let seq = 0;

export type LiveLedColor = { r: number; g: number; b: number };

export type LiveLedOutput = {
  fixtureIdx: number;
  ledColors: LiveLedColor[];
};

let liveLedOutputs: LiveLedOutput[] = [];

type Listener = () => void;
const lightListeners = new Set<Listener>();

export function setMeterIds(ids: string[]) {
  meterIds = ids;
}

export function getLiveLedOutputs(): LiveLedOutput[] {
  return liveLedOutputs;
}

export function subscribeLiveLedOutputs(listener: Listener): () => void {
  lightListeners.add(listener);
  return () => {
    lightListeners.delete(listener);
  };
}

let paintRaf = 0;

/**
 * Shared paint ticker: rolls pending → display once per frame so stereo
 * ballistics never double-consume, then starts a fresh wire interval.
 */
function ensurePaintTicker() {
  if (paintRaf) return;
  const tick = () => {
    displayClick = pendingClickMax;
    displayClickL = pendingClickMaxL;
    displayClickR = pendingClickMaxR;
    pendingClickMax = latestClick;
    pendingClickMaxL = latestClickL;
    pendingClickMaxR = latestClickR;
    paintRaf = requestAnimationFrame(tick);
  };
  paintRaf = requestAnimationFrame(tick);
}

/** Push levels from one telemetry frame (call for every WS message). */
export function pushLiveLevels(frame: {
  clickPeakDb?: number;
  clickPeakDbL?: number;
  clickPeakDbR?: number;
  tracks?: { peakDb?: number; peakDbL?: number; peakDbR?: number }[];
  meters?: {
    id: string;
    peakDb?: number;
    peakDbL?: number;
    peakDbR?: number;
  }[];
}): void {
  let changed = false;

  if (frame.clickPeakDb !== undefined && Number.isFinite(frame.clickPeakDb)) {
    latestClick = frame.clickPeakDb;
    if (frame.clickPeakDb > pendingClickMax)
      pendingClickMax = frame.clickPeakDb;
    changed = true;
  }
  if (frame.clickPeakDbL !== undefined && Number.isFinite(frame.clickPeakDbL)) {
    latestClickL = frame.clickPeakDbL;
    if (frame.clickPeakDbL > pendingClickMaxL)
      pendingClickMaxL = frame.clickPeakDbL;
    changed = true;
  }
  if (frame.clickPeakDbR !== undefined && Number.isFinite(frame.clickPeakDbR)) {
    latestClickR = frame.clickPeakDbR;
    if (frame.clickPeakDbR > pendingClickMaxR)
      pendingClickMaxR = frame.clickPeakDbR;
    changed = true;
  }
  if (frame.tracks) {
    tracks = frame.tracks.map((t) => ({
      peakDb: t.peakDb ?? FLOOR,
      peakDbL: t.peakDbL ?? t.peakDb ?? FLOOR,
      peakDbR: t.peakDbR ?? t.peakDb ?? FLOOR,
    }));
    changed = true;
  }
  if (frame.meters) {
    meters = frame.meters.map((m) => ({
      id: m.id,
      peakDb: m.peakDb ?? FLOOR,
      peakDbL: m.peakDbL ?? m.peakDb ?? FLOOR,
      peakDbR: m.peakDbR ?? m.peakDb ?? FLOOR,
    }));
    changed = true;
  }

  if (changed) {
    seq += 1;
    ensurePaintTicker();
  }
}

/**
 * Click peaks for ballistics (pure read). max(display, pending) so a hit
 * that arrived mid-frame is visible before the paint ticker rolls.
 */
export function getClickPeaks(): {
  peakDb: number;
  peakDbL: number;
  peakDbR: number;
} {
  ensurePaintTicker();
  return {
    peakDb: Math.max(displayClick, pendingClickMax),
    peakDbL: Math.max(displayClickL, pendingClickMaxL),
    peakDbR: Math.max(displayClickR, pendingClickMaxR),
  };
}

export function getLiveLevels(): LiveLevels {
  const c = getClickPeaks();
  return {
    clickPeakDb: c.peakDb,
    clickPeakDbL: c.peakDbL,
    clickPeakDbR: c.peakDbR,
    tracks,
    meters,
    seq,
  };
}

export function pushLiveBinaryFrame(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 24) return;
  const view = new DataView(buffer);
  const magic = view.getUint16(0, true);
  if (magic !== 0x5253) return;
  // Version 2+ carries backend-rendered per-LED light rows.
  const version = view.getUint8(2);

  // offset 4: playheadSec — unused on the SPA (transport playhead comes from
  // the JSON state path); still advance the view past it.
  const clickL = view.getFloat32(8, true);
  const clickR = view.getFloat32(12, true);
  const numTracks = view.getUint16(16, true);
  const numMeters = view.getUint16(18, true);
  const numLights = view.getUint16(20, true);

  latestClickL = clickL;
  latestClickR = clickR;
  latestClick = Math.max(clickL, clickR);
  if (latestClick > pendingClickMax) pendingClickMax = latestClick;
  if (clickL > pendingClickMaxL) pendingClickMaxL = clickL;
  if (clickR > pendingClickMaxR) pendingClickMaxR = clickR;

  let offset = 24;

  const nextTracks: LiveLevels["tracks"] = [];
  for (let i = 0; i < numTracks; i++) {
    if (offset + 8 > buffer.byteLength) break;
    const pL = view.getFloat32(offset, true);
    const pR = view.getFloat32(offset + 4, true);
    offset += 8;
    nextTracks.push({ peakDb: Math.max(pL, pR), peakDbL: pL, peakDbR: pR });
  }
  tracks = nextTracks;

  const nextMeters: LiveLevels["meters"] = [];
  for (let i = 0; i < numMeters; i++) {
    if (offset + 8 > buffer.byteLength) break;
    const pL = view.getFloat32(offset, true);
    const pR = view.getFloat32(offset + 4, true);
    offset += 8;
    const id = meterIds[i] ?? `meter-${i}`;
    nextMeters.push({ id, peakDb: Math.max(pL, pR), peakDbL: pL, peakDbR: pR });
  }
  meters = nextMeters;

  const nextLights: LiveLedOutput[] = [];
  if (version >= 2) {
    for (let i = 0; i < numLights; i++) {
      if (offset + 4 > buffer.byteLength) break;
      const fixtureIdx = view.getUint16(offset, true);
      const ledCount = view.getUint16(offset + 2, true);
      offset += 4;
      const leds: LiveLedColor[] = [];
      for (let j = 0; j < ledCount; j++) {
        if (offset + 3 > buffer.byteLength) break;
        leds.push({
          r: view.getUint8(offset),
          g: view.getUint8(offset + 1),
          b: view.getUint8(offset + 2),
        });
        offset += 3;
      }
      nextLights.push({ fixtureIdx, ledColors: leds });
    }
  }
  liveLedOutputs = nextLights;
  for (const l of lightListeners) l();

  seq += 1;
  ensurePaintTicker();
}
