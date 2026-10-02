/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse } from "@/lib/state/backend";
import { createHistoryNavigator, dismissHistoryError, getHistoryNavigationState } from "@/lib/state/historyNavigation";

const response = (data: unknown, ok = true): ApiResponse => ({
  ok, status: ok ? 200 : 503,
  json: async <T>() => data as T,
  text: async () => JSON.stringify(data),
});
afterEach(() => { dismissHistoryError(); vi.useRealTimers(); });

function fixture() {
  let now = 0;
  let origin = "one";
  const fetch = vi.fn();
  const applySnapshot = vi.fn();
  const prepare = vi.fn(async () => {});
  const navigate = createHistoryNavigator({
    fetch, applySnapshot, prepare,
    origin: () => origin,
    serialize: async (command) => command(),
    now: () => now,
    timeoutMs: 100,
    sleep: async (ms) => { now += ms; },
  });
  return { fetch, applySnapshot, prepare, navigate, setOrigin: (next: string) => { origin = next; } };
}

describe("authoritative history navigation", () => {
  it("does not treat queue admission or an old snapshot as applied Undo", async () => {
    const test = fixture();
    const final = { stateSessionId: "Core", lastHistoryRequestId: 4, stateRevision: 10, songs: [] };
    test.fetch.mockResolvedValueOnce(response({ historyRequestId: 4, stateSessionId: "Core" }))
      .mockResolvedValueOnce(response({ stateSessionId: "Core", lastHistoryRequestId: 3 }))
      .mockResolvedValueOnce(response(final));
    await test.navigate("undo");
    expect(test.prepare).toHaveBeenCalledOnce();
    expect(test.applySnapshot).toHaveBeenCalledExactlyOnceWith(final);
    expect(test.fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/timeline/undo", "/api/v1/state", "/api/v1/state",
    ]);
    expect(getHistoryNavigationState()).toEqual({ pending: false, error: null });
  });

  it("preserves rapid Undo/Redo order until each action is confirmed", async () => {
    const test = fixture();
    let acceptUndo!: (result: ApiResponse) => void;
    test.fetch.mockReturnValueOnce(new Promise<ApiResponse>((resolve) => { acceptUndo = resolve; }))
      .mockResolvedValueOnce(response({ stateSessionId: "Core", lastHistoryRequestId: 1 }))
      .mockResolvedValueOnce(response({ stateSessionId: "Core", historyRequestId: 2 }))
      .mockResolvedValueOnce(response({ stateSessionId: "Core", lastHistoryRequestId: 2 }));
    const undo = test.navigate("undo");
    const redo = test.navigate("redo");
    await vi.waitFor(() => expect(test.fetch).toHaveBeenCalledOnce());
    acceptUndo(response({ stateSessionId: "Core", historyRequestId: 1 }));
    await Promise.all([undo, redo]);
    expect(test.fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/timeline/undo", "/api/v1/state", "/api/v1/timeline/redo", "/api/v1/state",
    ]);
    expect(test.applySnapshot).toHaveBeenCalledTimes(2);
  });

  it("reports rejection without fetching or silently retrying the action", async () => {
    const test = fixture();
    test.fetch.mockResolvedValue(response({ error: "Full" }, false));
    await test.navigate("redo");
    expect(test.fetch).toHaveBeenCalledOnce();
    expect(test.applySnapshot).not.toHaveBeenCalled();
    expect(getHistoryNavigationState().error).toContain("503");
  });

  it("does not mistake a later applied action for this rejected no-op", async () => {
    const test = fixture();
    test.fetch.mockResolvedValueOnce(response({ historyRequestId: 12, stateSessionId: "Core" }))
      .mockResolvedValueOnce(response({
        stateSessionId: "Core",
        lastHistoryRequestId: 13,
        historyResults: [
          { requestId: 12, applied: false, projectRevision: 4, error: "Nothing to undo" },
          { requestId: 13, applied: true, projectRevision: 5, error: "" },
        ],
      }));

    await test.navigate("undo");
    expect(test.applySnapshot).not.toHaveBeenCalled();
    expect(getHistoryNavigationState().error).toContain("Nothing to undo");
  });

  it("accepts an exact applied result even before the legacy high-water mark", async () => {
    const test = fixture();
    const snapshot = {
      stateSessionId: "Core",
      lastHistoryRequestId: 11,
      stateRevision: 18,
      historyResults: [{ requestId: 12, applied: true, projectRevision: 18, error: "" }],
    };
    test.fetch.mockResolvedValueOnce(response({ historyRequestId: 12, stateSessionId: "Core" }))
      .mockResolvedValueOnce(response(snapshot));

    await test.navigate("redo");
    expect(test.applySnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(getHistoryNavigationState()).toEqual({ pending: false, error: null });
  });

  it("does not fall back to a later high-water mark when an exact result expired", async () => {
    const test = fixture();
    test.fetch.mockResolvedValueOnce(response({ historyRequestId: 12, stateSessionId: "Core" }))
      .mockResolvedValueOnce(response({
        stateSessionId: "Core",
        lastHistoryRequestId: 100,
        stateRevision: 100,
        historyResults: [],
      }));

    await test.navigate("undo");
    expect(test.applySnapshot).not.toHaveBeenCalled();
    expect(getHistoryNavigationState().error).toContain("exact result");
  });

  it("rejects a restarted Core instead of accepting its reset request counter", async () => {
    const test = fixture();
    test.fetch.mockResolvedValueOnce(response({ stateSessionId: "old", historyRequestId: 1 }))
      .mockResolvedValueOnce(response({ stateSessionId: "new", lastHistoryRequestId: 100 }));
    await test.navigate("undo");
    expect(test.applySnapshot).not.toHaveBeenCalled();
    expect(getHistoryNavigationState().error).toContain("restarted");
  });

  it("does not send queued history to a different playback computer", async () => {
    const test = fixture();
    test.prepare.mockImplementation(async () => { test.setOrigin("two"); });
    await test.navigate("undo");
    expect(test.fetch).not.toHaveBeenCalled();
    expect(getHistoryNavigationState().error).toContain("changed");
  });

  it("times out a deferred history action without repeating its POST", async () => {
    const test = fixture();
    test.fetch.mockResolvedValueOnce(response({ stateSessionId: "Core", historyRequestId: 10 }))
      .mockResolvedValue(response({ stateSessionId: "Core", lastHistoryRequestId: 9 }));
    await test.navigate("undo");
    expect(test.fetch.mock.calls.filter(([path]) => path.endsWith("/undo"))).toHaveLength(1);
    expect(test.applySnapshot).not.toHaveBeenCalled();
    expect(getHistoryNavigationState().error).toContain("do not resend blindly");
  });

  it("bounds even a stalled HTTP promise and releases the pending indicator", async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.fetch.mockReturnValue(new Promise(() => {}));
    const request = test.navigate("undo");
    await vi.advanceTimersByTimeAsync(101);
    await request;
    expect(getHistoryNavigationState().pending).toBe(false);
    expect(getHistoryNavigationState().error).toContain("timeout");
  });
});
