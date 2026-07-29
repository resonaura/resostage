/**
 * Live audio-level channel for the web UI.
 *
 * Structural project state is rAF-coalesced (can drop intermediate WS frames).
 * Meter levels must NOT drop frames — a one-block metronome click would vanish
 * if a silence frame overwrote it before React painted. This store is updated
 * on every WS message; LevelMeterBar ballistics read it every animation frame
 * so attack/release match the real signal without fake peak-hold on the wire.
 */

export type LiveLevels = {
  clickPeakDb: number;
  clickPeakDbL: number;
  clickPeakDbR: number;
  /** Per-track peaks (mixer/player). */
  tracks: { peakDb: number; peakDbL: number; peakDbR: number }[];
  /** Bus/group meters by id. */
  meters: { id: string; peakDb: number; peakDbL: number; peakDbR: number }[];
  /** Monotonic counter so subscribers always see a change. */
  seq: number;
};

const FLOOR = -144;

let levels: LiveLevels = {
  clickPeakDb: FLOOR,
  clickPeakDbL: FLOOR,
  clickPeakDbR: FLOOR,
  tracks: [],
  meters: [],
  seq: 0,
};

type Listener = () => void;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
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

  if (frame.clickPeakDb !== undefined) {
    levels.clickPeakDb = frame.clickPeakDb;
    changed = true;
  }
  if (frame.clickPeakDbL !== undefined) {
    levels.clickPeakDbL = frame.clickPeakDbL;
    changed = true;
  }
  if (frame.clickPeakDbR !== undefined) {
    levels.clickPeakDbR = frame.clickPeakDbR;
    changed = true;
  }
  if (frame.tracks) {
    levels.tracks = frame.tracks.map((t) => ({
      peakDb: t.peakDb ?? FLOOR,
      peakDbL: t.peakDbL ?? t.peakDb ?? FLOOR,
      peakDbR: t.peakDbR ?? t.peakDb ?? FLOOR,
    }));
    changed = true;
  }
  if (frame.meters) {
    levels.meters = frame.meters.map((m) => ({
      id: m.id,
      peakDb: m.peakDb ?? FLOOR,
      peakDbL: m.peakDbL ?? m.peakDb ?? FLOOR,
      peakDbR: m.peakDbR ?? m.peakDb ?? FLOOR,
    }));
    changed = true;
  }

  if (changed) {
    levels.seq += 1;
    emit();
  }
}

export function getLiveLevels(): LiveLevels {
  return levels;
}

export function subscribeLiveLevels(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
