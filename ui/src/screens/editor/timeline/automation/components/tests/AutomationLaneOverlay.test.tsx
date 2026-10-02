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
    automationRecordGesture: vi.fn().mockResolvedValue({}),
  },
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
});
