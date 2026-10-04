/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationLaneRow, TrackRow } from "@/lib/state/types";
import { AutomationTrackHeader } from "@/screens/editor/timeline/automation/components/AutomationTrackHeader";

const track: TrackRow = {
  id: "track-1",
  name: "Lead",
  channels: 2,
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  soloGroup: "sources",
  soloActiveInGroup: false,
  output: { type: "main", sends: [] },
  peakDb: -60,
  plugins: [],
};

const lanes: AutomationLaneRow[] = ["faderGainDb", "pan"].map((parameterId, index) => ({
  id: `lane-${index + 1}`,
  target: {
    domain: "strip",
    entityId: "track-1",
    parameterId,
    valueType: parameterId === "pan" ? "floatNormalized" : "decibels",
    defaultValue: 0,
    minValue: parameterId === "pan" ? -1 : -60,
    maxValue: parameterId === "pan" ? 1 : 12,
  },
  scope: "track",
  writeMode: "read",
  enabled: true,
  muted: false,
  points: [],
}));

describe("AutomationTrackHeader", () => {
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

  it("renders independent foldable pseudo-track rows with one add action", () => {
    const onToggleLane = vi.fn();
    act(() => root.render(createElement(AutomationTrackHeader, {
      height: 56,
      visible: true,
      songIndex: 0,
      track,
      lanes,
      activeLaneId: "lane-1",
      onSelectLane: vi.fn(),
      collapseScope: "project:epoch:song",
      collapsedLaneKeys: new Set<string>(),
      onToggleLane,
    }, createElement("div", null, "Track controls"))));

    expect(container.querySelectorAll("[data-automation-lane-row]")).toHaveLength(2);
    expect(container.querySelector("[data-automation-lane-row='lane-1']")).not.toBeNull();
    expect(container.querySelector("[data-automation-lane-row='lane-2']")).not.toBeNull();
    expect(container.querySelectorAll("button[aria-label='Add automation']")).toHaveLength(1);
    expect(container.querySelector("button[aria-label='Collapse automation lane 1']")?.getAttribute("aria-expanded")).toBe("true");
    expect((container.firstElementChild as HTMLElement).style.height).toBe("144px");
  });

  it("reserves only a compact control row when an automation lane is folded", () => {
    const collapsedKey = "project:epoch:song\u0000lane-2";
    act(() => root.render(createElement(AutomationTrackHeader, {
      height: 56,
      visible: true,
      songIndex: 0,
      track,
      lanes,
      activeLaneId: "lane-1",
      onSelectLane: vi.fn(),
      collapseScope: "project:epoch:song",
      collapsedLaneKeys: new Set([collapsedKey]),
      onToggleLane: vi.fn(),
    }, createElement("div", null, "Track controls"))));

    expect(container.querySelector("button[aria-label='Expand automation lane 2']")?.getAttribute("aria-expanded")).toBe("false");
    expect((container.firstElementChild as HTMLElement).style.height).toBe("124px");
  });

  it("sends the project/song-scoped lane key from the chevron", () => {
    const onToggleLane = vi.fn();
    const scope = "project:epoch:song";
    act(() => root.render(createElement(AutomationTrackHeader, {
      height: 56,
      visible: true,
      songIndex: 0,
      track,
      lanes,
      activeLaneId: "lane-1",
      onSelectLane: vi.fn(),
      collapseScope: scope,
      collapsedLaneKeys: new Set<string>(),
      onToggleLane,
    })));

    const collapse = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Collapse automation lane 1']",
    );
    expect(collapse).not.toBeNull();
    act(() => collapse?.click());
    expect(onToggleLane).toHaveBeenCalledWith(`${scope}\u0000lane-1`);
  });
});
