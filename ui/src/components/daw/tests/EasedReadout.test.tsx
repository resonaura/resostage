/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EasedReadout } from "@/components/daw/EasedReadout";

describe("EasedReadout", () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];
  let nextFrameId: number;

  const render = (
    value: number,
    motionKey = "session:project:song",
    interacting = false,
  ) => {
    root.render(createElement(EasedReadout, {
      value,
      format: (next) => next.toFixed(2),
      motionKey,
      interacting,
    }));
  };

  const frame = (time: number) => {
    const scheduled = frames;
    frames = [];
    for (const callback of scheduled) callback(time);
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    frames = [];
    nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return nextFrameId++;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("eases changing values and snaps across project identity changes", () => {
    act(() => render(0));
    act(() => frame(16));
    act(() => render(10));
    act(() => frame(32));
    expect(container.textContent).toBe("0.00");

    act(() => frame(92));
    expect(container.textContent).toBe("8.75");

    act(() => render(3, "session:next-project:song"));
    act(() => frame(108));
    expect(container.textContent).toBe("3.00");
  });

  it("keeps a direct gesture attached to its exact value", () => {
    act(() => render(0));
    act(() => render(7.25, "session:project:song", true));
    expect(container.textContent).toBe("7.25");
    expect(frames).toHaveLength(0);
  });
});
