/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MidiNoteRow } from "@/lib/state/types";
import { sameEditableNotes,
  usePianoRollNoteDraft } from "@/screens/editor/pianoroll/hooks/usePianoRollNoteDraft";

const historyCallbacks = vi.hoisted(() => new Set<() => void>());
vi.mock("@/lib/state/historyNavigation", () => ({ subscribeHistoryBoundary: (callback: () => void) => {
  historyCallbacks.add(callback);
  return () => historyCallbacks.delete(callback);
} }));
const note = (patch: Partial<MidiNoteRow> = {}): MidiNoteRow => ({ id: 1, pitch: 60,
  startBeats: 0, durationBeats: 1, velocity: 0.8, releaseVelocity: 0.5, probability: 1, ...patch });
const original = [note()];
const edited = [note({ pitch: 62 })];
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
};

describe("complete MIDI note acknowledgement", () => {
  it("matches Core's reordered float snapshot and omitted optional defaults", () => {
    const a = note({ velocity: Math.fround(0.8), pan: -1, channel: 0, muted: false, tuningOffsetCents: 0 });
    const b = note({ id: 2, pitch: 64 });
    expect(sameEditableNotes([note(), b], [b, a])).toBe(true);
  });

  it("rejects a partial edit echo for every optional MIDI note field", () => {
    for (const patch of [{ releaseVelocity: 0.4 }, { probability: 0.7 }, { pan: 64 },
      { channel: 2 }, { muted: true }, { tuningOffsetCents: 8 }]) {
      expect(sameEditableNotes([note(patch)], original)).toBe(false);
    }
    expect(sameEditableNotes([note(), note()], [note(), note({ id: 2 })])).toBe(false);
  });

  it("requires the complete MIDI 2.0 shadow without reducing its precision", () => {
    const midi2 = { group: 1, velocity: 52000, releaseVelocity: 31000, attributeType: 3, attributeData: 14000,
      releaseAttributeType: 4, releaseAttributeData: 25000 };
    const precise = [note({ midi2 })];
    expect(sameEditableNotes(precise, original)).toBe(false);
    for (const field of Object.keys(midi2) as Array<keyof typeof midi2>) {
      expect(sameEditableNotes(precise, [note({ midi2: { ...midi2, [field]: midi2[field] + 1 } })])).toBe(false);
    }
    expect(sameEditableNotes(precise, [note({ midi2: { ...midi2 } })])).toBe(true);
  });
});

describe("Piano Roll recoverable note drafts", () => {
  let root: Root;
  let container: HTMLDivElement;
  let result: ReturnType<typeof usePianoRollNoteDraft>;
  let regionId: string;
  let resetKey: string;
  let serverNotes: MidiNoteRow[];
  let send: ReturnType<typeof vi.fn<(notes: MidiNoteRow[]) => void | Promise<void>>>;

  function Harness() {
    result = usePianoRollNoteDraft({ regionId, resetKey, notes: serverNotes, onNotesChange: send,
      confirmationTimeoutMs: 1000 });
    return null;
  }
  const render = () => act(() => root.render(createElement(Harness)));
  const commit = async (notes: MidiNoteRow[]) => {
    await act(async () => { result.commitNotes(notes); });
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    regionId = "midi-region:1";
    resetKey = "show:1";
    serverNotes = original;
    send = vi.fn().mockResolvedValue(undefined);
    render();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    expect(historyCallbacks.size).toBe(0);
  });

  it("retains the admitted edit until the complete Core snapshot matches", async () => {
    await commit(edited);
    expect(result.status).toBe("confirming");
    expect(result.editableNotes).toEqual(edited);
    render();
    expect(result.editableNotes).toEqual(edited);
    serverNotes = edited;
    render();
    expect(result.status).toBe("idle");
    expect(result.error).toBeNull();
  });

  it("preserves a failed draft and supports explicit retry then confirmation", async () => {
    send.mockRejectedValueOnce(new Error("Core unavailable"));
    await commit(edited);
    expect(result.status).toBe("error");
    expect(result.error).toBe("Core unavailable");
    expect(result.canRetry).toBe(true);
    expect(result.getEditableNotes()).toEqual(edited);
    await act(async () => result.retryDraft());
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("confirming");
    serverNotes = edited;
    render();
    expect(result.status).toBe("idle");
  });

  it("submits each finished gesture before history and ignores stale completion", async () => {
    const first = deferred();
    send.mockReturnValueOnce(first.promise);
    await commit(edited);
    await commit([note({ pitch: 70 })]);
    await commit([note({ pitch: 100 })]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((call) => call[0][0].pitch)).toEqual([62, 70, 100]);
    expect(result.getEditableNotes()[0].pitch).toBe(100);
    await act(async () => first.resolve());
    expect(send).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("confirming");
    serverNotes = edited;
    render();
    expect(result.editableNotes[0].pitch).toBe(100);
    serverNotes = [note({ pitch: 100 })];
    render();
    expect(result.status).toBe("idle");
  });

  it("does not overwrite a newer draft when a superseded request rejects", async () => {
    const first = deferred();
    send.mockReturnValueOnce(first.promise);
    await commit(edited);
    await commit([note({ pitch: 70 })]);
    await act(async () => first.reject(new Error("Old request rejected")));
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.editableNotes[0].pitch).toBe(70);
    expect(result.error).toBeNull();
  });

  it("keeps the restoration edit when a user returns to the original before admission", async () => {
    const first = deferred();
    send.mockReturnValueOnce(first.promise);
    await commit(edited);
    await commit(original);
    render();
    expect(result.status).toBe("confirming");
    await act(async () => first.resolve());
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual(original);
    expect(result.status).toBe("idle");
  });

  it("retains an unconfirmed draft with an explicit timeout and no blind retry", async () => {
    await commit(edited);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.status).toBe("uncertain");
    expect(result.error).toContain("may still be queued");
    expect(result.canRetry).toBe(false);
    expect(result.editableNotes).toEqual(edited);
    act(() => result.retryDraft());
    expect(send).toHaveBeenCalledOnce();
    serverNotes = edited;
    render();
    expect(result.error).toBeNull();
    expect(result.status).toBe("idle");
  });

  it("bounds waiting when an older admission hangs during a newer edit", async () => {
    const first = deferred();
    send.mockReturnValueOnce(first.promise);
    await commit(edited);
    await commit([note({ pitch: 70 })]);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.status).toBe("uncertain");
    expect(result.editableNotes[0].pitch).toBe(70);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retires pending operations at a history boundary and ignores late rejection", async () => {
    const first = deferred();
    send.mockReturnValueOnce(first.promise);
    await commit(edited);
    act(() => historyCallbacks.forEach((callback) => callback()));
    await act(async () => first.reject(new Error("Late failure")));
    expect(result.error).toBeNull();
    expect(result.status).toBe("idle");
    expect(result.editableNotes).toEqual(original);
  });

  it("retires the previous region when a new one opens", async () => {
    const first = deferred();
    send.mockReturnValueOnce(first.promise);
    await commit(edited);
    regionId = "midi-region:2";
    serverNotes = [note({ id: 20, pitch: 80 })];
    render();
    await act(async () => first.reject(new Error("Old region unavailable")));
    expect(result.editableNotes).toEqual(serverNotes);
    expect(result.error).toBeNull();
  });

  it("preserves optional MIDI 2.0 fields without retaining mutable caller objects", async () => {
    const precise = note({ pitch: 62, midi2: { group: 1, velocity: 52000,
      releaseVelocity: 31000, attributeType: 3, attributeData: 14000 } });
    await commit([precise]);
    precise.midi2!.attributeData = 0;
    expect(result.getEditableNotes()[0].midi2?.attributeData).toBe(14000);
    serverNotes = [note({ pitch: 62 })];
    render();
    expect(result.status).toBe("confirming");
    serverNotes = [note({ pitch: 62, midi2: { ...result.getEditableNotes()[0].midi2! } })];
    render();
    expect(result.status).toBe("idle");
  });

  it("retires drafts when a project reopens with the same region/note IDs", async () => {
    const first = deferred();
    send.mockReturnValueOnce(first.promise);
    await commit(edited);
    resetKey = "show:2";
    serverNotes = [note({ pitch: 80 })];
    render();
    expect(result.editableNotes).toEqual(serverNotes);
    expect(result.getEditableNotes()).toEqual(serverNotes);
    await act(async () => first.reject(new Error("Old project unavailable")));
    act(() => vi.advanceTimersByTime(2000));
    expect(result.error).toBeNull();
    expect(result.status).toBe("idle");
  });

  it("updates edited MIDI 2.0 velocity shadows before matching Core's echo", async () => {
    const midi2 = { group: 4, velocity: 52000, releaseVelocity: 31000, attributeType: 3, attributeData: 14000 };
    serverNotes = [note({ midi2 })];
    render();
    await commit([note({ velocity: 0.3, releaseVelocity: 0.7, midi2 })]);
    const sent = send.mock.calls[0][0];
    expect(sent[0].midi2).toEqual({ ...midi2, velocity: Math.round(0.3 * 65535),
      releaseVelocity: Math.round(0.7 * 65535) });
    expect(result.editableNotes).toEqual(sent);
    serverNotes = sent;
    render();
    expect(result.status).toBe("idle");
    expect(result.error).toBeNull();
  });

  it("does not submit a no-op and safely discards a failed draft", async () => {
    await commit(original);
    expect(send).not.toHaveBeenCalled();
    send.mockRejectedValueOnce(new Error("Rejected"));
    await commit(edited);
    act(() => result.discardDraft());
    expect(result.error).toBeNull();
    expect(result.editableNotes).toEqual(original);
    expect(result.status).toBe("idle");
  });
});
