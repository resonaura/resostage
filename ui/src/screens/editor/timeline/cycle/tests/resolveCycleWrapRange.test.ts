import { describe, expect, it } from "vitest";
import type { ProjectCycleRow } from "@/lib/state/types";
import { resolveCycleWrapRange } from "@/screens/editor/timeline/cycle/logic/resolveCycleWrapRange";

const cycle = (
  overrides: Partial<ProjectCycleRow> = {},
): ProjectCycleRow => ({
  active: true,
  skip: false,
  startSeconds: 4,
  endSeconds: 8,
  songIndex: 1,
  ...overrides,
});

describe("resolveCycleWrapRange", () => {
  it("converts sorted song-local locators to absolute project seconds", () => {
    expect(resolveCycleWrapRange(cycle(), [0, 32])).toEqual({
      loAbs: 36,
      hiAbs: 40,
    });
    expect(
      resolveCycleWrapRange(
        cycle({ startSeconds: 8, endSeconds: 4 }),
        [0, 32],
      ),
    ).toEqual({ loAbs: 36, hiAbs: 40 });
  });

  it("ignores inactive cycles, skip zones, and unset song indices", () => {
    expect(resolveCycleWrapRange(cycle({ active: false }), [0, 32])).toBeNull();
    expect(resolveCycleWrapRange(cycle({ skip: true }), [0, 32])).toBeNull();
    expect(resolveCycleWrapRange(cycle({ songIndex: -1 }), [0, 32])).toBeNull();
  });

  it("requires at least 50 ms between locators", () => {
    expect(
      resolveCycleWrapRange(
        cycle({ startSeconds: 1, endSeconds: 1.049 }),
        [0, 0],
      ),
    ).toBeNull();
    expect(
      resolveCycleWrapRange(
        cycle({ startSeconds: 1, endSeconds: 1.05 }),
        [0, 0],
      ),
    ).toEqual({ loAbs: 1, hiAbs: 1.05 });
  });

  it("uses zero when the selected song offset is unavailable", () => {
    expect(resolveCycleWrapRange(cycle({ songIndex: 3 }), [])).toEqual({
      loAbs: 4,
      hiAbs: 8,
    });
  });
});
