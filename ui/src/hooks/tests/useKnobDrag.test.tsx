/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeDragCount } from "@/lib/interaction/dragCancel";
import { useKnobDrag, type KnobDrag } from "../useKnobDrag";

describe("useKnobDrag cancellation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let drag: KnobDrag;
  let commit: ReturnType<typeof vi.fn<(value: number) => void>>;
  let finish: ReturnType<typeof vi.fn<(value: number) => void>>;
  let cancel: ReturnType<typeof vi.fn<(value: number) => void>>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    commit = vi.fn<(value: number) => void>();
    finish = vi.fn<(value: number) => void>();
    cancel = vi.fn<(value: number) => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    expect(activeDragCount()).toBe(0);
    vi.restoreAllMocks();
  });

  function Harness() {
    drag = useKnobDrag({
      value: 0,
      min: -1,
      max: 1,
      onCommit: commit,
      round: (value) => Math.round(value * 100) / 100,
      onDragEnd: finish,
      onDragCancel: cancel,
    });
    return createElement("div");
  }

  function pointerEvent(pointerId: number, clientY: number, buttons: number, button = 0) {
    const currentTarget = {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    };
    return {
      pointerId,
      clientY,
      buttons,
      button,
      currentTarget,
      preventDefault: vi.fn(),
    } as unknown as React.PointerEvent<HTMLDivElement>;
  }

  function render() {
    act(() => root.render(createElement(Harness)));
  }

  it("rolls back and discards pending automation callbacks on pointer cancel", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
    const cancelAnimation = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelAnimation);
    render();

    act(() => drag.dragProps.onPointerDown(pointerEvent(1, 100, 1)));
    act(() => drag.dragProps.onPointerMove(pointerEvent(1, 40, 1)));
    expect(drag.value).toBe(1);

    act(() => drag.dragProps.onPointerCancel(pointerEvent(1, 40, 0)));

    expect(drag.value).toBe(0);
    expect(commit.mock.calls).toEqual([[0]]);
    expect(finish).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(0);
    expect(cancelAnimation).toHaveBeenCalledWith(7);
  });

  it("reports Escape as cancellation, not a normal release", () => {
    render();
    act(() => drag.dragProps.onPointerDown(pointerEvent(2, 100, 1)));
    act(() => drag.dragProps.onPointerMove(pointerEvent(2, 40, 1)));

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })));

    expect(drag.value).toBe(0);
    expect(commit).toHaveBeenLastCalledWith(0);
    expect(finish).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(0);
  });
});
