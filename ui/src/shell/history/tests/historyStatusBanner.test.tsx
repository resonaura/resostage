/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistoryStatusBanner } from "@/shell/history/components/HistoryStatusBanner";
import { createHistoryNavigator, dismissHistoryError } from "@/lib/state/historyNavigation";

describe("HistoryStatusBanner component", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    dismissHistoryError();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    dismissHistoryError();
  });

  const render = () => {
    act(() => root.render(createElement(HistoryStatusBanner)));
  };

  it("renders nothing when there is no pending action and no error", () => {
    render();
    expect(container.innerHTML).toBe("");
  });

  it("renders pending status message when history navigation is executing", async () => {
    let finishPromise: (value: any) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      finishPromise = resolve;
    });

    const navigator = createHistoryNavigator({
      fetch: () => pendingPromise as any,
      origin: () => "http://localhost",
      prepare: async () => {},
      serialize: (cmd) => cmd(),
      applySnapshot: () => {},
    });

    render();
    expect(container.innerHTML).toBe("");

    act(() => {
      void navigator("undo");
    });

    expect(container.textContent).toContain("Applying history…");
    const statusElem = container.querySelector('[role="status"]');
    expect(statusElem).not.toBeNull();

    await act(async () => {
      finishPromise({ ok: true, json: async () => ({ session: { historyRevision: 1 } }) });
    });
  });

  it("renders error alert with dismiss button on failure", async () => {
    const navigator = createHistoryNavigator({
      fetch: async () => { throw new Error("Network timeout during undo"); },
      origin: () => "http://localhost",
      prepare: async () => {},
      serialize: (cmd) => cmd(),
      applySnapshot: () => {},
    });

    render();

    await act(async () => {
      await navigator("redo");
    });

    const alertElem = container.querySelector('[role="alert"]');
    expect(alertElem).not.toBeNull();
    expect(container.textContent).toContain("Network timeout during undo");

    const dismissBtn = container.querySelector("button");
    expect(dismissBtn).not.toBeNull();
    expect(dismissBtn?.textContent).toContain("Dismiss");

    act(() => {
      dismissBtn?.click();
    });

    expect(container.innerHTML).toBe("");
  });
});
