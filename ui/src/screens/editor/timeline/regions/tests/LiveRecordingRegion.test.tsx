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

  async function render(
    recording: Recording,
    laneHeight = 56,
    viewport = { scrollLeft: 200, viewportWidth: 100 },
  ) {
    await act(async () => root.render(createElement(LiveRecordingRegion, {
      recording, songOffsetSec: 0, sampleRate: 48000, pxPerSec: 100,
      laneHeight, bpm: 120, rowColor: "#30d158",
      viewport,
    })));
  }

  it("shows unobstructed, track-tinted content with a bounded visible canvas", async () => {
    await render(audioRecording);
    expect(container.textContent).toBe("");
    const region = container.firstElementChild as HTMLDivElement;
    expect(region.getAttribute("aria-label")).toBe("Audio recording preview");
    expect(region.style.background).toContain("var(--rs-record)");
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
    expect(note.style.background).toContain("var(--rs-record)");
    await render({ ...midi, midiNotes: [{ ...midi.midiNotes![0], durationBeats: 4 }] }, 22);
    expect((container.querySelector("[data-active]") as HTMLSpanElement).style.width).toBe("200px");
  });

  it("renders live controller edges and per-channel pedal spans from telemetry", async () => {
    const midi: Recording = {
      ...audioRecording,
      kind: 1,
      midiControllers: [
        { id: 0, controller: 64, channel: 0, value: 127, beat: 2 },
        { id: 1, controller: 64, channel: 0, value: 0, beat: 8 },
        { id: 2, controller: 65, channel: 1, value: 1, beat: 4 },
      ],
    };
    await render(midi, 56, { scrollLeft: 0, viewportWidth: 2000 });

    const markers = [...container.querySelectorAll<HTMLElement>("[title*='value']")];
    expect(markers).toHaveLength(3);
    expect(markers[0].title).toContain("CC 64 · Sustain");
    const heldSpans = [...container.querySelectorAll<HTMLElement>("[title*='held']")];
    expect(heldSpans).toHaveLength(2);
    expect(heldSpans[0].title).toContain("MIDI channel 1");
    expect(heldSpans[1].title).toContain("CC 65 · Portamento");
  });

  it("warns when bounded controller telemetry omits events from the live preview", async () => {
    const midi: Recording = {
      ...audioRecording,
      kind: 1,
      midiControllerEventCount: 3,
      midiControllers: [{ id: 2, controller: 1, channel: 0, value: 96, beat: 2 }],
    };
    await render(midi, 56, { scrollLeft: 0, viewportWidth: 2000 });

    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label"))
      .toContain("live preview is incomplete");
    expect(container.querySelector('[role="img"]')?.textContent).toBe("!");
    expect(container.querySelector('[title*="CC 1"]')).not.toBeNull();
  });

  it("distinguishes exhausted MIDI capture from a telemetry-only preview gap", async () => {
    const midi: Recording = {
      ...audioRecording,
      kind: 1,
      midiControllerEventCount: 4096,
      midiControllerCaptureTruncated: true,
      midiControllers: [{ id: 4095, controller: 1, channel: 0, value: 96, beat: 2 }],
    };
    await render(midi, 56, { scrollLeft: 0, viewportWidth: 2000 });

    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label"))
      .toContain("Later controller changes were not recorded");
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

  it("renders concurrent multi-track recording regions independently", async () => {
    const track1Audio: Recording = {
      recordingId: "take-audio-track-1", trackId: "audio::track:1", timelineStartSample: 0,
      capturedFrames: 480000, channelCount: 2, state: 1, kind: 0,
    };
    const track2Midi: Recording = {
      recordingId: "take-midi-track-2", trackId: "audio::track:2", timelineStartSample: 0,
      capturedFrames: 480000, channelCount: 1, state: 1, kind: 1,
      midiNotes: [{ id: 10, pitch: 64, startBeats: 2, durationBeats: 2, velocity: 0.9, active: true }],
    };

    await act(async () => root.render(
      createElement("div", null,
        createElement(LiveRecordingRegion, {
          key: track1Audio.recordingId,
          recording: track1Audio, songOffsetSec: 0, sampleRate: 48000, pxPerSec: 100,
          laneHeight: 56, bpm: 120, rowColor: "#30d158",
          viewport: { scrollLeft: 200, viewportWidth: 100 },
        }),
        createElement(LiveRecordingRegion, {
          key: track2Midi.recordingId,
          recording: track2Midi, songOffsetSec: 0, sampleRate: 48000, pxPerSec: 100,
          laneHeight: 56, bpm: 120, rowColor: "#ff9f0a",
          viewport: { scrollLeft: 200, viewportWidth: 100 },
        }),
      ),
    ));

    const regions = container.querySelectorAll("[aria-label]");
    expect(regions.length).toBe(2);
    expect(regions[0].getAttribute("aria-label")).toBe("Audio recording preview");
    expect(regions[1].getAttribute("aria-label")).toBe("MIDI recording preview");

    // Both use the red recording branding
    expect((regions[0] as HTMLElement).style.border).toContain("var(--rs-record)");
    expect((regions[1] as HTMLElement).style.border).toContain("var(--rs-record)");

    // Audio has a canvas, MIDI has a note element
    expect(regions[0].querySelector("canvas")).not.toBeNull();
    expect(regions[1].querySelector("canvas")).toBeNull();
    expect(regions[1].querySelector("[data-active]")).not.toBeNull();

    // Live peaks called for the audio recording only
    expect(recordingApi.fetchLivePeaks).toHaveBeenCalledWith(
      "take-audio-track-1", expect.any(Number), expect.any(Number), expect.any(Number),
    );
  });
});
