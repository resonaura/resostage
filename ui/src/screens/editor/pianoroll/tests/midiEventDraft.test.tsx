/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MidiClipEventRow } from "@/lib/state/types";
import { usePianoRollMidiEventDraft } from "@/screens/editor/pianoroll/hooks/usePianoRollMidiEventDraft";

const historyCallbacks = vi.hoisted(() => new Set<() => void>());
vi.mock("@/lib/state/historyNavigation", () => ({
  subscribeHistoryBoundary: (callback: () => void) => {
    historyCallbacks.add(callback);
    return () => historyCallbacks.delete(callback);
  },
}));

const original: MidiClipEventRow[] = [{ beat: 1, status: 0xb0, data: [64, 0] }];
const edited: MidiClipEventRow[] = [
  { beat: 2, status: 0xb0, data: [64, 127] },
  { beat: 1, status: 0x91, data: [60, 90] },
];
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
};

describe("Piano Roll raw MIDI event drafts", () => {
  let root: Root;
  let container: HTMLDivElement;
  let result: ReturnType<typeof usePianoRollMidiEventDraft>;
  let regionId: string;
  let resetKey: string;
  let serverEvents: MidiClipEventRow[];
  let send: ReturnType<typeof vi.fn<(events: MidiClipEventRow[]) => void | Promise<void>>>;

  function Harness() {
    result = usePianoRollMidiEventDraft({
      regionId,
      resetKey,
      events: serverEvents,
      onEventsChange: send,
      confirmationTimeoutMs: 1000,
    });
    return null;
  }

  const render = () => act(() => root.render(createElement(Harness)));
  const commit = async (events: MidiClipEventRow[]) => {
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

  it("retains the full event edit until Core echoes the stable time-sorted list", async () => {
    await commit(edited);
    expect(result.status).toBe("confirming");
    expect(result.editableEvents).toEqual(edited);
    serverEvents = [edited[1], edited[0]];
    render();
    expect(result.status).toBe("idle");
    expect(result.error).toBeNull();
  });

  it("keeps rejected edits recoverable and retries only after explicit action", async () => {
    send.mockRejectedValueOnce(new Error("Core unavailable"));
    await commit(edited);
    expect(result.error).toBe("Core unavailable");
    expect(result.canRetry).toBe(true);
    expect(result.editableEvents).toEqual(edited);
    await act(async () => result.retryDraft());
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("confirming");
    serverEvents = [edited[1], edited[0]];
    render();
    expect(result.status).toBe("idle");
  });

  it("does not let a late admission result survive an epoch change", async () => {
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

  it("retires a draft at a shared Undo/Redo history boundary", async () => {
    const pending = deferred();
    send.mockReturnValueOnce(pending.promise);
    await commit(edited);
    act(() => historyCallbacks.forEach((callback) => callback()));
    await act(async () => pending.reject(new Error("Late rejection")));
    expect(result.editableEvents).toEqual(original);
    expect(result.status).toBe("idle");
    expect(result.error).toBeNull();
  });

  it("copies event byte arrays before retaining a draft", async () => {
    const mutable = [{ beat: 2, status: 0xb0, data: [74, 90] }];
    await commit(mutable);
    mutable[0].data[1] = 1;
    expect(result.editableEvents[0].data).toEqual([74, 90]);
  });
});
