/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { mergeState } from "@/lib/state/mergeState";
import { emptyState, type TrackRow } from "@/lib/state/types";

describe("authoritative structural merging", () => {
  it("does not resurrect explicitly removed sends", () => {
    const track = { id: "track", output: { sends: [{ bus: "bus", level: 50 }] } } as TrackRow;
    const before = { ...emptyState, tracks: [track] };
    const after = mergeState(before, { tracks: [{ ...track, output: { ...track.output, sends: [] } }] });
    expect(after.tracks[0].output.sends).toEqual([]);
  });
  it("retains omitted structural arrays but clears explicit empty arrays", () => {
    const before = { ...emptyState, tracks: [{ id: "track" } as TrackRow] };
    expect(mergeState(before, { canUndo: true }).tracks).toBe(before.tracks);
    expect(mergeState(before, { tracks: [] }).tracks).toEqual([]);
  });
});
