import { describe, expect, it } from "vitest";
import {
  computeRegionDragGeom,
  MAX_REGION_SPEED,
  MIN_REGION_SPEED,
  regionDraftMatchesCommitted,
  regionFadeHandleAt,
  regionEdgeCursor,
  regionEdgeMode,
  type RegionDragCtx,
  type RegionDragSession,
  type RegionGeom,
} from "./regionDrag";
import type { RegionRow } from "../../lib/types";

const session = (
  partial: Partial<RegionDragSession> & Pick<RegionDragSession, "mode">,
): RegionDragSession => ({
  key: "0:r1",
  startX: 100,
  startY: 50,
  songIndex: 0,
  regionId: "r1",
  origStart: 10,
  origSourceOffset: 2,
  origDuration: 8,
  origFadeIn: 0,
  origFadeOut: 0,
  origFadeInCurve: 0,
  origFadeOutCurve: 0,
  origLoop: false,
  origLoopLength: 0,
  origSpeed: 1,
  maxEnd: 60,
  maxSourceDur: 30,
  lastGeom: {
    start: 10,
    sourceOffset: 2,
    duration: 8,
    speed: 1,
    fadeIn: 0,
    fadeOut: 0,
    fadeInCurve: 0,
    fadeOutCurve: 0,
    loop: false,
  },
  originRowIndex: 1,
  targetRowIndex: 1,
  originTrackId: "trk_a",
  ...partial,
});

const ctx: RegionDragCtx = {
  pxPerSec: 10,
  verticalZoom: 1,
  snapToGrid: false,
  rows: [
    { name: "A", color: "#fff", headerIndex: 0 },
    { name: "B", color: "#fff", headerIndex: 1 },
    { name: "C", color: "#fff", headerIndex: 2 },
  ],
  tracks: [
    {
      id: "trk_a",
      name: "A",
      channels: 1,
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      soloGroup: "sources",
      soloActiveInGroup: false,
      output: { type: "main", sends: [] },
      peakDb: -100,
    },
    {
      id: "trk_b",
      name: "B",
      channels: 1,
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      soloGroup: "sources",
      soloActiveInGroup: false,
      output: { type: "main", sends: [] },
      peakDb: -100,
    },
    {
      id: "trk_c",
      name: "C",
      channels: 1,
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      soloGroup: "sources",
      soloActiveInGroup: false,
      output: { type: "main", sends: [] },
      peakDb: -100,
    },
  ],
  songs: [
    {
      name: "S",
      bpm: 120,
      mode: "auto" as const,
      tsNum: 4,
      tsDen: 4,
      click: false,
      clickBusId: "m",
      clickSends: [],
      tracks: [],
      events: [],
    },
  ],
};

describe("regionEdgeMode", () => {
  it("maps left edge top to fadeIn and bottom to trimStart", () => {
    expect(regionEdgeMode(2, 5, 200, 40)).toBe("fadeIn");
    expect(regionEdgeMode(2, 20, 200, 40)).toBe("trimStart");
  });

  it("maps right edge zones", () => {
    expect(regionEdgeMode(195, 5, 200, 40)).toBe("fadeOut");
    expect(regionEdgeMode(195, 20, 200, 40)).toBe("loopTrim");
    expect(regionEdgeMode(195, 35, 200, 40)).toBe("trimEnd");
  });

  it("center is move with grab cursor", () => {
    expect(regionEdgeMode(100, 20, 200, 40)).toBe("move");
    expect(regionEdgeCursor(100, 20, 200, 40)).toBe("grab");
  });
});

describe("computeRegionDragGeom", () => {
  it("moves start by horizontal delta", () => {
    const rd = session({ mode: "move" });
    // +20px at 10 px/s = +2s
    const g = computeRegionDragGeom(rd, ctx, 120, 50);
    expect(g.start).toBeCloseTo(12);
    // Same lane → keep origin track id
    expect(g.trackId).toBe("trk_a");
  });

  it("crosses tracks on vertical travel", () => {
    const rd = session({
      mode: "move",
      originRowIndex: 1,
      originTrackId: "trk_b",
    });
    // LANE_HEIGHT * 1 at zoom 1 = 56px → one row down
    const g = computeRegionDragGeom(rd, ctx, 100, 50 + 56);
    expect(rd.targetRowIndex).toBe(2);
    expect(g.trackId).toBe("trk_c");
  });

  it("trims end without looping", () => {
    const rd = session({ mode: "trimEnd" });
    const g = computeRegionDragGeom(rd, ctx, 100 + 30, 50); // +3s
    expect(g.duration).toBeCloseTo(11);
    expect(g.loop).toBe(false);
  });
});

describe("regionDraftMatchesCommitted", () => {
  it("matches when geometry agrees", () => {
    const r: RegionRow = {
      id: "r1",
      trackId: "t",
      startSeconds: 1,
      durationSeconds: 4,
      gainDb: 0,
      source: { file: "a.wav", offsetSeconds: 0 },
      fade: { inSeconds: 0.1, outSeconds: 0 },
    };
    const d: RegionGeom = {
      start: 1,
      sourceOffset: 0,
      duration: 4,
      speed: 1,
      fadeIn: 0.1,
      fadeOut: 0,
      fadeInCurve: 0,
      fadeOutCurve: 0,
      loop: false,
      trackId: "t",
    };
    expect(regionDraftMatchesCommitted(r, d)).toBe(true);
    expect(regionDraftMatchesCommitted(r, { ...d, start: 2 })).toBe(false);
  });
});

describe("stretch", () => {
  // The trade the stretch tool makes: the region's length on the timeline
  // changes, the stretch of source it covers does not.
  const stretchSession = (over: Partial<RegionDragSession> = {}) =>
    session({ mode: "stretch", ...over });

  it("keeps the source span while the length changes", () => {
    const rd = stretchSession();
    // 8s region at 1x, dragged 40px right => 4s longer at pxPerSec 10.
    const g = computeRegionDragGeom(rd, ctx, 140, 50);
    expect(g.duration).toBeCloseTo(12, 3);
    expect(g.speed).toBeCloseTo(8 / 12, 3);
    expect(g.duration * g.speed).toBeCloseTo(8, 3); // the invariant
  });

  it("speeds the region up when squeezed", () => {
    const g = computeRegionDragGeom(stretchSession(), ctx, 60, 50); // 4s shorter
    expect(g.duration).toBeCloseTo(4, 3);
    expect(g.speed).toBeCloseTo(2, 3);
  });

  it("carries an existing speed through", () => {
    // Already at 2x: 8s of timeline is 16s of source, and that stays true.
    const g = computeRegionDragGeom(
      stretchSession({ origSpeed: 2 }),
      ctx,
      140,
      50,
    );
    expect(g.duration * g.speed).toBeCloseTo(16, 3);
  });

  it("clamps to the engine's speed range, and the length follows", () => {
    // Dragged far enough right to ask for a speed below the floor.
    const slow = computeRegionDragGeom(stretchSession(), ctx, 1000, 50);
    expect(slow.speed).toBeCloseTo(MIN_REGION_SPEED, 5);
    expect(slow.duration * slow.speed).toBeCloseTo(8, 3);
    // ...and far enough left to ask for more than the ceiling.
    const fast = computeRegionDragGeom(stretchSession(), ctx, 20, 50);
    expect(fast.speed).toBeLessThanOrEqual(MAX_REGION_SPEED);
    expect(fast.duration * fast.speed).toBeCloseTo(8, 3);
  });

  it("leaves the start and the source offset alone", () => {
    const g = computeRegionDragGeom(stretchSession(), ctx, 140, 50);
    expect(g.start).toBe(10);
    expect(g.sourceOffset).toBe(2);
  });
});

describe("regionFadeHandleAt", () => {
  // A 400px region with a 60px fade-in and an 80px fade-out.
  const at = (x: number) => regionFadeHandleAt(x, 400, 60, 80);

  it("grabs the point where the fade-in finishes", () => {
    expect(at(60)).toBe("fadeIn");
    expect(at(55)).toBe("fadeIn");
    expect(at(66)).toBe("fadeIn");
  });

  it("grabs the point where the fade-out begins", () => {
    expect(at(320)).toBe("fadeOut");
    expect(at(326)).toBe("fadeOut");
  });

  it("leaves the middle alone", () => {
    expect(at(200)).toBeNull();
  });

  it("offers nothing when there is no fade yet", () => {
    // Zero-length fades sit on the region's corners, which are already
    // handles -- two on one pixel is one too many.
    expect(regionFadeHandleAt(2, 400, 0, 0)).toBeNull();
    expect(regionFadeHandleAt(398, 400, 0, 0)).toBeNull();
  });
});
