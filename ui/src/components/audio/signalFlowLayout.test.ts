import { describe, expect, it } from "vitest";
import {
  formatDb,
  formatPan,
  layerStrips,
  layoutSignalFlow,
  sourceChannelLabel,
  type MixGraphEdge,
  type MixGraphPayload,
  type MixGraphStrip,
  type MixStripKind,
} from "./signalFlowLayout";

function strip(
  id: string,
  kind: MixStripKind,
  extra: Partial<MixGraphStrip> = {},
): MixGraphStrip {
  return {
    id,
    name: id,
    kind,
    soloGroup:
      kind === "track" || kind === "click"
        ? "sources"
        : kind === "send"
          ? "sends"
          : kind === "main"
            ? "main"
            : "none",
    channels: 2,
    gainDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    audible: true,
    physicalChannel: kind === "output" ? 0 : -1,
    peakDb: -144,
    ...extra,
  };
}

function edge(from: string, to: string, extra: Partial<MixGraphEdge> = {}): MixGraphEdge {
  return {
    from,
    to,
    level: 100,
    preFader: false,
    active: true,
    sourceChannel: -1,
    ...extra,
  };
}

/** track -> main -> out:1, plus an aux that folds into main. */
function desk(): MixGraphPayload {
  return {
    strips: [
      strip("audio::track:1", "track"),
      strip("audio::click", "click"),
      strip("audio::send:1", "send"),
      strip("audio::main", "main"),
      strip("audio::out:1", "output", { channels: 1, physicalChannel: 0 }),
      strip("audio::out:2", "output", { channels: 1, physicalChannel: 1 }),
    ],
    edges: [
      edge("audio::track:1", "audio::main"),
      edge("audio::track:1", "audio::send:1", { level: 50 }),
      edge("audio::click", "audio::send:1"),
      edge("audio::send:1", "audio::main"),
      edge("audio::main", "audio::out:1", { sourceChannel: 0 }),
      edge("audio::main", "audio::out:2", { sourceChannel: 1 }),
    ],
  };
}

describe("layerStrips", () => {
  it("puts sources in the first column", () => {
    const columns = layerStrips(desk());
    expect(columns.get("audio::track:1")).toBe(0);
    expect(columns.get("audio::click")).toBe(0);
  });

  it("pushes a bus right of every strip feeding it", () => {
    const columns = layerStrips(desk());
    // send:1 is fed by sources (column 0), so it lands at 1; main is fed by
    // send:1, so it must land right of that -- not merely "column for a bus".
    expect(columns.get("audio::send:1")).toBe(1);
    expect(columns.get("audio::main")).toBe(2);
    expect(columns.get("audio::out:1")).toBe(3);
  });

  it("keeps a send that owns its outputs left of the lanes it feeds", () => {
    const payload: MixGraphPayload = {
      strips: [
        strip("audio::track:1", "track"),
        strip("audio::send:1", "send"),
        strip("audio::main", "main"),
        strip("audio::out:11", "output", { channels: 1, physicalChannel: 10 }),
      ],
      edges: [
        edge("audio::track:1", "audio::send:1"),
        edge("audio::send:1", "audio::out:11"),
      ],
    };
    const columns = layerStrips(payload);
    expect(columns.get("audio::send:1")).toBe(1);
    expect(columns.get("audio::out:11")).toBe(2);
    // Main has nothing routed into it, so it stays at the left edge rather
    // than being forced into a "master column" it has no signal in.
    expect(columns.get("audio::main")).toBe(0);
  });

  it("leaves an unrouted strip in column 0", () => {
    const payload: MixGraphPayload = {
      strips: [strip("audio::track:1", "track"), strip("audio::main", "main")],
      edges: [],
    };
    expect(layerStrips(payload).get("audio::main")).toBe(0);
  });

  it("handles an empty graph", () => {
    expect(layerStrips({ strips: [], edges: [] }).size).toBe(0);
  });
});

describe("layoutSignalFlow", () => {
  it("gives every strip a position and never overlaps within a column", () => {
    const placed = layoutSignalFlow(desk());
    expect(placed).toHaveLength(6);

    const byColumn = new Map<number, number[]>();
    for (const item of placed) {
      const ys = byColumn.get(item.column) ?? [];
      ys.push(item.y);
      byColumn.set(item.column, ys);
    }
    for (const ys of byColumn.values()) {
      expect(new Set(ys).size).toBe(ys.length);
    }
  });

  it("orders columns strictly left to right", () => {
    const placed = layoutSignalFlow(desk());
    const xOf = (id: string) => placed.find((p) => p.strip.id === id)!.x;
    expect(xOf("audio::track:1")).toBeLessThan(xOf("audio::send:1"));
    expect(xOf("audio::send:1")).toBeLessThan(xOf("audio::main"));
    expect(xOf("audio::main")).toBeLessThan(xOf("audio::out:1"));
  });

  it("centres shorter columns against the tallest one", () => {
    const placed = layoutSignalFlow(desk());
    // Column 0 has two strips, column 2 has one -- the lone one should sit
    // between them, not pinned to the top.
    const main = placed.find((p) => p.strip.id === "audio::main")!;
    const sources = placed.filter((p) => p.column === 0).map((p) => p.y);
    expect(main.y).toBeGreaterThan(Math.min(...sources));
    expect(main.y).toBeLessThan(Math.max(...sources));
  });

  it("survives an empty graph", () => {
    expect(layoutSignalFlow({ strips: [], edges: [] })).toEqual([]);
  });
});

describe("labels", () => {
  it("names the source channel only for a split stereo feed", () => {
    expect(sourceChannelLabel(0)).toBe("L");
    expect(sourceChannelLabel(1)).toBe("R");
    expect(sourceChannelLabel(-1)).toBeNull();
  });

  it("shows the engine's dB floor as silence", () => {
    expect(formatDb(-144)).toBe("−∞");
    expect(formatDb(Number.NEGATIVE_INFINITY)).toBe("−∞");
    expect(formatDb(0)).toBe("0.0");
    expect(formatDb(-6)).toBe("-6.0");
    expect(formatDb(3)).toBe("+3.0");
  });

  it("reads pan as a side and an amount", () => {
    expect(formatPan(0)).toBe("C");
    expect(formatPan(-1)).toBe("L100");
    expect(formatPan(0.5)).toBe("R50");
  });
});
