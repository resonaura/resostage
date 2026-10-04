/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MidiUmpEventRow } from "@/lib/state/types";
import { usePianoRollUmpEventDraft } from "@/screens/editor/pianoroll/hooks/usePianoRollUmpEventDraft";

const historyCallbacks = vi.hoisted(() => new Set<() => void>());
vi.mock("@/lib/state/historyNavigation", () => ({
  subscribeHistoryBoundary: (callback: () => void) => {
    historyCallbacks.add(callback);
    return () => historyCallbacks.delete(callback);
  },
}));

const original: MidiUmpEventRow[] = [{ beat: 1, wordCount: 2, words: [0x40b04a00, 0x1234_5678] }];
const edited: MidiUmpEventRow[] = [{ beat: 2, wordCount: 2, words: [0x40b04a00, 0xfedc_ba98] }];
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
};

describe("Piano Roll exact UMP drafts", () => {
  let root: Root;
  let container: HTMLDivElement;
  let result: ReturnType<typeof usePianoRollUmpEventDraft>;
  let regionId: string;
  let resetKey: string;
  let serverEvents: MidiUmpEventRow[];
  let send: ReturnType<typeof vi.fn<(events: MidiUmpEventRow[]) => void | Promise<void>>>;

  function Harness() {
    result = usePianoRollUmpEventDraft({
      regionId,
      resetKey,
      events: serverEvents,
      onEventsChange: send,
      confirmationTimeoutMs: 1000,
    });
    return null;
  }

  const render = () => act(() => root.render(createElement(Harness)));
  const commit = async (events: MidiUmpEventRow[]) => {
    await act(async () => { result.commitEvents(events); });
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    regionId = "midi-region:1";
    resetKey = "show:1";
    serverEvents = original;
    send = vi.fn().mockResolvedValue(undefined);
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    expect(historyCallbacks.size).toBe(0);
  });

  it("retains exact packet words until the authoritative region echo", async () => {
    await commit(edited);
    expect(result.status).toBe("confirming");
    expect(result.editableEvents).toEqual(edited);
    expect(send).toHaveBeenCalledWith(edited);
    serverEvents = edited;
    render();
    expect(result.status).toBe("idle");
    expect(result.error).toBeNull();
  });

  it("preserves rejected event drafts and retries only after explicit action", async () => {
    send.mockRejectedValueOnce(new Error("Core unavailable"));
    await commit(edited);
    expect(result.error).toBe("Core unavailable");
    expect(result.canRetry).toBe(true);
    expect(result.editableEvents).toEqual(edited);
    await act(async () => result.retryDraft());
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("confirming");
    serverEvents = edited;
    render();
    expect(result.status).toBe("idle");
  });

  it("retires delayed replies when the active project epoch changes", async () => {
    const pending = deferred();
    send.mockReturnValueOnce(pending.promise);
    await commit(edited);
    resetKey = "show:2";
    serverEvents = original;
    render();
    await act(async () => pending.reject(new Error("Old project failure")));
    expect(result.editableEvents).toEqual(original);
    expect(result.status).toBe("idle");
    expect(result.error).toBeNull();
  });

  it("retires drafts at the shared Undo/Redo history boundary", async () => {
    const pending = deferred();
    send.mockReturnValueOnce(pending.promise);
    await commit(edited);
    act(() => historyCallbacks.forEach((callback) => callback()));
    await act(async () => pending.reject(new Error("Late rejection")));
    expect(result.editableEvents).toEqual(original);
    expect(result.status).toBe("idle");
    expect(result.error).toBeNull();
  });

  it("copies word arrays before retaining a pending draft", async () => {
    const mutable = [{ beat: 2, wordCount: 2, words: [0x40b04a00, 0x7654_3210] }];
    await commit(mutable);
    mutable[0].words[1] = 0;
    expect(result.editableEvents[0].words[1]).toBe(0x7654_3210);
  });
});
