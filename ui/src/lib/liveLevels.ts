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

import { isRenderActive, setTransportPlaying } from "./appActivity";
import { addRafTask } from "./rafLoop";

/**
 * A meter as the UI reads it.
 *
 * `peak*` is the raw peak of the last audio callback -- what the dB readout
 * and the clip latch want. `needle*` is what a BAR should be driven by: the
 * loudest sample since this consumer last asked, measured every 64 samples in
 * the engine (see core/engine/audio/MeterEnvelope.h).
 *
 * They are separate because a per-callback peak is one number per 85ms at a
 * 4096-frame buffer, against a display asking three times as often -- so most
 * polls had nothing and the needles slammed to the floor. The interval peak is
 * sampled finely enough that the answer does not depend on where the callback
 * boundaries fell.
 *
 * It is still a MEASUREMENT, not a needle position. How fast a bar falls is
 * decided here, by the ballistics in components/daw/meterBallistics.ts, and
 * deliberately not in the engine: an engine-side release turned out to be
 * slower than this one, so it quietly took the decay over and a muted track
 * kept a bus meter gliding down for seconds after it had gone silent.
 *
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
 * The click's needle values. NOT interval-maxed like the peaks above: the
 * engine already took the loudest sample over the same interval, so holding it
 * again here would stop the bar ever coming down.
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
  clickIntervalPeakDbL?: number;
  clickIntervalPeakDbR?: number;
  tracks?: { peakDb?: number; peakDbL?: number; peakDbR?: number }[];
  meters?: {
    id: string;
    peakDb?: number;
    peakDbL?: number;
    peakDbR?: number;
    intervalPeakDbL?: number;
    intervalPeakDbR?: number;
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
  if (frame.clickIntervalPeakDbL !== undefined && Number.isFinite(frame.clickIntervalPeakDbL)) {
    clickNeedleL = frame.clickIntervalPeakDbL;
    changed = true;
  }
  if (frame.clickIntervalPeakDbR !== undefined && Number.isFinite(frame.clickIntervalPeakDbR)) {
    clickNeedleR = frame.clickIntervalPeakDbR;
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
        needleDbL: m.intervalPeakDbL ?? peakDbL,
        needleDbR: m.intervalPeakDbR ?? peakDbR,
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

export type LiveTransportState = {
  playing: boolean;
  playheadSeconds: number;
  bpm: number;
  songIndex: number;
  globalPlayheadSeconds: number;
  /** Drift-correction factor from MasterClock (1.0 = no drift). v6+ only; 1.0 when frame is older. */
  drift: number;
  /** True only when drift came from a real v6 frame (not a v5 fallback of 1.0). */
  hasDrift: boolean;
};

let transportListeners: ((s: LiveTransportState) => void)[] = [];

export function subscribeLiveTransport(listener: (s: LiveTransportState) => void): () => void {
  transportListeners.push(listener);
  return () => {
    transportListeners = transportListeners.filter((l) => l !== listener);
  };
}

/**
 * Per-strip mute/solo flags decoded from the v5 UDP/WS binary frame.
 *
 * These are structural mixer state (solo/mute/soloActiveInGroup), and in
 * embedded (UDP) mode they were previously only refreshed by the 1 s
 * /api/v1/state poll -- which is why toggling solo felt laggy. Shipping them
 * in the same 60 Hz binary frame as the peaks makes them respond at paint
 * rate. Each array is index-aligned with the corresponding `state.tracks` /
 * `state.busses` row.
 */
export type LiveMixerFlags = {
  tracks: { mute: boolean; solo: boolean; soloActiveInGroup: boolean }[];
  busses: { mute: boolean; solo: boolean; soloActiveInGroup: boolean }[];
};

let mixerFlagsListeners: ((f: LiveMixerFlags) => void)[] = [];

/**
 * Wall-clock timestamp (Date.now()) of the last v5 UDP mixer-flags publish.
 * 0 means no v5 frame has been seen yet (e.g. older core without v5 support).
 * Exported so callers can decide whether UDP flags are the authoritative source
 * for mute/solo and should win over a slower HTTP state poll.
 */
let lastMixerFlagsMs = 0;
export function getLastMixerFlagsMs(): number {
  return lastMixerFlagsMs;
}

export function subscribeLiveMixerFlags(listener: (f: LiveMixerFlags) => void): () => void {
  mixerFlagsListeners.push(listener);
  return () => {
    mixerFlagsListeners = mixerFlagsListeners.filter((l) => l !== listener);
  };
}

function publishMixerFlags(flags: LiveMixerFlags): void {
  lastMixerFlagsMs = Date.now();
  for (let i = 0; i < mixerFlagsListeners.length; i++) {
    mixerFlagsListeners[i](flags);
  }
}

export interface LiveHealthState {
  cpuPercent: number;
  rssBytes: number;
  systemTotalBytes: number;
  cpuCoreCount: number;
}

type HealthListener = (health: LiveHealthState) => void;
let healthListeners: HealthListener[] = [];

export function subscribeLiveHealth(listener: HealthListener): () => void {
  healthListeners.push(listener);
  return () => {
    healthListeners = healthListeners.filter((l) => l !== listener);
  };
}

function publishLiveHealth(health: LiveHealthState): void {
  for (let i = 0; i < healthListeners.length; i++) {
    healthListeners[i](health);
  }
}

export function pushLiveBinaryFrame(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 24) return;
  const view = new DataView(buffer);
  const magic = view.getUint16(0, true);
  if (magic !== 0x5253) return;
  // Version 4: full transport state (playing, playhead, bpm, songIndex, globalPlayheadSeconds).
  const version = view.getUint8(2);

  const clickL = view.getFloat32(8, true);
  const clickR = view.getFloat32(12, true);

  const isV4 = version >= 4;
  const hasIntervalPeak = version >= 3;

  if (isV4) {
    const flags = view.getUint8(3);
    const playing = (flags & 1) !== 0;
    const playheadSeconds = view.getFloat32(4, true);
    const bpm = view.getFloat32(24, true);
    const songIndex = view.getInt16(28, true);
    const globalPlayheadSeconds = view.getFloat32(30, true);
    // v6+: driftFactor at offset 34. v5 and earlier: field absent → 1.0.
    const drift = version >= 6 ? view.getFloat32(34, true) : 1.0;

    setTransportPlaying(playing);

    const ts: LiveTransportState = {
      playing,
      playheadSeconds,
      bpm,
      songIndex,
      globalPlayheadSeconds,
      drift,
      hasDrift: version >= 6,
    };
    for (let i = 0; i < transportListeners.length; i++) {
      transportListeners[i](ts);
    }
  }

  // Version 7: live health metrics (CPU%, RAM, total RAM, core count).
  if (version >= 7) {
    const cpuPercent = view.getFloat32(38, true);
    const ramMb = view.getFloat32(42, true);
    const totalRamMb = view.getFloat32(46, true);
    const cpuCoreCount = view.getUint16(50, true);

    const hs: LiveHealthState = {
      cpuPercent,
      rssBytes: ramMb * 1024 * 1024,
      systemTotalBytes: totalRamMb * 1024 * 1024,
      cpuCoreCount,
    };
    publishLiveHealth(hs);
  }

  // v7: header is 60 bytes (counts at 52). v6: 46 bytes (counts at 38). v5: 42 bytes (counts at 34).
  // Older formats use different layouts (v3: 24, v2: 16).
  const countsAt = version >= 7 ? 52 : (version >= 6 ? 38 : (isV4 ? 34 : (hasIntervalPeak ? 24 : 16)));
  const numTracks = view.getUint16(countsAt, true);
  const numMeters = view.getUint16(countsAt + 2, true);
  const numLights = view.getUint16(countsAt + 4, true);

  latestClickL = clickL;
  latestClickR = clickR;
  latestClick = Math.max(clickL, clickR);
  if (latestClick > pendingClickMax) pendingClickMax = latestClick;
  if (clickL > pendingClickMaxL) pendingClickMaxL = clickL;
  if (clickR > pendingClickMaxR) pendingClickMaxR = clickR;
  clickNeedleL = hasIntervalPeak ? view.getFloat32(16, true) : clickL;
  clickNeedleR = hasIntervalPeak ? view.getFloat32(20, true) : clickR;

  let offset = version >= 7 ? 60 : (version >= 6 ? 46 : (isV4 ? 42 : (hasIntervalPeak ? 32 : 24)));

  const nextTracks: LiveLevels["tracks"] = [];
  for (let i = 0; i < numTracks; i++) {
    if (offset + 8 > buffer.byteLength) break;
    const pL = view.getFloat32(offset, true);
    const pR = view.getFloat32(offset + 4, true);
    offset += 8;
    nextTracks.push({ peakDb: Math.max(pL, pR), peakDbL: pL, peakDbR: pR });
  }
  tracks = nextTracks;

  const meterRowBytes = hasIntervalPeak ? 16 : 8;
  const nextMeters: LiveMeter[] = [];
  for (let i = 0; i < numMeters; i++) {
    if (offset + meterRowBytes > buffer.byteLength) break;
    const pL = view.getFloat32(offset, true);
    const pR = view.getFloat32(offset + 4, true);
    const nL = hasIntervalPeak ? view.getFloat32(offset + 8, true) : pL;
    const nR = hasIntervalPeak ? view.getFloat32(offset + 12, true) : pR;
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

  // v5+: per-track and per-bus mixer flags (mute/solo/soloActiveInGroup),
  // placed between the meter rows and the LED block.
  // v7 shifts numBusses from 44 → 58 (due to health in header).
  // v6 shifts numBusses from 40 → 44 (due to driftFactor in header).
  if (version >= 5) {
    const numBussesOffset = version >= 7 ? 58 : (version >= 6 ? 44 : 40);
    const numBusses = view.getUint16(numBussesOffset, true);
    const decode = (raw: number) => ({
      mute: (raw & 1) !== 0,
      solo: (raw & 2) !== 0,
      soloActiveInGroup: (raw & 4) !== 0,
    });
    const flagTracks: LiveMixerFlags["tracks"] = [];
    for (let i = 0; i < numTracks; i++) {
      if (offset + 1 > buffer.byteLength) break;
      flagTracks.push(decode(view.getUint8(offset)));
      offset += 1;
    }
    const flagBusses: LiveMixerFlags["busses"] = [];
    for (let i = 0; i < numBusses; i++) {
      if (offset + 1 > buffer.byteLength) break;
      flagBusses.push(decode(view.getUint8(offset)));
      offset += 1;
    }
    publishMixerFlags({ tracks: flagTracks, busses: flagBusses });
  }

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
