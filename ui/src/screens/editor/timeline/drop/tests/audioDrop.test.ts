/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { computeAudioDropPosition } from "@/screens/editor/timeline/drop/logic/audioDrop";

describe("timeline audio drop placement", () => {
  const baseArgs = {
    x: 170,
    y: 45,
    rows: [{ name: "Inst" }, { name: "Audio" }],
    tracks: [
      { id: "instrument-1", name: "Inst" },
      { id: "audio-1", name: "Audio" },
    ],
    songOffsets: [0, 10],
    songLengths: [10, 8],
    pxPerSec: 10,
    laneHeight: 40,
    previewDuration: 3,
  };

  it("maps the pointer to a track and song and clamps the preview to song end", () => {
    expect(computeAudioDropPosition(baseArgs)).toEqual({
      rowIndex: 1,
      trackIndex: 1,
      songIndex: 1,
      startPx: 150,
    });
  });

  it("rejects orphan rows that do not map to a staged track", () => {
    expect(
      computeAudioDropPosition({
        ...baseArgs,
        rows: [{ name: "Removed track" }],
      }),
    ).toBeNull();
  });

  it("maps a drop inside an automation pseudo-track back to its owning track", () => {
    expect(computeAudioDropPosition({
      ...baseArgs,
      y: 75,
      rowHeights: [100, 40],
    })).toMatchObject({ rowIndex: 0, trackIndex: 0 });
  });
});
