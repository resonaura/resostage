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
import { builder } from "@/lib/state/api";
import { AutomationTrackControls } from "../AutomationTrackControls";

vi.mock("@/lib/state/api", () => ({
  builder: {
    automationLaneAdd: vi.fn().mockResolvedValue({}),
    automationLaneUpdate: vi.fn().mockResolvedValue({}),
    automationPointAdd: vi.fn().mockResolvedValue({}),
    automationPointRemove: vi.fn().mockResolvedValue({}),
    automationRecordGesture: vi.fn().mockResolvedValue({}),
  },
}));

const mockTrack: TrackRow = {
  id: "track-1",
  name: "Lead Vocal",
  channels: 2,
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  soloGroup: "sources",
  soloActiveInGroup: false,
  output: { type: "main", target: null, sends: [] },
  peakDb: -60,
  plugins: [],
};

const mockLane: AutomationLaneRow = {
  id: "lane-1",
  target: {
    domain: "strip",
    entityId: "track-1",
    parameterId: "faderGainDb",
    valueType: "decibels",
    defaultValue: 0,
    minValue: -60,
    maxValue: 12,
  },
  scope: "track",
  writeMode: "read",
  enabled: true,
  muted: false,
  points: [
    { timeBeats: 0, value: 0, curve: 0 },
    { timeBeats: 8, value: -6, curve: 0 },
  ],
};

describe("AutomationTrackControls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders target select, write mode badge, and power toggle with tabIndex=-1", () => {
    act(() => {
      root.render(
        createElement(AutomationTrackControls, {
          songIndex: 0,
          track: mockTrack,
          lanes: [mockLane],
          activeLaneId: "lane-1",
          onSelectLane: vi.fn(),
        }),
      );
    });

    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    expect(select?.getAttribute("tabindex")).toBe("-1");

    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    buttons.forEach((btn) => {
      expect(btn.getAttribute("tabindex")).toBe("-1");
    });

    // Write mode text should be Read
    expect(container.textContent).toContain("Read");
  });

  it("cycles write mode when clicking write mode badge", async () => {
    act(() => {
      root.render(
        createElement(AutomationTrackControls, {
          songIndex: 0,
          track: mockTrack,
          lanes: [mockLane],
          activeLaneId: "lane-1",
          onSelectLane: vi.fn(),
        }),
      );
    });

    const writeModeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Read",
    );
    expect(writeModeBtn).toBeDefined();

    await act(async () => {
      writeModeBtn?.click();
    });

    expect(builder.automationLaneUpdate).toHaveBeenCalledWith({
      songIndex: 0,
      laneId: "lane-1",
      writeMode: "touch",
    });
  });

  it("toggles lane mute when clicking power button", async () => {
    act(() => {
      root.render(
        createElement(AutomationTrackControls, {
          songIndex: 0,
          track: mockTrack,
          lanes: [mockLane],
          activeLaneId: "lane-1",
          onSelectLane: vi.fn(),
        }),
      );
    });

    const powerBtn = container.querySelector("button[title*='Automation Active']");
    expect(powerBtn).not.toBeNull();

    await act(async () => {
      (powerBtn as HTMLButtonElement).click();
    });

    expect(builder.automationLaneUpdate).toHaveBeenCalledWith({
      songIndex: 0,
      laneId: "lane-1",
      muted: true,
    });
  });
});
