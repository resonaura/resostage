/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveRecordingRegion as Recording } from "@/lib/state/types";
import { recording as recordingApi } from "@/lib/state/api";
import { LiveRecordingRegion } from "@/screens/editor/timeline/regions/components/LiveRecordingRegion";

vi.mock("@/lib/state/api", () => ({
  recording: { fetchLivePeaks: vi.fn() },
}));

const audioRecording: Recording = {
  recordingId: "take-1", trackId: "audio::track:1", timelineStartSample: 0,
  capturedFrames: 480000, channelCount: 1, state: 1, kind: 0,
};

describe("live recording region", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fillRect = vi.fn();

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fillRect.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      scale: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), fillRect,
    } as unknown as CanvasRenderingContext2D);
    vi.mocked(recordingApi.fetchLivePeaks).mockClear().mockImplementation(async (id, level = 0, first = 0) => ({
      trackId: id, level, first, count: 1, peaks: [{ min: -32768, max: 32767 }],
    }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function render(recording: Recording, laneHeight = 56) {
    await act(async () => root.render(createElement(LiveRecordingRegion, {
      recording, songOffsetSec: 0, sampleRate: 48000, pxPerSec: 100,
      laneHeight, bpm: 120, rowColor: "#30d158",
      viewport: { scrollLeft: 200, viewportWidth: 100 },
    })));
  }

  it("shows unobstructed, track-tinted content with a bounded visible canvas", async () => {
    await render(audioRecording);
    expect(container.textContent).toBe("");
    const region = container.firstElementChild as HTMLDivElement;
    expect(region.getAttribute("aria-label")).toBe("Audio recording preview");
    expect(region.style.background).toContain("#30d158");
    expect(region.style.border).toContain("var(--rs-record)");
    expect(region.className).toContain("overflow-hidden");
    expect(region.style.left).toBe("200px");
    expect(region.style.width).toBe("100px");
    expect(container.querySelector("canvas")!.width).toBe(100 * window.devicePixelRatio);
    const request = vi.mocked(recordingApi.fetchLivePeaks).mock.calls[0];
    expect(request[1]).toBeGreaterThan(0);
    expect(request[2]).toBeGreaterThan(0);
    expect(request[3]).toBeLessThanOrEqual(4096);
    const originalX = fillRect.mock.calls[0][0] as number;
    await render({ ...audioRecording, capturedFrames: 960000 });
    expect(fillRect.mock.calls.at(-1)![0]).toBe(originalX);
  });

  it("retains growing held MIDI notes and fits previews in a short track lane", async () => {
    const midi: Recording = {
      ...audioRecording, kind: 1, midiNotes: [{
        id: 1, pitch: 60, startBeats: 4, durationBeats: 2, velocity: 0.8, active: true,
      }],
    };
    await render(midi, 22);
    expect(vi.mocked(recordingApi.fetchLivePeaks)).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
    const note = container.querySelector("[data-active]") as HTMLSpanElement;
    expect(note.style.width).toBe("100px");
    expect(parseFloat(note.style.top) + parseFloat(note.style.height)).toBeLessThanOrEqual(16);
    expect(note.style.background).toContain("#30d158");
    await render({ ...midi, midiNotes: [{ ...midi.midiNotes![0], durationBeats: 4 }] }, 22);
    expect((container.querySelector("[data-active]") as HTMLSpanElement).style.width).toBe("200px");
  });

  it("retains the previous waveform while the record worker has not published a new bin", async () => {
    vi.useFakeTimers();
    await render(audioRecording);
    vi.mocked(recordingApi.fetchLivePeaks).mockResolvedValueOnce({
      trackId: audioRecording.recordingId, level: 2, first: 188, count: 0, peaks: [],
    });
    await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(recordingApi.fetchLivePeaks).toHaveBeenCalledTimes(2);
    fillRect.mockClear();
    await render(audioRecording, 64);
    expect(fillRect).toHaveBeenCalledOnce();
  });
});
