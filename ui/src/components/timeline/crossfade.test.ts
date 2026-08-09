import { describe, expect, it } from "vitest";
import {
  CROSSFADE_SHAPES,
  crossfadeBetween,
  MAX_CROSSFADE_SECONDS,
  MIN_CROSSFADE_SECONDS,
  overlapSeconds,
  planTrackCrossfades,
  type CrossfadeRegion,
} from "./crossfade";

const region = (
  id: string,
  startSeconds: number,
  durationSeconds: number,
  extra: Partial<CrossfadeRegion> = {},
): CrossfadeRegion => ({
  id,
  trackId: "t1",
  startSeconds,
  durationSeconds,
  fadeInSeconds: 0,
  fadeOutSeconds: 0,
  fadeInCurve: 0,
  fadeOutCurve: 0,
  ...extra,
});

describe("overlapSeconds", () => {
  it("is zero for regions that only touch", () => {
    expect(overlapSeconds(region("a", 0, 4), region("b", 4, 4))).toBe(0);
  });

  it("measures a real overlap regardless of argument order", () => {
    const a = region("a", 0, 4);
    const b = region("b", 3, 4);
    expect(overlapSeconds(a, b)).toBeCloseTo(1);
    expect(overlapSeconds(b, a)).toBeCloseTo(1);
  });

  it("is zero when one region is buried inside another", () => {
    // Not a join: fading at its edges would duck the host region for no reason.
    expect(overlapSeconds(region("a", 0, 10), region("b", 2, 3))).toBe(0);
  });
});

describe("crossfadeBetween", () => {
  it("fades the earlier one out and the later one in, over the overlap", () => {
    const pair = crossfadeBetween(region("a", 0, 4), region("b", 3, 4));
    expect(pair).not.toBeNull();
    expect(pair!.earlier.regionId).toBe("a");
    expect(pair!.earlier.fadeOutSeconds).toBeCloseTo(1);
    expect(pair!.later.regionId).toBe("b");
    expect(pair!.later.fadeInSeconds).toBeCloseTo(1);
  });

  it("defaults to the equal-power shape on both sides", () => {
    const pair = crossfadeBetween(region("a", 0, 4), region("b", 3, 4))!;
    expect(pair.earlier.fadeOutCurve).toBe(CROSSFADE_SHAPES.equalPower);
    expect(pair.later.fadeInCurve).toBe(CROSSFADE_SHAPES.equalPower);
  });

  it("leaves the outer fades alone", () => {
    const a = region("a", 0, 4, { fadeInSeconds: 0.5, fadeInCurve: -0.2 });
    const b = region("b", 3, 4, { fadeOutSeconds: 0.8 });
    const pair = crossfadeBetween(a, b)!;
    expect(pair.earlier.fadeInSeconds).toBe(0.5);
    expect(pair.earlier.fadeInCurve).toBe(-0.2);
    expect(pair.later.fadeOutSeconds).toBe(0.8);
  });

  it("refuses regions on different tracks", () => {
    const b = region("b", 3, 4, { trackId: "t2" });
    expect(crossfadeBetween(region("a", 0, 4), b)).toBeNull();
  });

  it("ignores a sliver left behind by snapping", () => {
    const tiny = MIN_CROSSFADE_SECONDS / 2;
    expect(crossfadeBetween(region("a", 0, 4), region("b", 4 - tiny, 4))).toBe(
      null,
    );
  });

  it("never exceeds the shorter region", () => {
    // A long region dragged almost entirely over a very short one.
    const pair = crossfadeBetween(region("a", 0, 10), region("b", 9.5, 0.2));
    expect(pair).toBeNull(); // fully contained -- no join at all
    const partial = crossfadeBetween(region("a", 0, 10), region("b", 9.5, 1))!;
    expect(partial.later.fadeInSeconds).toBeLessThanOrEqual(1);
  });

  it("caps absurd overlaps", () => {
    const pair = crossfadeBetween(region("a", 0, 60), region("b", 10, 60))!;
    expect(pair.earlier.fadeOutSeconds).toBe(MAX_CROSSFADE_SECONDS);
  });
});

describe("planTrackCrossfades", () => {
  it("produces nothing when no regions overlap", () => {
    expect(
      planTrackCrossfades([region("a", 0, 4), region("b", 4, 4)]),
    ).toEqual([]);
  });

  it("writes both sides of a single join", () => {
    const plan = planTrackCrossfades([region("a", 0, 4), region("b", 3, 4)]);
    expect(plan.map((u) => u.regionId).sort()).toEqual(["a", "b"]);
  });

  it("keeps both joins when a region is overlapped on both sides", () => {
    // The middle region gets a fade-in from the left join and a fade-out from
    // the right one; emitting per-pair would have let the second overwrite it.
    const plan = planTrackCrossfades([
      region("a", 0, 4),
      region("b", 3, 4),
      region("c", 6, 4),
    ]);
    const middle = plan.find((u) => u.regionId === "b")!;
    expect(middle.fadeInSeconds).toBeCloseTo(1);
    expect(middle.fadeOutSeconds).toBeCloseTo(1);
  });

  it("does not touch regions whose fades already match", () => {
    const curve = CROSSFADE_SHAPES.equalPower;
    const a = region("a", 0, 4, { fadeOutSeconds: 1, fadeOutCurve: curve });
    const b = region("b", 3, 4, { fadeInSeconds: 1, fadeInCurve: curve });
    // Re-running after a drag that changed nothing must cost no writes, or
    // every pointer-up would push an undo step.
    expect(planTrackCrossfades([a, b])).toEqual([]);
  });

  it("is order independent", () => {
    const forward = planTrackCrossfades([region("a", 0, 4), region("b", 3, 4)]);
    const backward = planTrackCrossfades([region("b", 3, 4), region("a", 0, 4)]);
    expect(backward).toEqual(forward);
  });
});
