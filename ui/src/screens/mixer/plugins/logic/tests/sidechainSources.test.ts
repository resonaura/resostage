/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { BusRow, TrackRow } from "@/lib/state/types";
import { pluginSidechainSources } from "@/screens/mixer/plugins/logic/sidechainSources";

const track = (overrides: Partial<TrackRow> & Pick<TrackRow, "id" | "name">): TrackRow => ({
  channels: 2,
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  soloGroup: "sources",
  soloActiveInGroup: false,
  output: { type: "main", sends: [] },
  peakDb: -120,
  ...overrides,
});

const bus = (overrides: Partial<BusRow> & Pick<BusRow, "id" | "name">): BusRow => ({
  gainDb: 0,
  mute: false,
  solo: false,
  soloGroup: "sends",
  soloActiveInGroup: false,
  isAux: true,
  startChannel: 0,
  channels: 2,
  peakDb: -120,
  ...overrides,
});

describe("pluginSidechainSources", () => {
  it("offers rendered tracks and project buses but excludes self, MIDI-only rows, and direct outs", () => {
    const sources = pluginSidechainSources([
      track({ id: "track-1", stripId: "audio-track-1", name: "Kick", kind: "audio" }),
      track({ id: "track-2", stripId: "audio-track-2", name: "Bass", kind: "instrument" }),
      track({ id: "track-3", name: "External MIDI", kind: "externalMidi" }),
      track({ id: "track-4", name: "Destination", kind: "audio" }),
    ], [
      bus({ id: "audio::send:1", name: "Drum Bus" }),
      bus({ id: "audio::out:1", name: "Output 1", isDirectOut: true }),
    ], "audio-track-2");

    expect(sources).toEqual([
      { id: "audio-track-1", label: "Track · Kick" },
      { id: "track-4", label: "Track · Destination" },
      { id: "audio::send:1", label: "Bus · Drum Bus" },
    ]);
  });

  it("deduplicates aliases with the same effective strip ID", () => {
    const sources = pluginSidechainSources([
      track({ id: "alias-a", stripId: "shared-strip", name: "First", kind: "audio" }),
      track({ id: "alias-b", stripId: "shared-strip", name: "Second", kind: "audio" }),
    ], [], "destination");

    expect(sources).toEqual([{ id: "shared-strip", label: "Track · First" }]);
  });
});
