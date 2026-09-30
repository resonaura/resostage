import { describe, expect, it } from "vitest";
import type { BusRow, MeterRow, WebUiState } from "../../../lib/state/types";
import { busMeterGroups } from "../logic/busMeterGroups";

const meter = (id: string): MeterRow => ({
  id,
  peakDb: -12,
  shortTermLufs: -18,
});

const bus = (startChannel: number, channels: number): BusRow => ({
  id: "mono-bus",
  name: "Mono bus",
  gainDb: 0,
  mute: false,
  solo: false,
  soloGroup: "sends",
  soloActiveInGroup: false,
  isAux: true,
  startChannel,
  channels,
  peakDb: -144,
});

const noTracks: WebUiState["tracks"] = [];

describe("busMeterGroups", () => {
  it("sorts direct lanes and groups adjacent odd/even pairs", () => {
    const groups = busMeterGroups(
      [meter("direct:4"), meter("audio::out:1"), meter("direct:3"), meter("direct:2")],
      [],
      noTracks,
    );

    expect(groups.map((group) => group.id)).toEqual(["out:1/2", "out:3/4"]);
    expect(groups.map((group) => group.meters.length)).toEqual([2, 2]);
  });

  it("keeps a standalone mono lane out of an adjacent stereo pair", () => {
    const groups = busMeterGroups(
      [meter("direct:1"), meter("direct:2")],
      [bus(0, 1)],
      noTracks,
    );

    expect(groups.map((group) => group.id)).toEqual(["out:1", "out:2"]);
    expect(groups.map((group) => group.meters.length)).toEqual([1, 1]);
  });
});
