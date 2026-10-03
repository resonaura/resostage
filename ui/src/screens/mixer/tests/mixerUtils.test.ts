/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { builder } from "@/lib/state/api";
import type { WebUiState } from "@/lib/state/types";
import { patchClickFields } from "@/screens/mixer/logic/mixerUtils";

vi.mock("@/lib/state/api", () => ({
  builder: { songUpdate: vi.fn() },
}));

describe("patchClickFields song-scoped tempo edits", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates BPM and meter on the active song while preserving its other settings", () => {
    const otherSong = {
      name: "Warmup",
      bpm: 118,
      mode: "wait",
      tsNum: 4,
      tsDen: 4,
      click: true,
      clickBusId: "audio::main",
      clickGainDb: 0,
      clickPan: 0,
      clickMono: false,
      clickName: "Click",
      clickSends: [],
    };
    const activeSong = {
      name: "Writetest",
      bpm: 94,
      mode: "auto",
      tsNum: 3,
      tsDen: 8,
      click: false,
      clickBusId: "audio::send:2",
      clickGainDb: -4,
      clickPan: 0.25,
      clickMono: true,
      clickName: "Guide",
      clickSends: [{ busId: "audio::send:1", level: 35, enabled: true }],
    };
    const state = {
      songIndex: 1,
      songs: [otherSong, activeSong],
      click: {
        enabled: false,
        name: "Guide",
        channels: 1,
        gainDb: -4,
        pan: 0.25,
        output: {
          type: "bus",
          target: "audio::send:2",
          sends: [{ bus: "audio::send:1", level: 35, enabled: true }],
        },
      },
    } as unknown as WebUiState;

    patchClickFields(state, { bpm: 132.5, tsNum: 7, tsDen: 8 });

    expect(builder.songUpdate).toHaveBeenCalledExactlyOnceWith({
      index: 1,
      name: "Writetest",
      bpm: 132.5,
      mode: "auto",
      tsNum: 7,
      tsDen: 8,
      click: false,
      clickBusId: "audio::send:2",
      clickGainDb: -4,
      clickPan: 0.25,
      clickMono: true,
      clickName: "Guide",
      clickSends: [
        {
          busId: "audio::send:1",
          level: 35,
          enabled: true,
          preFader: undefined,
          tap: "post-pan",
        },
      ],
    });
  });
});
