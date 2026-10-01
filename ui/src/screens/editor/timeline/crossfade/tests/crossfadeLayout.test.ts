/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { MIN_CROSSFADE_SECONDS } from "@/screens/editor/timeline/crossfade/logic/crossfade";
import { buildCrossfadeLayout } from "@/screens/editor/timeline/crossfade/logic/crossfadeLayout";

describe("timeline crossfade layout", () => {
  it("orders regions and derives adjacent visible joins", () => {
    const layout = buildCrossfadeLayout([
      { region: { id: "later" }, geom: { start: 2, duration: 3 } },
      { region: { id: "first" }, geom: { start: 0, duration: 3 } },
      { region: { id: "last" }, geom: { start: 6, duration: 1 } },
    ]);

    expect(
      layout.pairs.map(({ earlier, later, overlap }) => [
        earlier.region.id,
        later.region.id,
        overlap,
      ]),
    ).toEqual([["first", "later", 1]]);
    expect(layout.crossfadedOut).toEqual(new Set(["first"]));
    expect(layout.crossfadedIn).toEqual(new Set(["later"]));
  });

  it("ignores buried regions and overlaps below the audible threshold", () => {
    const buried = buildCrossfadeLayout([
      { region: { id: "outer" }, geom: { start: 0, duration: 10 } },
      { region: { id: "inner" }, geom: { start: 2, duration: 2 } },
    ]);
    const sliver = buildCrossfadeLayout([
      {
        region: { id: "first" },
        geom: { start: 0, duration: 2 + MIN_CROSSFADE_SECONDS / 2 },
      },
      { region: { id: "second" }, geom: { start: 2, duration: 1 } },
    ]);

    expect(buried.pairs).toEqual([]);
    expect(sliver.pairs).toEqual([]);
  });
});
