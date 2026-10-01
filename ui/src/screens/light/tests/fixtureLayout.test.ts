/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { LightFixtureRow } from "@/lib/state/types";
import { autoLayoutPositions, findDmxChannelConflicts } from "@/screens/light/logic/fixtureLayout";

function genericFixture(
  id: string,
  universe: number,
  startChannel: number,
  channelCount: number,
): LightFixtureRow {
  return {
    id,
    kind: "dmx::generic",
    dmx: { universe, startChannel, channelCount },
  } as LightFixtureRow;
}

describe("lighting fixture layout", () => {
  it("centers fixtures with the backend's two-metre spacing", () => {
    expect(autoLayoutPositions([])).toEqual([]);
    expect(autoLayoutPositions([{ id: "one" } as LightFixtureRow])).toEqual([
      { id: "one", posX: 0, posZ: 0 },
    ]);
    expect(
      autoLayoutPositions(
        ["a", "b", "c"].map((id) => ({ id }) as LightFixtureRow),
      ),
    ).toEqual([
      { id: "a", posX: -2, posZ: 0 },
      { id: "b", posX: 0, posZ: 0 },
      { id: "c", posX: 2, posZ: 0 },
    ]);
  });

  it("flags only overlapping generic DMX ranges in the same universe", () => {
    const fixtures = [
      genericFixture("first", 1, 1, 10),
      genericFixture("overlap", 1, 10, 4),
      genericFixture("adjacent", 1, 14, 2),
      genericFixture("other-universe", 2, 4, 20),
    ];
    expect([...findDmxChannelConflicts(fixtures)].sort()).toEqual([
      "first",
      "overlap",
    ]);
  });

  it("treats zero-length DMX ranges as one channel", () => {
    expect(
      [...findDmxChannelConflicts([
        genericFixture("zero", 1, 5, 0),
        genericFixture("same", 1, 5, 1),
      ])].sort(),
    ).toEqual(["same", "zero"]);
  });
});
