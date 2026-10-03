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
import { useEscRevert } from "../useEscRevert";

describe("useEscRevert cancellation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let handlers: ReturnType<typeof useEscRevert<number>>;
  const revert = vi.fn<(value: number) => void>();
  const cancel = vi.fn<(value: number) => void>();

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    revert.mockClear();
    cancel.mockClear();
    act(() => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    expect(activeDragCount()).toBe(0);
  });

  function Harness() {
    handlers = useEscRevert(() => -3.5, revert, cancel);
    return createElement("div");
  }

  it("restores the start value and signals cancel on pointercancel", () => {
    act(() => handlers.onPointerDown({ button: 0 } as React.PointerEvent));
    act(() => handlers.onPointerCancel());

    expect(revert).toHaveBeenCalledWith(-3.5);
    expect(cancel).toHaveBeenCalledWith(-3.5);
  });

  it("ends normally on pointerup without marking cancellation", () => {
    act(() => handlers.onPointerDown({ button: 0 } as React.PointerEvent));
    act(() => handlers.onPointerUp());

    expect(revert).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
