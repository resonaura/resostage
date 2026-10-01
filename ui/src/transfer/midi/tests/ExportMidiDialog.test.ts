/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyState, type WebUiState } from "@/lib/state/types";
import { ExportMidiDialog } from "@/transfer/midi/components/ExportMidiDialog";

describe("ExportMidiDialog", () => {
  it("does not crash while closed when Core publishes a song with MIDI regions", () => {
    const state: WebUiState = {
      ...emptyState,
      songIndex: 0,
      songs: [{
        name: "Song", bpm: 120, mode: "auto" as const, tsNum: 4, tsDen: 4,
        click: false, clickBusId: "", clickSends: [], events: [],
        midiRegions: [{
          id: "r1", trackId: "t1", name: "Pattern", startBeats: 0,
          durationBeats: 4, clipOffsetBeats: 0, loop: false,
          loopLengthBeats: 4, notes: [],
        }],
      }],
    };
    expect(() => renderToString(createElement(ExportMidiDialog, {
      open: false, state, intent: { kind: "all-midi" }, onClose: () => {},
    }))).not.toThrow();
  });

  it("tolerates a partial project snapshot without the project-global track list", () => {
    const partialState = {
      ...emptyState,
      tracks: undefined,
      songs: [{
        name: "Song", bpm: 120, mode: "auto" as const, tsNum: 4, tsDen: 4,
        click: false, clickBusId: "", clickSends: [], events: [],
        midiRegions: [],
      }],
    } as unknown as WebUiState;
    expect(() => renderToString(createElement(ExportMidiDialog, {
      open: false, state: partialState, intent: { kind: "all-midi" }, onClose: () => {},
    }))).not.toThrow();
  });
});
