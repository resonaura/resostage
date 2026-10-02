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
    automationLaneRemove: vi.fn().mockResolvedValue({}),
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

  it("renders target select, write mode selector, and power toggle with tabIndex=-1", () => {
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

    const buttons = container.querySelectorAll<HTMLButtonElement>("button[aria-label]");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    buttons.forEach((btn) => {
      if (!btn.disabled) {
        expect(btn.getAttribute("tabindex")).toBe("-1");
      }
    });

    // Write mode text should be Read
    expect(container.textContent).toContain("Read");
  });

  it("displays write mode selector showing Read with other modes reserved for future live write", () => {
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

    const writeModeBtn = container.querySelector("button[aria-label='Automation write mode']");
    expect(writeModeBtn).not.toBeNull();
    expect(writeModeBtn?.textContent).toContain("Read");
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

    const powerBtn = container.querySelector("button[aria-label='Enable automation']");
    expect(powerBtn).not.toBeNull();

    await act(async () => {
      (powerBtn as HTMLButtonElement).click();
    });

    expect(builder.automationLaneUpdate).toHaveBeenCalledWith({
      songIndex: 0,
      laneId: "lane-1",
      enabled: true,
      muted: true,
    });
  });

  it("renders orphan target and selects it without falling back to fader gain", () => {
    const orphanLane: AutomationLaneRow = {
      id: "lane-orphan",
      target: {
        domain: "plugin",
        entityId: "slot-missing-uuid",
        parameterId: "param:3",
        valueType: "floatNormalized",
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
      },
      scope: "track",
      writeMode: "read",
      enabled: true,
      muted: false,
      points: [{ timeBeats: 0, value: 0.5, curve: 0 }],
    };

    act(() => {
      root.render(
        createElement(AutomationTrackControls, {
          songIndex: 0,
          track: mockTrack,
          lanes: [orphanLane],
          activeLaneId: "lane-orphan",
          onSelectLane: vi.fn(),
        }),
      );
    });

    const select = container.querySelector("select");
    expect(select?.value).toBe("orphan:lane-orphan");
    expect(container.textContent).toContain("[Missing Plug-in]");
    expect(container.textContent).toContain("slot-mis");
  });

  it("calls builder.automationLaneAdd with empty points array when clicking + on unautomated target", async () => {
    const onSelectLane = vi.fn();
    act(() => {
      root.render(
        createElement(AutomationTrackControls, {
          songIndex: 0,
          track: mockTrack,
          lanes: [],
          activeLaneId: "strip:track-1:gain",
          onSelectLane,
        }),
      );
    });

    const addBtn = container.querySelector("button[aria-label='Add automation']") as HTMLButtonElement;
    expect(addBtn).not.toBeNull();
    expect(addBtn.disabled).toBe(false);

    await act(async () => {
      addBtn.click();
    });

    expect(builder.automationLaneAdd).toHaveBeenCalledWith({
      songIndex: 0,
      domain: "strip",
      entityId: "track-1",
      parameterId: "faderGainDb",
      valueType: "decibels",
      defaultValue: 0,
      minValue: -60,
      maxValue: 12,
      scope: "track",
      writeMode: "read",
      points: [],
    });
    expect(onSelectLane).toHaveBeenCalledWith("strip:track-1:gain");
  });

  it("disables + button when target has disabledReason", () => {
    const trackWithFailedPlugin: TrackRow = {
      ...mockTrack,
      plugins: [
        {
          id: "slot:crash",
          pluginId: "vst3.crash",
          format: "vst3",
          name: "CrashPlugin",
          manufacturer: "Crash",
          instrument: false,
          loadState: "failed",
          bypassed: false,
          hasState: false,
        },
      ],
    };

    act(() => {
      root.render(
        createElement(AutomationTrackControls, {
          songIndex: 0,
          track: trackWithFailedPlugin,
          lanes: [],
          activeLaneId: "plugin:slot:crash:status",
          onSelectLane: vi.fn(),
        }),
      );
    });

    const addBtn = container.querySelector("button[aria-label='Add automation']") as HTMLButtonElement;
    expect(addBtn).not.toBeNull();
    expect(addBtn.disabled).toBe(true);
  });

  it("calls builder.automationLaneRemove when clicking remove button", async () => {
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

    const trashBtn = container.querySelector("button[aria-label='Remove automation']") as HTMLButtonElement;
    expect(trashBtn).not.toBeNull();

    await act(async () => {
      trashBtn.click();
    });

    expect(builder.automationLaneRemove).toHaveBeenCalledWith(0, "lane-1");
  });

  it("calls onRemoveLane callback when provided", async () => {
    const onRemoveLane = vi.fn();
    act(() => {
      root.render(
        createElement(AutomationTrackControls, {
          songIndex: 0,
          track: mockTrack,
          lanes: [mockLane],
          activeLaneId: "lane-1",
          onSelectLane: vi.fn(),
          onRemoveLane,
        }),
      );
    });

    const trashBtn = container.querySelector("button[aria-label='Remove automation']") as HTMLButtonElement;
    expect(trashBtn).not.toBeNull();

    await act(async () => {
      trashBtn.click();
    });

    expect(onRemoveLane).toHaveBeenCalledWith("lane-1");
    expect(builder.automationLaneRemove).not.toHaveBeenCalled();
  });

  it("marks already automated parameters with a bullet in the select options", () => {
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
    const options = Array.from(select!.querySelectorAll("option"));
    const faderOption = options.find((o) => o.value === "strip:track-1:gain");
    const panOption = options.find((o) => o.value === "strip:track-1:pan");

    expect(faderOption?.textContent).toContain("•");
    expect(panOption?.textContent).not.toContain("•");
  });

  it("adds the next available unautomated parameter when clicking + while an automated parameter is selected", async () => {
    const onSelectLane = vi.fn();
    act(() => {
      root.render(
        createElement(AutomationTrackControls, {
          songIndex: 0,
          track: mockTrack,
          lanes: [mockLane], // Fader Gain is already automated
          activeLaneId: "lane-1",
          onSelectLane,
        }),
      );
    });

    const addBtn = container.querySelector("button[aria-label='Add automation']") as HTMLButtonElement;
    expect(addBtn).not.toBeNull();
    expect(addBtn.disabled).toBe(false);

    await act(async () => {
      addBtn.click();
    });

    // Should add Pan (the next unautomated strip parameter)
    expect(builder.automationLaneAdd).toHaveBeenCalledWith(expect.objectContaining({
      songIndex: 0,
      domain: "strip",
      entityId: "track-1",
      parameterId: "pan",
      valueType: "floatNormalized",
      points: [],
    }));
    expect(onSelectLane).toHaveBeenCalledWith("strip:track-1:pan");
  });
});

