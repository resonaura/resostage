// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { describe, expect, it } from "vitest";
import type {
  BusRow,
  MeterRow,
  SettingsState,
  TrackRow,
} from "@/lib/state/types";
import { areTrackStripPropsEqual } from "@/screens/mixer/strips/logic/trackStripMemo";
import type { TrackStripProps } from "@/screens/mixer/strips/types";

const settings: SettingsState = {
  currentOutputDevice: "Default Output",
  outputDevices: ["Default Output"],
  audioDrivers: ["CoreAudio"],
  currentAudioDriver: "CoreAudio",
  sampleRate: 48000,
  availableSampleRates: [48000],
  bufferSize: 512,
  availableBufferSizes: [512],
  outputChannelNames: ["Output 1", "Output 2"],
  activeOutputChannels: [true, true],
  midiOutputs: [],
  midiInputs: [],
  virtualMidiPortEnabled: false,
  keybindings: [],
  recentProjects: [],
};

const track: TrackRow = {
  id: "track-1",
  name: "Track 1",
  kind: "audio",
  channels: 2,
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  soloGroup: "sources",
  soloActiveInGroup: false,
  output: { type: "main", target: "audio::main", sends: [] },
  peakDb: -100,
  peakDbL: -100,
  peakDbR: -100,
};

const bus: BusRow = {
  id: "send-1",
  name: "Reverb",
  gainDb: 0,
  mute: false,
  solo: false,
  soloGroup: "sends",
  soloActiveInGroup: false,
  isAux: true,
  startChannel: 0,
  channels: 2,
  peakDb: -100,
  peakDbL: -100,
  peakDbR: -100,
};

const meter: MeterRow = {
  id: "track-1",
  peakDb: -100,
  shortTermLufs: -100,
};

const onDirectOutput = () => {};
const onOpenPlugins = () => {};

function props(overrides: Partial<TrackStripProps> = {}): TrackStripProps {
  return {
    t: track,
    index: 0,
    destinationBusses: [],
    allBusses: [],
    auxBusses: [],
    meters: [],
    settings,
    pluginCatalog: [],
    onDirectOutput,
    onOpenPlugins,
    ...overrides,
  };
}

describe("areTrackStripPropsEqual", () => {
  it("treats identical props as equal", () => {
    const current = props();
    expect(areTrackStripPropsEqual(current, current)).toBe(true);
  });

  it("ignores meter-only changes in track, bus, and meter rows", () => {
    const current = props({
      destinationBusses: [bus],
      allBusses: [bus],
      auxBusses: [bus],
      meters: [meter],
    });
    const updated: TrackStripProps = {
      ...current,
      t: { ...current.t, peakDb: -4, peakDbL: -7, peakDbR: -5 },
      destinationBusses: [{ ...bus, peakDb: -3 }],
      allBusses: [{ ...bus, peakDb: -3, peakDbL: -7, peakDbR: -5 }],
      auxBusses: [{ ...bus, peakDb: -3, peakDbL: -7, peakDbR: -5 }],
      meters: [{ ...meter, peakDb: -2, shortTermLufs: -12 }],
    };

    expect(areTrackStripPropsEqual(current, updated)).toBe(true);
  });

  it("invalidates when structural track or routing fields change", () => {
    const current = props({ destinationBusses: [bus] });
    expect(
      areTrackStripPropsEqual(
        current,
        {
          ...current,
          t: { ...current.t, mute: true },
        },
      ),
    ).toBe(false);
    expect(
      areTrackStripPropsEqual(
        current,
        {
          ...current,
          destinationBusses: [{ ...bus, name: "Delay" }],
        },
      ),
    ).toBe(false);
    expect(
      areTrackStripPropsEqual(current, {
        ...current,
        t: {
          ...current.t,
          output: { ...current.t.output, type: "bus", target: "send-1" },
        },
      }),
    ).toBe(false);
  });

  it("invalidates when strip-level inputs or callback identities change", () => {
    const current = props();
    expect(
      areTrackStripPropsEqual(current, { ...current, density: "wide" }),
    ).toBe(false);
    expect(
      areTrackStripPropsEqual(current, { ...current, settings: { ...settings } }),
    ).toBe(false);
    expect(
      areTrackStripPropsEqual(current, { ...current, onOpenPlugins: () => {} }),
    ).toBe(false);
  });
});
