/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { mergeState } from "@/lib/state/mergeState";
import { emptyState, type BusRow, type TrackRow } from "@/lib/state/types";

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
  it("keeps UDP solo flags across repeated partial HTTP snapshots", () => {
    const solo = { id: "solo", solo: true, mute: false, soloSafe: false, soloActiveInGroup: true } as TrackRow;
    const dimmed = { id: "dimmed", solo: false, mute: false, soloSafe: false, soloActiveInGroup: true } as TrackRow;
    let state = { ...emptyState, tracks: [solo, dimmed] };
    for (let poll = 0; poll < 10; poll += 1) {
      state = mergeState(state, { tracks: [
        { id: "dimmed", gainDb: poll } as TrackRow,
        { id: "solo", gainDb: 0 } as TrackRow,
      ] });
      expect(state.tracks.map((row) => [row.id, row.solo, row.soloActiveInGroup]))
        .toEqual([["dimmed", false, true], ["solo", true, true]]);
      expect(state.tracks[0].gainDb).toBe(poll);
    }
  });
  it("preserves bus flags by identity but accepts explicit false and new identities", () => {
    const bus = { id: "bus", solo: true, mute: true, soloActiveInGroup: true } as BusRow;
    const before = { ...emptyState, busses: [bus] };
    const after = mergeState(before, { busses: [
      { id: "new" } as BusRow,
      { id: "bus", solo: false, mute: false, soloActiveInGroup: false } as BusRow,
    ] });
    expect(after.busses[0].solo).toBeUndefined();
    expect(after.busses[1].solo).toBe(false);
    expect(after.busses[1].mute).toBe(false);
  });
});
