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
  pushLiveBinaryFrame,
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
