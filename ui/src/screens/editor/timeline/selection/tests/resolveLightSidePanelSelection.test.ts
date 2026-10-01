// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { describe, expect, it } from "vitest";
import type { LightCueRow, LightTrackRow, SongRow } from "@/lib/state/types";
import { resolveLightSidePanelSelection } from "@/screens/editor/timeline/selection/logic/resolveLightSidePanelSelection";

const tracks: LightTrackRow[] = [
  { id: "light-1", name: "Front Wash", fixtureIds: [] },
  { id: "light-2", name: "Back Wash", fixtureIds: [] },
];

const cue = {
  id: "cue-1",
  trackId: "light-2",
  startSeconds: 1,
  durationSeconds: 2,
} as LightCueRow;

describe("resolveLightSidePanelSelection", () => {
  it("returns no selection outside the light view", () => {
    expect(
      resolveLightSidePanelSelection({
        viewMode: "audio",
        cueSelection: null,
        sidePanelTrackIndex: null,
        songs: [],
        tracks,
      }),
    ).toBeNull();
  });

  it("prefers the selected cue and resolves its lighting track", () => {
    const songs = [{ lightCues: [cue] }] as unknown as SongRow[];

    expect(
      resolveLightSidePanelSelection({
        viewMode: "light",
        cueSelection: { songIndex: 0, cueId: "cue-1" },
        sidePanelTrackIndex: 0,
        songs,
        tracks,
      }),
    ).toEqual({
      type: "cue",
      songIndex: 0,
      cue,
      trackIndex: 1,
      track: tracks[1],
    });
  });

  it("falls back to the selected track when the cue is missing", () => {
    expect(
      resolveLightSidePanelSelection({
        viewMode: "light",
        cueSelection: { songIndex: 4, cueId: "missing" },
        sidePanelTrackIndex: 1,
        songs: [],
        tracks,
      }),
    ).toEqual({ type: "track", trackIndex: 1, track: tracks[1] });
  });

  it("defaults to the first track only when no track is explicitly selected", () => {
    expect(
      resolveLightSidePanelSelection({
        viewMode: "light",
        cueSelection: null,
        sidePanelTrackIndex: null,
        songs: [],
        tracks,
      }),
    ).toEqual({ type: "track", trackIndex: 0, track: tracks[0] });

    expect(
      resolveLightSidePanelSelection({
        viewMode: "light",
        cueSelection: null,
        sidePanelTrackIndex: null,
        songs: [],
        tracks: [],
      }),
    ).toBeNull();
  });
});
