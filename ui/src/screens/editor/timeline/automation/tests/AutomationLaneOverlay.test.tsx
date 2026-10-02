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
import { AutomationLaneOverlay } from "@/screens/editor/timeline/automation/components/AutomationLaneOverlay";
import { builder } from "@/lib/state/api";
import { HotkeyManager } from "@/lib/interaction/HotkeyManager";

const historyListeners = vi.hoisted(() => new Set<() => void>());

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
  subscribeHistoryBoundary: (listener: () => void) => {
    historyListeners.add(listener);
    return () => historyListeners.delete(listener);
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

const emptyMockLane: AutomationLaneRow = {
  ...mockLane,
  id: "lane-empty",
  points: [],
};

describe("AutomationLaneOverlay", () => {
  let container: HTMLDivElement;
  let root: Root;
  let unmountHotkeys: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    unmountHotkeys = new HotkeyManager().mount(window);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    unmountHotkeys();
  });

  const renderLane = (lane = mockLane, resetKey = "project:1") => {
    act(() => root.render(createElement(AutomationLaneOverlay, {
      songIndex: 0, lane, resetKey, bpm: 120, pxPerSec: 100, widthPx: 800, heightPx: 100,
    })));
  };
  async function openExactEditor() {
    renderLane();
    const surface = container.querySelector("div[aria-label='Automation lane']") as HTMLDivElement;
    for (let click = 0; click < 2; ++click) {
      await act(async () => {
        for (const type of ["pointerdown", "pointerup"]) {
          const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 0, clientY: 17, button: 0 });
          Object.defineProperty(event, "pointerId", { value: 1 });
          surface.dispatchEvent(event);
        }
      });
    }
    const input = container.querySelector("input[data-testid='automation-exact-value-input']") as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "-3.5";
    return { input, surface };
  }

  it("cancels exact editing on Escape without blur submitting the changed value", async () => {
    const { input, surface } = await openExactEditor();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(surface);
    expect(builder.automationPointsReplace).not.toHaveBeenCalled();
  });

  it("settles Enter once even when restoring canvas focus blurs the input", async () => {
    const { input } = await openExactEditor();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(builder.automationPointsReplace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(builder.automationPointsReplace).mock.calls[0][0].points[0].value).toBe(-3.5);
  });

  it("submits a changed value when editing intentionally loses focus", async () => {
    const { surface } = await openExactEditor();
    await act(async () => surface.focus());
    expect(builder.automationPointsReplace).toHaveBeenCalledTimes(1);
  });

  it.each(["project", "lane", "history"])("retires an exact editor across %s identity changes", async (change) => {
    const { input } = await openExactEditor();
    await act(async () => {
      if (change === "history") historyListeners.forEach((listener) => listener());
      else renderLane(change === "lane" ? { ...mockLane, id: "new-lane" } : mockLane,
        change === "project" ? "project:2" : "project:1");
    });
    expect(container.querySelector("input")).toBeNull();
    await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(builder.automationPointsReplace).not.toHaveBeenCalled();
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

  it("omits curve handles and scales breakpoint nodes in compact lanes (<= 32px)", () => {
    act(() => {
      root.render(
        createElement(AutomationLaneOverlay, {
          songIndex: 0,
          lane: mockLane,
          bpm: 120,
          pxPerSec: 100,
          widthPx: 800,
          heightPx: 28,
          color: "#3b82f6",
          scrollLeft: 0,
          viewportWidth: 800,
        }),
      );
    });

    const circles = container.querySelectorAll("circle");
    // Only the 3 breakpoint nodes, zero curve handles
    expect(circles.length).toBe(3);
    circles.forEach((circle) => {
      expect(Number(circle.getAttribute("r"))).toBeLessThanOrEqual(4);
    });
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

    expect(document.body.textContent).toContain("Set exact value…");
    expect(document.body.textContent).toContain("Delete points");
    expect(document.body.textContent).toContain("Smooth selection");
    expect(document.body.textContent).toContain("Select all points");
  });

  it("opens inline numeric input popover when choosing Set exact value, and commits value on Enter", async () => {
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

    const surface = container.querySelector("div[aria-label='Automation lane']") as HTMLDivElement;
    expect(surface).not.toBeNull();

    // Select point 0 (at x=0, y=valueToPixel(0, 100, -60, 12)) via pointerdown + pointerup
    // Point 0 is at timeBeats=0 (px=0), value=0 dB (py = 100 * (1 - (0 - (-60)) / 72) = 100 * 12/72 = 16.67)
    await act(async () => {
      const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 0, clientY: 17, button: 0 });
      Object.defineProperty(down, "pointerId", { value: 1 });
      surface.dispatchEvent(down);
      const up = new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 0, clientY: 17, button: 0 });
      Object.defineProperty(up, "pointerId", { value: 1 });
      surface.dispatchEvent(up);
    });

    // Right-click to open context menu on the selected point
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 0,
        clientY: 17,
      }));
    });

    const setExactBtn = Array.from(document.body.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Set exact value"));
    expect(setExactBtn).toBeDefined();

    await act(async () => {
      setExactBtn?.click();
    });

    const exactInput = container.querySelector("input[data-testid='automation-exact-value-input']") as HTMLInputElement;
    expect(exactInput).not.toBeNull();

    // Change input value to -3.5 and press Enter
    await act(async () => {
      exactInput.value = "-3.5";
      exactInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    // Verify popover closed
    expect(container.querySelector("input[data-testid='automation-exact-value-input']")).toBeNull();
  });
});
