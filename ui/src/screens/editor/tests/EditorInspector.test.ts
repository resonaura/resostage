// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSPECTOR_2_25_WIDTH,
  DEFAULT_INSPECTOR_2_3_WIDTH,
  DEFAULT_INSPECTOR_OVERFLOW_WIDTH,
  DEFAULT_INSPECTOR_WIDTH,
  resolveInspectorBusses,
} from "../logic/inspectorRouting";
import type { BusRow, TrackRow } from "../../../lib/state/types";

describe("resolveInspectorBusses", () => {
  const masterBus: BusRow = {
    id: "audio::main",
    name: "Master",
    gainDb: 0,
    mute: false,
    solo: false,
    soloGroup: "main",
    soloActiveInGroup: false,
    isAux: false,
    startChannel: 0,
    channels: 2,
    peakDb: -100,
  };

  const send1FoldsToMaster: BusRow = {
    id: "audio::send:1",
    name: "Send 1 (Reverb)",
    gainDb: 0,
    mute: false,
    solo: false,
    soloGroup: "sends",
    soloActiveInGroup: false,
    isAux: true,
    startChannel: 0, // matches master -> folds to master
    channels: 2,
    peakDb: -100,
  };

  const send2DirectHardware: BusRow = {
    id: "audio::send:2",
    name: "Send 2 (IEM)",
    gainDb: 0,
    mute: false,
    solo: false,
    soloGroup: "sends",
    soloActiveInGroup: false,
    isAux: true,
    startChannel: 4, // physical out 5/6 -> does NOT fold to master
    channels: 2,
    peakDb: -100,
  };

  const defaultBusses = [masterBus, send1FoldsToMaster, send2DirectHardware];

  it("1. Track routing to physical outs (ext-out) with NO sends shows ONLY track strip", () => {
    const track: TrackRow = {
      id: "audio::track:1",
      name: "Guitar Direct",
      channels: 2,
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      soloGroup: "sources",
      soloActiveInGroup: false,
      output: {
        type: "ext-out",
        target: "audio::out:3,audio::out:4",
        sends: [],
      },
      peakDb: -100,
    };

    const res = resolveInspectorBusses({
      selectedTrack: track,
      busses: defaultBusses,
    });

    expect(res.sendBusses).toEqual([]);
    expect(res.showMaster).toBe(false);
    expect(res.stripCount).toBe(1);
    expect(res.computedWidth).toBe(120);
  });

  it("2. Track routing to physical outs (ext-out) with send that folds to Master shows track, send, and master", () => {
    const track: TrackRow = {
      id: "audio::track:1",
      name: "Vocals",
      channels: 2,
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      soloGroup: "sources",
      soloActiveInGroup: false,
      output: {
        type: "ext-out",
        target: "audio::out:1,audio::out:2",
        sends: [{ bus: "audio::send:1", level: 80, enabled: true }],
      },
      peakDb: -100,
    };

    const res = resolveInspectorBusses({
      selectedTrack: track,
      busses: defaultBusses,
    });

    expect(res.sendBusses.map((b) => b.id)).toEqual(["audio::send:1"]);
    expect(res.showMaster).toBe(true);
    expect(res.stripCount).toBe(3); // Track + Send 1 + Master
  });

  it("3. Track routing to physical outs (ext-out) with send that goes to hardware only shows track and send, NO master", () => {
    const track: TrackRow = {
      id: "audio::track:1",
      name: "Click Track",
      channels: 2,
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      soloGroup: "sources",
      soloActiveInGroup: false,
      output: {
        type: "ext-out",
        target: "audio::out:7,audio::out:8",
        sends: [{ bus: "audio::send:2", level: 100, enabled: true }],
      },
      peakDb: -100,
    };

    const res = resolveInspectorBusses({
      selectedTrack: track,
      busses: defaultBusses,
    });

    expect(res.sendBusses.map((b) => b.id)).toEqual(["audio::send:2"]);
    expect(res.showMaster).toBe(false);
    expect(res.stripCount).toBe(2); // Track + Send 2
  });

  it("4. Track routing to Main (Master) with NO sends shows Track and Master", () => {
    const track: TrackRow = {
      id: "audio::track:1",
      name: "Synth",
      channels: 2,
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      soloGroup: "sources",
      soloActiveInGroup: false,
      output: {
        type: "main",
        sends: [],
      },
      peakDb: -100,
    };

    const res = resolveInspectorBusses({
      selectedTrack: track,
      busses: defaultBusses,
    });

    expect(res.sendBusses).toEqual([]);
    expect(res.showMaster).toBe(true);
    expect(res.stripCount).toBe(2); // Track + Master
    expect(res.computedWidth).toBe(216);
  });

  it("5. Track routing to Main (Master) with multiple sends shows Track, all sends in order, and Master", () => {
    const track: TrackRow = {
      id: "audio::track:1",
      name: "Lead Vocal",
      channels: 2,
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      soloGroup: "sources",
      soloActiveInGroup: false,
      output: {
        type: "main",
        sends: [
          { bus: "audio::send:2", level: 75, enabled: true },
          { bus: "audio::send:1", level: 90, enabled: true },
        ],
      },
      peakDb: -100,
    };

    const res = resolveInspectorBusses({
      selectedTrack: track,
      busses: defaultBusses,
    });

    expect(res.sendBusses.map((b) => b.id)).toEqual([
      "audio::send:2",
      "audio::send:1",
    ]);
    expect(res.showMaster).toBe(true);
    expect(res.stripCount).toBe(4); // Track + Send 2 + Send 1 + Master
    expect(res.computedWidth).toBe(424);
  });

  describe("inspector layout dimensions", () => {
    it("matches exact 2-track width for <= 2 strips", () => {
      // 8px pad-left + 96px (T1) + 8px gap + 96px (T2) + 8px pad-right + 2px borders = 218px
      expect(DEFAULT_INSPECTOR_WIDTH).toBe(218);
    });

    it("calculates exact 2.25 tracks peek", () => {
      // 8px pad-left + 96px (T1) + 8px gap + 96px (T2) + 8px gap + 24px (0.25 of T3) + 2px borders = 242px
      expect(DEFAULT_INSPECTOR_2_25_WIDTH).toBe(242);
      const peek = DEFAULT_INSPECTOR_2_25_WIDTH - 2 - (8 + 96 + 8 + 96 + 8);
      expect(peek).toBe(24);
      expect(peek / 96).toBe(0.25);
    });

    it("calculates exact 2.3 tracks peek", () => {
      // 8px pad-left + 96px (T1) + 8px gap + 96px (T2) + 8px gap + 29px (0.30 of T3) + 2px borders = 247px
      expect(DEFAULT_INSPECTOR_2_3_WIDTH).toBe(247);
      const peek = DEFAULT_INSPECTOR_2_3_WIDTH - 2 - (8 + 96 + 8 + 96 + 8);
      expect(peek).toBe(29);
      expect(Math.round((peek / 96) * 100) / 100).toBe(0.3);
      expect(DEFAULT_INSPECTOR_OVERFLOW_WIDTH).toBe(
        DEFAULT_INSPECTOR_2_3_WIDTH,
      );
    });
  });
});
