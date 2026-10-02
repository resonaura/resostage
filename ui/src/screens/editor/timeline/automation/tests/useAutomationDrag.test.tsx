/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builder } from "@/lib/state/api";
import { activeDragCount } from "@/lib/interaction/dragCancel";
import type { AutomationLaneRow } from "@/lib/state/types";
import { useAutomationDrag } from "@/screens/editor/timeline/automation/hooks/useAutomationDrag";

vi.mock("@/lib/state/api", () => ({ builder: {
  automationPointsReplace: vi.fn().mockResolvedValue(undefined),
  automationLaneAdd: vi.fn().mockResolvedValue(undefined),
} }));

const historyCallbacks = vi.hoisted(() => new Set<() => void>());
vi.mock("@/lib/state/historyNavigation", () => ({
  subscribeHistoryBoundary: (callback: () => void) => {
    historyCallbacks.add(callback);
    return () => historyCallbacks.delete(callback);
  },
}));

type Options = Parameters<typeof useAutomationDrag>[0];
const emptyLane: AutomationLaneRow = { id: "lane-1", target: { domain: "strip",
  entityId: "track-1", parameterId: "faderGainDb", valueType: "floatNormalized",
  defaultValue: 0.5, minValue: 0, maxValue: 1 }, scope: "track", writeMode: "read",
  enabled: true, muted: false, points: [] };
const lane: AutomationLaneRow = { ...emptyLane, points: [
  { timeBeats: 0, value: 0.2, curve: 0 },
  { timeBeats: 4, value: 0.4, curve: 0 },
  { timeBeats: 8, value: 0.6, curve: 0 },
] };

describe("automation pointer ownership and history", () => {
  let root: Root;
  let container: HTMLDivElement;
  let result: ReturnType<typeof useAutomationDrag>;
  let options: Options;
  const arrangementPointerDown = vi.fn();

  function Harness(props: Options) {
    result = useAutomationDrag(props);
    return createElement("div", { onPointerDown: arrangementPointerDown },
      createElement("div", { "data-surface": "automation", onPointerDown: result.onPointerDown,
        onPointerMove: result.onPointerMove, onPointerUp: result.onPointerUp,
        onPointerCancel: result.onPointerCancel, onLostPointerCapture: result.onPointerCancel,
        onContextMenu: result.onContextMenu }));
  }
  const render = (patch: Partial<Options> = {}) => {
    options = { ...options, ...patch };
    act(() => root.render(createElement(Harness, options)));
  };
  const pointer = async (type: string, x: number, y: number, modifiers: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: 0, ...modifiers });
    Object.defineProperty(event, "pointerId", { value: 1 });
    await act(async () => { container.querySelector("[data-surface]")!.dispatchEvent(event); });
    return event;
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    options = { songIndex: 0, lane, bpm: 120, pxPerSec: 100, laneHeight: 100 };
    render();
    const surface = container.querySelector("[data-surface]") as HTMLDivElement;
    let captured = false;
    surface.setPointerCapture = () => { captured = true; };
    surface.hasPointerCapture = () => captured;
    surface.releasePointerCapture = () => { captured = false; };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    expect(activeDragCount()).toBe(0);
  });

  it("claims empty-lane marquee and never creates phantom automation points", async () => {
    render({ lane: { ...emptyLane, id: "temp:track-1:gain" } });
    const down = await pointer("pointerdown", 50, 20);
    await pointer("pointermove", 200, 80);
    await pointer("pointerup", 200, 80);
    expect(down.defaultPrevented).toBe(true);
    expect(arrangementPointerDown).not.toHaveBeenCalled();
    expect(builder.automationLaneAdd).not.toHaveBeenCalled();
    expect(builder.automationPointsReplace).not.toHaveBeenCalled();
    expect(result.activePoints).toEqual([]);
  });

  it("draws one atomic stroke in an empty lane with all its points", async () => {
    render({ lane: { ...emptyLane, id: "temp:track-1:gain" }, tool: "pencil" });
    await pointer("pointerdown", 50, 80);
    await pointer("pointermove", 100, 60);
    await pointer("pointerup", 150, 40);
    expect(arrangementPointerDown).not.toHaveBeenCalled();
    expect(builder.automationLaneAdd).toHaveBeenCalledOnce();
    const points = vi.mocked(builder.automationLaneAdd).mock.calls[0][0].points!;
    expect(points.map((point) => point.timeBeats)).toEqual([1, 2, 3]);
    expect(points[0].value).toBeCloseTo(0.2);
    expect(points[1].value).toBeCloseTo(0.4);
    expect(points[2].value).toBeCloseTo(0.6);
    expect(result.isPending).toBe(true);
  });

  it("Shift overrides Draw with additive marquee without editing the lane", async () => {
    render({ tool: "pencil" });
    act(() => result.setSelectedIndices(new Set([0])));
    await pointer("pointerdown", 150, 10, { shiftKey: true });
    await pointer("pointermove", 450, 70, { shiftKey: true });
    await pointer("pointerup", 450, 70, { shiftKey: true });
    expect([...result.selectedIndices]).toEqual([1, 2, 0]);
    expect(builder.automationPointsReplace).not.toHaveBeenCalled();
    expect(builder.automationLaneAdd).not.toHaveBeenCalled();
  });

  it("moves a selected group left and retains the optimistic result until Core echoes", async () => {
    act(() => result.setSelectedIndices(new Set([1, 2])));
    await pointer("pointerdown", 200, 60);
    await pointer("pointermove", 150, 50);
    await pointer("pointerup", 150, 50);
    expect(result.selectionCount).toBe(2);
    expect(builder.automationPointsReplace).toHaveBeenCalledOnce();
    const patch = vi.mocked(builder.automationPointsReplace).mock.calls[0][0];
    expect(patch.points[1].timeBeats).toBe(3);
    expect(patch.points[2].timeBeats).toBe(7);
    expect(patch.points[1].value).toBeCloseTo(0.5);
    expect(patch.points[2].value).toBeCloseTo(0.7);
    await pointer("lostpointercapture", 150, 50);
    expect(result.activePoints).toEqual(patch.points);
    render({ lane: { ...lane, points: patch.points } });
    expect(result.isPending).toBe(false);
    expect(result.draftPoints).toBeNull();
  });

  it("does not write history when clicking a point without changing it", async () => {
    await pointer("pointerdown", 200, 60);
    await pointer("pointerup", 200, 60);
    expect(result.selectedIndices).toEqual(new Set([1]));
    expect(builder.automationPointsReplace).not.toHaveBeenCalled();
  });

  it("Esc cancels Draw, releases capture, and never commits a partial stroke", async () => {
    render({ lane: emptyLane, tool: "pencil" });
    await pointer("pointerdown", 50, 80);
    await pointer("pointermove", 100, 60);
    expect(result.activePoints).toHaveLength(2);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(result.activePoints).toEqual([]);
    expect(activeDragCount()).toBe(0);
    await pointer("pointerup", 150, 40);
    expect(builder.automationPointsReplace).not.toHaveBeenCalled();
  });

  it("deletes multiple points with one replacement and a single gesture ID", async () => {
    act(() => result.setSelectedIndices(new Set([0, 2])));
    act(() => result.deleteSelectedPoints());
    await act(async () => {});
    expect(builder.automationPointsReplace).toHaveBeenCalledWith(expect.objectContaining({
      points: [lane.points[1]], gestureId: expect.any(String),
    }));
    expect(result.selectedIndices.size).toBe(0);
  });

  it("does not lose queued drafts to a late command when history replaces the document", async () => {
    act(() => result.setSelectedIndices(new Set([1])));
    act(() => result.deleteSelectedPoints());
    await act(async () => {});
    act(() => historyCallbacks.forEach((callback) => callback()));
    expect(result.isPending).toBe(false);
    expect(result.activePoints).toEqual(lane.points);
    expect(result.selectedIndices.size).toBe(0);
  });

  it("restores authoritative points with a visible error on rejected commit", async () => {
    vi.mocked(builder.automationPointsReplace).mockRejectedValueOnce(new Error("Core unavailable"));
    act(() => result.setSelectedIndices(new Set([1])));
    await act(async () => result.deleteSelectedPoints());
    expect(result.error).toBe("Core unavailable");
    expect(result.isPending).toBe(false);
    expect(result.activePoints).toEqual(lane.points);
  });

  it("clears an admission timeout when the matching delayed Core echo arrives", async () => {
    vi.useFakeTimers();
    act(() => result.setSelectedIndices(new Set([1])));
    await act(async () => result.deleteSelectedPoints());
    const points = vi.mocked(builder.automationPointsReplace).mock.calls[0][0].points;
    act(() => vi.advanceTimersByTime(3000));
    expect(result.isPending).toBe(false);
    expect(result.error).toContain("may still be queued");
    expect(result.draftPoints).toBeNull();
    render({ lane: { ...lane, points } });
    expect(result.error).toBeNull();
    expect(result.activePoints).toEqual(points);
  });

  it("cancels an active gesture when a project epoch changes with reused lane IDs", async () => {
    render({ resetKey: "show:1", lane: emptyLane, tool: "pencil" });
    await pointer("pointerdown", 50, 80);
    await pointer("pointermove", 100, 60);
    expect(result.activePoints).toHaveLength(2);
    render({ resetKey: "show:2" });
    expect(result.activePoints).toEqual([]);
    expect(result.selectionCount).toBe(0);
    await pointer("pointerup", 150, 40);
    expect(builder.automationPointsReplace).not.toHaveBeenCalled();
  });

  it("ignores a late rejection after reopening a project with reused lane IDs", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(builder.automationPointsReplace).mockReturnValueOnce(new Promise<void>((_, failure) => { reject = failure; }));
    render({ resetKey: "show:1" });
    act(() => result.setSelectedIndices(new Set([1])));
    await act(async () => result.deleteSelectedPoints());
    expect(result.isPending).toBe(true);
    const reopened = { ...lane, points: [{ timeBeats: 0, value: 0.9, curve: 0 }] };
    render({ resetKey: "show:2", lane: reopened });
    await act(async () => reject(new Error("Old project failed")));
    expect(result.error).toBeNull();
    expect(result.activePoints).toEqual(reopened.points);
    expect(result.isPending).toBe(false);
  });
});
