/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationLaneRow } from "@/lib/state/types";
import { AutomationLaneOverlay } from "../AutomationLaneOverlay";

vi.mock("@/lib/state/api", () => ({
  builder: {
    automationLaneAdd: vi.fn().mockResolvedValue({}),
    automationLaneUpdate: vi.fn().mockResolvedValue({}),
    automationPointAdd: vi.fn().mockResolvedValue({}),
    automationPointRemove: vi.fn().mockResolvedValue({}),
    automationPointsReplace: vi.fn().mockResolvedValue({}),
    automationRecordGesture: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/lib/state/historyNavigation", () => ({
  subscribeHistoryBoundary: () => () => {},
}));

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
    { timeBeats: 4, value: -6, curve: 0.5 },
    { timeBeats: 8, value: 0, curve: 0 },
  ],
};

const emptyMockLane: AutomationLaneRow = {
  ...mockLane,
  id: "lane-empty",
  points: [],
};

describe("AutomationLaneOverlay", () => {
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

  it("renders SVG stroke path, fill path, and point handles", () => {
    act(() => {
      root.render(
        createElement(AutomationLaneOverlay, {
          songIndex: 0,
          lane: mockLane,
          bpm: 120,
          pxPerSec: 100,
          widthPx: 800,
          heightPx: 100,
          color: "#3b82f6",
          scrollLeft: 0,
          viewportWidth: 800,
        }),
      );
    });

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();

    // Check path elements (stroke and fill)
    const paths = svg?.querySelectorAll("path");
    expect(paths?.length).toBeGreaterThanOrEqual(2);

    // Check circles for breakpoint nodes and curve handles
    const circles = svg?.querySelectorAll("circle");
    expect(circles?.length).toBeGreaterThanOrEqual(3);
  });

  it("renders translucent dashed baseline and zero circle handles when lane is empty", () => {
    act(() => {
      root.render(
        createElement(AutomationLaneOverlay, {
          songIndex: 0,
          lane: emptyMockLane,
          bpm: 120,
          pxPerSec: 100,
          widthPx: 800,
          heightPx: 100,
          scrollLeft: 0,
          viewportWidth: 800,
        }),
      );
    });

    const baseline = container.querySelector("line[data-automation-baseline='true']");
    expect(baseline).not.toBeNull();
    expect(baseline?.getAttribute("stroke-dasharray")).toBe("3 3");

    // No fake points or draggable circles
    const circles = container.querySelectorAll("circle");
    expect(circles.length).toBe(0);

    const paths = container.querySelectorAll("path");
    expect(paths.length).toBe(0);
  });

  it("displays targetOption disabledReason when present", () => {
    act(() => {
      root.render(
        createElement(AutomationLaneOverlay, {
          songIndex: 0,
          lane: mockLane,
          bpm: 120,
          pxPerSec: 100,
          widthPx: 800,
          heightPx: 100,
          targetOption: {
            id: "strip:track-1:mute",
            domain: "strip",
            entityId: "track-1",
            parameterId: "mute",
            label: "Mute",
            category: "strip",
            valueType: "boolean",
            defaultValue: 0,
            minValue: 0,
            maxValue: 1,
            unit: "",
            disabledReason: "Mute automation playback is not available yet (requires audibility smoothing)",
          },
        }),
      );
    });

    expect(container.textContent).toContain("Mute automation playback is not available yet");
  });

  it("configures surface with tabIndex=-1, aria-label, and appropriate cursor per tool", () => {
    act(() => {
      root.render(
        createElement(AutomationLaneOverlay, {
          songIndex: 0,
          lane: mockLane,
          bpm: 120,
          pxPerSec: 100,
          widthPx: 800,
          heightPx: 100,
          tool: "pencil",
        }),
      );
    });

    const surface = container.querySelector("div[aria-label='Automation lane']");
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute("tabindex")).toBe("-1");
    expect((surface as HTMLElement).style.cursor).toBe("crosshair");
  });

  it("renders context menu on contextmenu event when not readOnly", () => {
    act(() => {
      root.render(
        createElement(AutomationLaneOverlay, {
          songIndex: 0,
          lane: mockLane,
          bpm: 120,
          pxPerSec: 100,
          widthPx: 800,
          heightPx: 100,
          readOnly: false,
        }),
      );
    });

    const surface = container.querySelector("div[aria-label='Automation lane']");
    expect(surface).not.toBeNull();

    act(() => {
      surface?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 80,
      }));
    });

    expect(document.body.textContent).toContain("Delete points");
    expect(document.body.textContent).toContain("Smooth selection");
    expect(document.body.textContent).toContain("Select all points");
  });
});
