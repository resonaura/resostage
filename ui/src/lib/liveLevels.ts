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
let seq = 0;

type Listener = () => void;
const listeners = new Set<Listener>();

let paintRaf = 0;

function emit() {
  for (const l of listeners) l();
}

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
    emit();
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

/**
 * @deprecated Prefer getClickPeaks() — pure read (no consume).
 */
export function takeClickPeaks(): {
  peakDb: number;
  peakDbL: number;
  peakDbR: number;
} {
  return getClickPeaks();
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

export function subscribeLiveLevels(listener: Listener): () => void {
  listeners.add(listener);
  ensurePaintTicker();
  return () => {
    listeners.delete(listener);
  };
}
