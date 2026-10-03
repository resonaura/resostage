/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MidiRegionRow } from "@/lib/state/types";
import { MidiRegionBlock } from "@/screens/editor/timeline/regions/components/MidiRegionBlock";

const midiRegion: MidiRegionRow = {
  id: "midi-region",
  trackId: "midi-track",
  name: "MIDI clip",
  startBeats: 0,
  durationBeats: 4,
  clipOffsetBeats: 0,
  loop: false,
  loopLengthBeats: 4,
  notes: [],
  events: [
    { beat: 0.5, status: 0xb0, data: [64, 1] },
    { beat: 1.5, status: 0xb0, data: [64, 0] },
    { beat: 2, status: 0xb1, data: [1, 96] },
  ],
};

describe("MIDI region controller preview", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelect = vi.fn();

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onSelect.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => root.render(createElement(MidiRegionBlock, {
      midiRegion,
      songIndex: 0,
      songBpm: 120,
      rowName: "Inst 1",
      rowColor: "#30d158",
      laneHeight: 56,
      verticalZoom: 1,
      pxPerSec: 120,
      tracks: [],
      onSelect,
    })));
  }

  it("renders arbitrary CC markers and named pedal spans in track color", () => {
    render();

    const markers = [...container.querySelectorAll<HTMLElement>("[title*='value']")];
    expect(markers).toHaveLength(3);
    expect(markers[0].title).toContain("CC 64 · Sustain");
    expect(markers[0].title).toContain("value 1");
    const arbitraryController = markers.find((element) => element.title.includes("CC 1"));
    expect(arbitraryController).toBeDefined();
    expect(arbitraryController!.title).not.toContain("Sustain");

    const heldSpan = [...container.querySelectorAll<HTMLElement>("[title*='held']")]
      .find((element) => element.title.includes("Sustain"));
    expect(heldSpan).toBeDefined();
    expect(heldSpan!.title).toContain("MIDI channel 1");
    expect(heldSpan!.style.backgroundColor).toBe("rgb(48, 209, 88)");
  });

  it("keeps controller overlays inside the normal region pointer-selection path", () => {
    render();
    const marker = container.querySelector<HTMLElement>("[title*='CC 1']");
    expect(marker).not.toBeNull();
    const region = container.querySelector<HTMLElement>("[data-region-block]")!;
    vi.spyOn(region, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 240, bottom: 56, width: 240, height: 56,
      x: 0, y: 0, toJSON: () => ({}),
    });

    marker!.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 120,
      clientY: 24,
    }));

    expect(onSelect).toHaveBeenCalledOnce();
  });
});
