/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectProps } from "@/components/ui/Select";
import type { BusRow, SettingsState } from "@/lib/state/types";
import { EXT_OUTPUT_VALUE, SENDS_ONLY_VALUE } from "@/screens/mixer/logic/constants";
import { TrackOutputRouting } from "@/screens/mixer/routing/components/TrackOutputRouting";
import { trackOutputDestinations } from "@/screens/mixer/routing/logic/directOutput";

// Exercise the routing owner without coupling these tests to popup internals.
vi.mock("@/components/ui", () => ({
  Select: ({ options, value, onChange, tone, ...props }: SelectProps) => (
    <select
      aria-label={props["aria-label"]}
      value={value}
      data-tone={tone}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.id} value={option.id} data-section={option.section}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

function bus(id: string, overrides: Partial<BusRow> = {}): BusRow {
  return {
    id, name: id, gainDb: 0, mute: false, solo: false, soloGroup: "none",
    soloActiveInGroup: false, isAux: false, startChannel: 0,
    channels: 2, peakDb: -100, ...overrides,
  };
}

const main = bus("audio::main", { name: "Main" });
const aux = bus("audio::bus:1", { name: "Aux", isAux: true });
const physical = bus("audio::out:1", { name: "Out 1", channels: 1 });
const synthetic = bus("hardware-row", {
  name: "Out 7/8", isDirectOut: true, startChannel: 6,
});
const allBusses = [physical, main, aux, synthetic];
const settings = {
  outputChannelNames: ["Left", "Right"], activeOutputChannels: [true, true],
} as SettingsState;

describe("track output picker destinations", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(busId: string) {
    act(() => root.render(createElement(TrackOutputRouting, {
      busId, busses: allBusses, allBusses, settings,
      onBusSelect: vi.fn(), onDirectOutput: vi.fn(),
    })));
    return container.querySelector('[aria-label="Track output"]') as HTMLSelectElement;
  }

  it("filters canonical and fabricated physical rows while retaining Main and aux buses", () => {
    expect(trackOutputDestinations(allBusses)).toEqual([main, aux]);
    const primary = render(main.id);
    expect(Array.from(primary.options, (option) => option.value)).toEqual([
      main.id, aux.id, SENDS_ONLY_VALUE, EXT_OUTPUT_VALUE,
    ]);
    expect(primary.value).toBe(main.id);
    expect(render(aux.id).value).toBe(aux.id);
    expect(render("").value).toBe(SENDS_ONLY_VALUE);
  });

  it("resolves a canonical lane to Ext. Out even when the lane also appears among buses", () => {
    expect(render(physical.id).value).toBe(EXT_OUTPUT_VALUE);
    const secondary = container.querySelector('[aria-label="Physical output"]') as HTMLSelectElement;
    expect(secondary).not.toBeNull();
    expect(secondary.value).toBe("p:0");
  });

  it("keeps a missing canonical stereo route in the dedicated physical picker", () => {
    expect(render("audio::out:7,audio::out:8").value).toBe(EXT_OUTPUT_VALUE);
    const secondary = container.querySelector('[aria-label="Physical output"]') as HTMLSelectElement;
    expect(secondary.selectedOptions[0].textContent).toBe("7/8");
    expect(secondary.selectedOptions[0].dataset.section).toBe("Unavailable");
    expect(secondary.dataset.tone).toBe("warning-soft");
  });

  it("resolves a fabricated physical mapping and preserves its missing channel pair", () => {
    expect(render(synthetic.id).value).toBe(EXT_OUTPUT_VALUE);
    const secondary = container.querySelector('[aria-label="Physical output"]') as HTMLSelectElement;
    expect(secondary.selectedOptions[0].textContent).toBe("7/8");
    expect(secondary.selectedOptions[0].dataset.section).toBe("Unavailable");
  });
});
