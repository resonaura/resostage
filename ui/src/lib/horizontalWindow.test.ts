import { describe, expect, it } from "vitest";
import { horizontalWindow, MIN_OVERSCAN_PX } from "./horizontalWindow";

const PITCH = 100;

describe("horizontalWindow", () => {
  it("mounts everything before the viewport has been measured", () => {
    // First render, before layout: 0 must not be read as "nothing is visible".
    const w = horizontalWindow({
      count: 40,
      pitchPx: PITCH,
      offsetPx: 0,
      viewportPx: 0,
      overscanPx: 0,
    });
    expect(w).toEqual({ start: 0, end: 40, padStartPx: 0, padEndPx: 0 });
  });

  it("keeps the row's total width identical to the unvirtualised one", () => {
    const count = 40;
    const w = horizontalWindow({
      count,
      pitchPx: PITCH,
      offsetPx: -2000,
      viewportPx: 500,
      overscanPx: 0,
    });
    const mounted = (w.end - w.start) * PITCH;
    expect(w.padStartPx + mounted + w.padEndPx).toBe(count * PITCH);
  });

  it("covers the whole viewport plus the overscan on both sides", () => {
    const viewportPx = 500;
    const offsetPx = -3000; // scrolled 3000px in
    const w = horizontalWindow({
      count: 200,
      pitchPx: PITCH,
      offsetPx,
      viewportPx,
      overscanPx: 0,
    });
    const overscan = Math.max(viewportPx, MIN_OVERSCAN_PX);
    // Everything the eye can reach is mounted...
    expect(w.start * PITCH).toBeLessThanOrEqual(-offsetPx - overscan);
    expect(w.end * PITCH).toBeGreaterThanOrEqual(
      -offsetPx + viewportPx + overscan,
    );
    // ...and the first visible item specifically.
    const firstVisible = Math.floor(-offsetPx / PITCH);
    expect(w.start).toBeLessThanOrEqual(firstVisible);
    expect(w.end).toBeGreaterThan(firstVisible);
  });

  it("never runs off either end of the list", () => {
    const atStart = horizontalWindow({
      count: 5,
      pitchPx: PITCH,
      offsetPx: 0,
      viewportPx: 500,
      overscanPx: 0,
    });
    expect(atStart.start).toBe(0);
    expect(atStart.end).toBe(5);
    expect(atStart.padStartPx).toBe(0);
    expect(atStart.padEndPx).toBe(0);

    const atEnd = horizontalWindow({
      count: 200,
      pitchPx: PITCH,
      offsetPx: -(200 * PITCH - 400),
      viewportPx: 400,
      overscanPx: 0,
    });
    expect(atEnd.end).toBe(200);
    expect(atEnd.padEndPx).toBe(0);
  });

  it("actually leaves items out once the row is long enough", () => {
    const w = horizontalWindow({
      count: 500,
      pitchPx: PITCH,
      offsetPx: -20000,
      viewportPx: 600,
      overscanPx: 0,
    });
    expect(w.start).toBeGreaterThan(0);
    expect(w.end).toBeLessThan(500);
    expect(w.end - w.start).toBeLessThan(500);
  });

  it("degenerates safely on an empty or unmeasured row", () => {
    expect(
      horizontalWindow({
        count: 0,
        pitchPx: PITCH,
        offsetPx: 0,
        viewportPx: 500,
        overscanPx: 0,
      }),
    ).toEqual({ start: 0, end: 0, padStartPx: 0, padEndPx: 0 });

    expect(
      horizontalWindow({
        count: 10,
        pitchPx: 0,
        offsetPx: 0,
        viewportPx: 500,
        overscanPx: 0,
      }),
    ).toEqual({ start: 0, end: 0, padStartPx: 0, padEndPx: 0 });
  });
});
