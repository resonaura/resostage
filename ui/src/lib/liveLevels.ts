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

import { isRenderActive } from "./appActivity";
import { addRafTask } from "./rafLoop";

/**
 * A meter as the UI reads it.
 *
 * `peak*` is the raw sample peak -- what the dB readout and the clip latch
 * want. `needle*` is what a BAR should be driven by: the engine's own PPM
 * ballistics, sampled every 64 samples on the audio thread and published as a
 * trajectory (see core/engine/audio/MeterEnvelope.h).
 *
 * They are separate because the raw peak is a measurement of one callback, and
 * at a 4096-frame buffer that is one number per 85ms against a display asking
 * three times as often -- which is what made the needles judder. The PPM is a
 * filter with a defined release, so it reads the same at every buffer size.
 * When the backend does not send one (older frame version), needle falls back
 * to peak and behaves exactly as before.
 */
export type LiveMeter = {
  id: string;
  peakDb: number;
  peakDbL: number;
  peakDbR: number;
  needleDbL: number;
  needleDbR: number;
};

export type LiveLevels = {
  clickPeakDb: number;
  clickPeakDbL: number;
  clickPeakDbR: number;
  clickNeedleDbL: number;
  clickNeedleDbR: number;
  tracks: { peakDb: number; peakDbL: number; peakDbR: number }[];
  meters: LiveMeter[];
  seq: number;
};

const FLOOR = -144;

let latestClick = FLOOR;
let latestClickL = FLOOR;
let latestClickR = FLOOR;
/**
 * The click's needle values. NOT interval-maxed like the peaks above: the PPM
 * already holds its own peak on the audio thread with an instant attack, so
 * maxing it again here would re-hold a value its release has let go of.
 */
let clickNeedleL = FLOOR;
let clickNeedleR = FLOOR;
/** Max of click peaks since the last paint roll. */
let pendingClickMax = FLOOR;
let pendingClickMaxL = FLOOR;
let pendingClickMaxR = FLOOR;
/** Value frozen for the current animation frame (after roll). */
let displayClick = FLOOR;
let displayClickL = FLOOR;
let displayClickR = FLOOR;

let tracks: LiveLevels["tracks"] = [];
let meters: LiveMeter[] = [];
let meterIds: string[] = [];
let seq = 0;

export type LiveLedColor = { r: number; g: number; b: number };

export type LiveLedOutput = {
  fixtureIdx: number;
  ledColors: LiveLedColor[];
};

let liveLedOutputs: LiveLedOutput[] = [];
/**
 * The exact wire bytes `liveLedOutputs` was decoded from.
 *
 * The backend suppresses a telemetry frame only when the WHOLE frame is
 * byte-identical, so a moving playhead over a static lighting look still ships
 * the same LED rows 30 times a second. Decoding those rebuilt one small object
 * per LED per frame and then told every fixture in the scene that its colour
 * had "changed" -- a full React pass plus a THREE.Color per segment, sixty
 * times a second, to arrive at the picture already on screen. Comparing the
 * raw bytes first is far cheaper than decoding them, and it is exact: equal
 * bytes are equal colours, so nothing about preview fidelity is being traded
 * away here. A real change still lands on the very next frame.
 */
let lastLightBytes: Uint8Array | null = null;

function sameBytes(a: Uint8Array, b: Uint8Array | null): boolean {
  if (b === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameLeds(a: LiveLedColor[], b: LiveLedColor[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].r !== b[i].r || a[i].g !== b[i].g || a[i].b !== b[i].b) return false;
  }
  return true;
}

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

let stopPaintTicker: (() => void) | null = null;
let lightDirty = false;
let lastPaintTickMs = 0;
let lastPushMs = 0;
// If the frame driver stalls (occluded window, Electron backgroundThrottling,
// devtools) the preview must not freeze -- same hazard useLiveState guards its
// own flush against. Past this gap a frame notifies its listeners inline
// instead. Only ever consulted while the UI is meant to be painting at all:
// a deliberately suspended window (hidden + stopped) is not a stall, and
// treating it as one would resurrect exactly the per-wire-frame React storm
// the paint-rate bound exists to prevent.
const kPaintStallMs = 100;
// How long the ticker keeps spinning after the last telemetry frame before it
// retires itself. Nothing it does has any effect once the wire goes quiet, and
// the widgets that read it hold their own frame subscriptions, so an idle app
// settles to zero scheduled work instead of one permanent 60 Hz no-op.
const kTickerIdleMs = 1000;

/**
 * Shared paint ticker: rolls pending → display once per frame so stereo
 * ballistics never double-consume, then starts a fresh wire interval.
 *
 * It also fans out the light-output notification. That used to fire
 * synchronously from every binary frame, which meant a React state update per
 * fixture per FRAME OFF THE WIRE -- so when paint slowed down, telemetry kept
 * queueing setState work into an already-late frame and the preview lurched.
 * Bounding it by paint rate instead is the same discipline the meters have
 * always had (they are read during paint, never pushed), and it is why they
 * stayed smooth while the lights did not.
 */
function ensurePaintTicker() {
  if (stopPaintTicker) return;
  stopPaintTicker = addRafTask((nowMs) => {
    displayClick = pendingClickMax;
    displayClickL = pendingClickMaxL;
    displayClickR = pendingClickMaxR;
    pendingClickMax = latestClick;
    pendingClickMaxL = latestClickL;
    pendingClickMaxR = latestClickR;
    lastPaintTickMs = nowMs;
    if (lightDirty) {
      lightDirty = false;
      for (const l of lightListeners) l();
    }
    if (lastPushMs !== 0 && nowMs - lastPushMs > kTickerIdleMs) {
      const stop = stopPaintTicker;
      stopPaintTicker = null;
      // Rolling has already settled (pending === latest === the last wire
      // value) so there is nothing in flight to lose by standing down.
      stop?.();
    }
  });
}

/** Push levels from one telemetry frame (call for every WS message). */
export function pushLiveLevels(frame: {
  clickPeakDb?: number;
  clickPeakDbL?: number;
  clickPeakDbR?: number;
  clickPpmDbL?: number;
  clickPpmDbR?: number;
  tracks?: { peakDb?: number; peakDbL?: number; peakDbR?: number }[];
  meters?: {
    id: string;
    peakDb?: number;
    peakDbL?: number;
    peakDbR?: number;
    ppmDbL?: number;
    ppmDbR?: number;
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
  if (frame.clickPpmDbL !== undefined && Number.isFinite(frame.clickPpmDbL)) {
    clickNeedleL = frame.clickPpmDbL;
    changed = true;
  }
  if (frame.clickPpmDbR !== undefined && Number.isFinite(frame.clickPpmDbR)) {
    clickNeedleR = frame.clickPpmDbR;
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
    meters = frame.meters.map((m) => {
      const peakDbL = m.peakDbL ?? m.peakDb ?? FLOOR;
      const peakDbR = m.peakDbR ?? m.peakDb ?? FLOOR;
      return {
        id: m.id,
        peakDb: m.peakDb ?? FLOOR,
        peakDbL,
        peakDbR,
        needleDbL: m.ppmDbL ?? peakDbL,
        needleDbR: m.ppmDbR ?? peakDbR,
      };
    });
    changed = true;
  }

  if (changed) {
    seq += 1;
    lastPushMs = performance.now();
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
  needleDbL: number;
  needleDbR: number;
} {
  ensurePaintTicker();
  return {
    peakDb: Math.max(displayClick, pendingClickMax),
    peakDbL: Math.max(displayClickL, pendingClickMaxL),
    peakDbR: Math.max(displayClickR, pendingClickMaxR),
    needleDbL: clickNeedleL,
    needleDbR: clickNeedleR,
  };
}

export function getLiveLevels(): LiveLevels {
  const c = getClickPeaks();
  return {
    clickPeakDb: c.peakDb,
    clickPeakDbL: c.peakDbL,
    clickPeakDbR: c.peakDbR,
    clickNeedleDbL: c.needleDbL,
    clickNeedleDbR: c.needleDbR,
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
  // v3 inserts the click's two PPM floats here and widens each meter row from
  // two floats to four. A v2 sender is still decoded, with the needle falling
  // back to the raw peak -- the two builds only ever disagree during a dev
  // reload, but a garbled meter is a bad way to find that out.
  const hasPpm = version >= 3;
  const countsAt = hasPpm ? 24 : 16;
  const numTracks = view.getUint16(countsAt, true);
  const numMeters = view.getUint16(countsAt + 2, true);
  const numLights = view.getUint16(countsAt + 4, true);

  latestClickL = clickL;
  latestClickR = clickR;
  latestClick = Math.max(clickL, clickR);
  if (latestClick > pendingClickMax) pendingClickMax = latestClick;
  if (clickL > pendingClickMaxL) pendingClickMaxL = clickL;
  if (clickR > pendingClickMaxR) pendingClickMaxR = clickR;
  clickNeedleL = hasPpm ? view.getFloat32(16, true) : clickL;
  clickNeedleR = hasPpm ? view.getFloat32(20, true) : clickR;

  let offset = hasPpm ? 32 : 24;

  const nextTracks: LiveLevels["tracks"] = [];
  for (let i = 0; i < numTracks; i++) {
    if (offset + 8 > buffer.byteLength) break;
    const pL = view.getFloat32(offset, true);
    const pR = view.getFloat32(offset + 4, true);
    offset += 8;
    nextTracks.push({ peakDb: Math.max(pL, pR), peakDbL: pL, peakDbR: pR });
  }
  tracks = nextTracks;

  const meterRowBytes = hasPpm ? 16 : 8;
  const nextMeters: LiveMeter[] = [];
  for (let i = 0; i < numMeters; i++) {
    if (offset + meterRowBytes > buffer.byteLength) break;
    const pL = view.getFloat32(offset, true);
    const pR = view.getFloat32(offset + 4, true);
    const nL = hasPpm ? view.getFloat32(offset + 8, true) : pL;
    const nR = hasPpm ? view.getFloat32(offset + 12, true) : pR;
    offset += meterRowBytes;
    const id = meterIds[i] ?? `meter-${i}`;
    nextMeters.push({
      id,
      peakDb: Math.max(pL, pR),
      peakDbL: pL,
      peakDbR: pR,
      needleDbL: nL,
      needleDbR: nR,
    });
  }
  meters = nextMeters;

  if (version >= 2) {
    // Compare the encoded LED block before decoding it: an unchanged look is
    // the common case (see lastLightBytes) and skipping it costs one memcmp
    // instead of an object graph plus a scene-wide re-render.
    const lightBytes = new Uint8Array(buffer, offset, buffer.byteLength - offset);
    if (!sameBytes(lightBytes, lastLightBytes)) {
      lastLightBytes = lightBytes.slice();
      const nextLights: LiveLedOutput[] = [];
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
        // Structural sharing: a fixture whose colours did not move keeps its
        // previous object, so a consumer holding one reference per fixture
        // (useLiveFixtureColor → one 3D fixture) can skip re-rendering with a
        // reference check. Without this, one blinking bar in a twelve-bar rig
        // re-rendered all twelve.
        const prev = liveLedOutputs[i];
        nextLights.push(
          prev !== undefined &&
            prev.fixtureIdx === fixtureIdx &&
            sameLeds(prev.ledColors, leds)
            ? prev
            : { fixtureIdx, ledColors: leds },
        );
      }
      liveLedOutputs = nextLights;
      // Normally notified from the paint ticker, not here -- see
      // ensurePaintTicker(). The inline path is only for a stalled rAF.
      lightDirty = true;
    }
  } else if (liveLedOutputs.length > 0) {
    // v1 sender (no LED rows at all): drop whatever a v2 sender left behind.
    liveLedOutputs = [];
    lastLightBytes = null;
    lightDirty = true;
  }

  seq += 1;
  lastPushMs = performance.now();
  ensurePaintTicker();

  // Only meaningful while the UI is supposed to be painting: a window we
  // deliberately suspended is not a stalled one.
  if (
    lightDirty &&
    isRenderActive() &&
    lastPaintTickMs !== 0 &&
    lastPushMs - lastPaintTickMs > kPaintStallMs
  ) {
    lightDirty = false;
    for (const l of lightListeners) l();
  }
}
