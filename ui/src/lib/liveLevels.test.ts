// @vitest-environment jsdom
//
// The binary telemetry decoder is the hot path the whole light preview hangs
// off: it runs on every frame off the wire, and it is now allowed to decide
// that a frame changed nothing and skip the work. These tests pin both halves
// of that decision -- an unchanged look must notify nobody, and a changed one
// must still land immediately -- because getting the first wrong burns CPU for
// no reason and getting the second wrong silently freezes the stage preview.

import { beforeEach, describe, expect, it } from "vitest";
import {
  getLiveLedOutputs,
  getLiveLevels,
  pushLiveBinaryFrame,
  setMeterIds,
  subscribeLiveLedOutputs,
} from "./liveLevels";

/** One v2 telemetry frame carrying only per-fixture LED rows. */
function buildFrame(fixtures: number[][][]): ArrayBuffer {
  const ledBytes = fixtures.reduce((n, leds) => n + 4 + leds.length * 3, 0);
  const buf = new ArrayBuffer(24 + ledBytes);
  const view = new DataView(buf);
  view.setUint16(0, 0x5253, true);
  view.setUint8(2, 2); // version 2 -- carries light rows
  view.setFloat32(4, 0, true); // playhead
  view.setFloat32(8, -120, true); // click L
  view.setFloat32(12, -120, true); // click R
  view.setUint16(16, 0, true); // tracks
  view.setUint16(18, 0, true); // meters
  view.setUint16(20, fixtures.length, true);
  let off = 24;
  fixtures.forEach((leds, idx) => {
    view.setUint16(off, idx, true);
    view.setUint16(off + 2, leds.length, true);
    off += 4;
    for (const [r, g, b] of leds) {
      view.setUint8(off, r);
      view.setUint8(off + 1, g);
      view.setUint8(off + 2, b);
      off += 3;
    }
  });
  return buf;
}

/** Let the shared frame driver run, so paint-rate notifications fan out. */
function nextFrames(count = 3): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

const RED = [255, 0, 0] as const;
const GREEN = [0, 255, 0] as const;

describe("pushLiveBinaryFrame — light rows", () => {
  let notifications = 0;
  let unsubscribe: () => void;

  beforeEach(() => {
    unsubscribe?.();
    notifications = 0;
    unsubscribe = subscribeLiveLedOutputs(() => {
      notifications += 1;
    });
  });

  it("decodes per-fixture LED colours", async () => {
    pushLiveBinaryFrame(buildFrame([[[...RED], [...GREEN]]]));
    await nextFrames();
    expect(getLiveLedOutputs()).toEqual([
      { fixtureIdx: 0, ledColors: [{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }] },
    ]);
    expect(notifications).toBeGreaterThan(0);
  });

  it("does not notify when consecutive frames carry the same colours", async () => {
    pushLiveBinaryFrame(buildFrame([[[...RED]]]));
    await nextFrames();
    const settled = notifications;

    // The backend only suppresses byte-identical WHOLE frames, so a moving
    // playhead over a static look resends these rows unchanged all show long.
    for (let i = 0; i < 5; i++) pushLiveBinaryFrame(buildFrame([[[...RED]]]));
    await nextFrames();

    expect(notifications).toBe(settled);
  });

  it("notifies again as soon as a colour actually changes", async () => {
    pushLiveBinaryFrame(buildFrame([[[...RED]]]));
    await nextFrames();
    const settled = notifications;

    pushLiveBinaryFrame(buildFrame([[[...GREEN]]]));
    await nextFrames();

    expect(notifications).toBeGreaterThan(settled);
    expect(getLiveLedOutputs()[0].ledColors[0]).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("keeps object identity for fixtures that did not change", async () => {
    pushLiveBinaryFrame(buildFrame([[[...RED]], [[...GREEN]]]));
    await nextFrames();
    const [fixtureA, fixtureB] = getLiveLedOutputs();

    // Only the second fixture moves.
    pushLiveBinaryFrame(buildFrame([[[...RED]], [[0, 0, 255]]]));
    await nextFrames();
    const [nextA, nextB] = getLiveLedOutputs();

    // This reference is exactly what useLiveFixtureColor compares to decide
    // whether a fixture needs re-rendering at all.
    expect(nextA).toBe(fixtureA);
    expect(nextB).not.toBe(fixtureB);
  });
});

/**
 * One v3 frame: click peaks plus the click's interval peak, and `meters`
 * rows each carrying last-callback peak L/R followed by interval peak L/R.
 */
function buildMeterFrame(
  click: { peakL: number; peakR: number; needleL: number; needleR: number },
  meters: { peakL: number; peakR: number; needleL: number; needleR: number }[],
): ArrayBuffer {
  const buf = new ArrayBuffer(32 + meters.length * 16);
  const view = new DataView(buf);
  view.setUint16(0, 0x5253, true);
  view.setUint8(2, 3);
  view.setFloat32(4, 0, true); // playhead
  view.setFloat32(8, click.peakL, true);
  view.setFloat32(12, click.peakR, true);
  view.setFloat32(16, click.needleL, true);
  view.setFloat32(20, click.needleR, true);
  view.setUint16(24, 0, true); // tracks
  view.setUint16(26, meters.length, true);
  view.setUint16(28, 0, true); // lights
  let off = 32;
  for (const m of meters) {
    view.setFloat32(off, m.peakL, true);
    view.setFloat32(off + 4, m.peakR, true);
    view.setFloat32(off + 8, m.needleL, true);
    view.setFloat32(off + 12, m.needleR, true);
    off += 16;
  }
  return buf;
}

/** The same two meters, in the v2 layout that carries no interval peak. */
function buildV2MeterFrame(
  meters: { peakL: number; peakR: number }[],
): ArrayBuffer {
  const buf = new ArrayBuffer(24 + meters.length * 8);
  const view = new DataView(buf);
  view.setUint16(0, 0x5253, true);
  view.setUint8(2, 2);
  view.setFloat32(4, 0, true);
  view.setFloat32(8, -120, true);
  view.setFloat32(12, -120, true);
  view.setUint16(16, 0, true);
  view.setUint16(18, meters.length, true);
  view.setUint16(20, 0, true);
  let off = 24;
  for (const m of meters) {
    view.setFloat32(off, m.peakL, true);
    view.setFloat32(off + 4, m.peakR, true);
    off += 8;
  }
  return buf;
}

describe("pushLiveBinaryFrame — the needle and the last-callback peak are separate", () => {
  beforeEach(() => {
    setMeterIds(["audio::main", "send::verb"]);
  });

  it("keeps the raw peak for the readout and the interval peak for the bar", () => {
    // These deliberately disagree: the peak is the last callback's, the other
    // is the loudest since this consumer last asked. A decoder that conflated
    // them would pass with equal values and fail on real audio.
    pushLiveBinaryFrame(
      buildMeterFrame(
        { peakL: -3, peakR: -4, needleL: -9, needleR: -10 },
        [
          { peakL: -6, peakR: -7, needleL: -20, needleR: -21 },
          { peakL: -30, peakR: -31, needleL: -40, needleR: -41 },
        ],
      ),
    );

    const live = getLiveLevels();
    expect(live.meters.map((m) => m.id)).toEqual(["audio::main", "send::verb"]);
    expect(live.meters[0].peakDbL).toBeCloseTo(-6);
    expect(live.meters[0].peakDbR).toBeCloseTo(-7);
    expect(live.meters[0].needleDbL).toBeCloseTo(-20);
    expect(live.meters[0].needleDbR).toBeCloseTo(-21);
    expect(live.meters[1].needleDbL).toBeCloseTo(-40);
    expect(live.clickPeakDbL).toBeCloseTo(-3);
    expect(live.clickNeedleDbL).toBeCloseTo(-9);
    expect(live.clickNeedleDbR).toBeCloseTo(-10);
  });

  it("takes the engine's interval peak as-is rather than re-holding it", () => {
    // The click peak holds the loudest thing since the last paint, because a
    // tick can be shorter than a frame. The needle must NOT: the engine
    // already maxed over the same interval, and holding it again here would
    // stop the bar ever coming down.
    pushLiveBinaryFrame(
      buildMeterFrame({ peakL: -3, peakR: -3, needleL: -3, needleR: -3 }, []),
    );
    pushLiveBinaryFrame(
      buildMeterFrame({ peakL: -60, peakR: -60, needleL: -8, needleR: -8 }, []),
    );

    const live = getLiveLevels();
    expect(live.clickNeedleDbL).toBeCloseTo(-8);
    expect(live.clickPeakDbL).toBeCloseTo(-3);
  });

  it("falls back to the peak when the sender has no interval peak to give", () => {
    // A v2 backend against a v3 bundle only happens across a dev reload, but
    // it must degrade to the old behaviour rather than to garbage read off the
    // wrong offsets.
    pushLiveBinaryFrame(
      buildV2MeterFrame([
        { peakL: -12, peakR: -13 },
        { peakL: -14, peakR: -15 },
      ]),
    );

    const live = getLiveLevels();
    expect(live.meters).toHaveLength(2);
    expect(live.meters[0].needleDbL).toBeCloseTo(-12);
    expect(live.meters[0].needleDbR).toBeCloseTo(-13);
    expect(live.meters[1].needleDbL).toBeCloseTo(-14);
  });
});
