import { describe, expect, it } from "vitest";
import {
  healthPressure,
  nextHigherTier,
  nextLowerTier,
  stepAuto,
  type AutoState,
  type HealthSample,
  type PerformanceTier,
} from "./performance";

const start = (effective: PerformanceTier = "full"): AutoState => ({
  effective,
  slowSeconds: 0,
  goodSeconds: 0,
});

/** Feed `seconds` identical seconds through the ladder. */
function run(
  state: AutoState,
  seconds: number,
  input: { ceiling: PerformanceTier; p95FrameMs: number; pressure: boolean },
): AutoState {
  let s = state;
  for (let i = 0; i < seconds; i++) s = stepAuto(s, input);
  return s;
}

const HEALTHY = { ceiling: "full" as const, p95FrameMs: 16, pressure: false };
const STRUGGLING = {
  ceiling: "full" as const,
  p95FrameMs: 60,
  pressure: false,
};

describe("tier ladder", () => {
  it("steps down to the bottom and stops", () => {
    expect(nextLowerTier("full")).toBe("balanced");
    expect(nextLowerTier("balanced")).toBe("economy");
    expect(nextLowerTier("economy")).toBeNull();
  });

  it("never climbs above the user's ceiling", () => {
    expect(nextHigherTier("economy", "full")).toBe("balanced");
    expect(nextHigherTier("balanced", "balanced")).toBeNull();
    expect(nextHigherTier("economy", "economy")).toBeNull();
  });
});

describe("stepAuto", () => {
  it("holds steady while the machine is keeping up", () => {
    const s = run(start(), 60, HEALTHY);
    expect(s.effective).toBe("full");
  });

  it("does not drop for a brief hitch", () => {
    // A project load or one GC pause must not cost the user their frame rate.
    let s = run(start(), 2, STRUGGLING);
    expect(s.effective).toBe("full");
    s = stepAuto(s, HEALTHY);
    expect(s.slowSeconds).toBe(0);
  });

  it("drops a tier after a sustained struggle", () => {
    const s = run(start(), 4, STRUGGLING);
    expect(s.effective).toBe("balanced");
  });

  it("keeps dropping while it stays bad, then bottoms out", () => {
    let s = run(start(), 4, STRUGGLING);
    expect(s.effective).toBe("balanced");
    s = run(s, 4, STRUGGLING);
    expect(s.effective).toBe("economy");
    s = run(s, 40, STRUGGLING);
    expect(s.effective).toBe("economy");
  });

  it("climbs back only after a much longer clean streak", () => {
    let s = run(start(), 4, STRUGGLING);
    expect(s.effective).toBe("balanced");
    s = run(s, 10, HEALTHY);
    expect(s.effective).toBe("balanced"); // not yet
    s = run(s, 10, HEALTHY);
    expect(s.effective).toBe("full");
  });

  it("treats backend pressure as struggling even when frames look fine", () => {
    // The disk-stall case: the UI thread is idle, the audio is breaking up.
    const s = run(start(), 4, {
      ceiling: "full",
      p95FrameMs: 16,
      pressure: true,
    });
    expect(s.effective).toBe("balanced");
  });

  it("applies a lowered ceiling immediately, without waiting out a streak", () => {
    const s = stepAuto(start("full"), {
      ceiling: "economy",
      p95FrameMs: 16,
      pressure: false,
    });
    expect(s.effective).toBe("economy");
  });
});

const health = (partial: Partial<HealthSample> = {}): HealthSample => ({
  cpuPercent: 10,
  underrunCount: 0,
  silentBlockCount: 0,
  streamStarveCount: 0,
  diskReadBytesPerSec: 0,
  diskWriteBytesPerSec: 0,
  ...partial,
});

describe("healthPressure", () => {
  it("says nothing on the first sample", () => {
    expect(healthPressure(null, health())).toBe(false);
  });

  it("ignores a healthy machine", () => {
    expect(healthPressure(health(), health({ cpuPercent: 40 }))).toBe(false);
  });

  it("reacts to a single stream starve", () => {
    // One is enough: it means audio already went silent.
    expect(healthPressure(health(), health({ streamStarveCount: 1 }))).toBe(
      true,
    );
  });

  it("reacts to silent blocks and underruns", () => {
    expect(healthPressure(health(), health({ silentBlockCount: 1 }))).toBe(true);
    expect(healthPressure(health(), health({ underrunCount: 1 }))).toBe(true);
  });

  it("reacts to a pegged CPU", () => {
    expect(healthPressure(health(), health({ cpuPercent: 95 }))).toBe(true);
  });

  it("reacts to heavy disk traffic, but not to ordinary streaming", () => {
    // Steady stem playback is a few MB/s and must not trip it.
    expect(
      healthPressure(health(), health({ diskReadBytesPerSec: 8 * 1024 * 1024 })),
    ).toBe(false);
    expect(
      healthPressure(
        health(),
        health({ diskReadBytesPerSec: 200 * 1024 * 1024 }),
      ),
    ).toBe(true);
  });

  it("counts read and write together", () => {
    expect(
      healthPressure(
        health(),
        health({
          diskReadBytesPerSec: 70 * 1024 * 1024,
          diskWriteBytesPerSec: 70 * 1024 * 1024,
        }),
      ),
    ).toBe(true);
  });
});
