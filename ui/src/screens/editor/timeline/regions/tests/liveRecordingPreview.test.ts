/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  mergeLiveMidiControllerEvents,
  recordingMidiPreviewLayout,
  recordingPeakFramesPerBin,
  recordingPreviewPeakRange,
  recordingPreviewWindow,
} from "@/screens/editor/timeline/regions/logic/liveRecordingPreview";

describe("live recording preview geometry", () => {
  it("clips a growing recording to the visible timeline and retains its source offset", () => {
    expect(recordingPreviewWindow(100, 10000, { scrollLeft: 5000, viewportWidth: 900 }))
      .toEqual({ leftPx: 5000, widthPx: 900, offsetPx: 4900 });
    expect(recordingPreviewWindow(100, 100, { scrollLeft: 5000, viewportWidth: 900 }).widthPx)
      .toBe(0);
  });

  it("fetches the visible sample window instead of always fetching the beginning of the take", () => {
    const window = recordingPreviewWindow(0, 6000, { scrollLeft: 5000, viewportWidth: 1000 });
    const range = recordingPreviewPeakRange(60 * 48000, 48000, 100, window);
    const framesPerBin = recordingPeakFramesPerBin(range.level);
    expect(range.first * framesPerBin).toBeLessThanOrEqual(50 * 48000);
    expect((range.first + 1) * framesPerBin).toBeGreaterThan(50 * 48000);
    expect(range.count).toBeGreaterThan(900);
    expect(range.count).toBeLessThanOrEqual(4096);
  });

  it.each([48000, 192000])("covers the entire four-hour overview in one bounded request at %i Hz", (sampleRate) => {
    const durationSec = 4 * 3600;
    const pxPerSec = 1200 / durationSec;
    const range = recordingPreviewPeakRange(durationSec * sampleRate, sampleRate, pxPerSec,
      recordingPreviewWindow(0, 1200));
    expect(range.level).toBeGreaterThan(5);
    expect(range.first).toBe(0);
    expect(range.count).toBeLessThanOrEqual(4096);
    expect(range.count * recordingPeakFramesPerBin(range.level))
      .toBeGreaterThanOrEqual(durationSec * sampleRate);
  });

  it.each([48000, 192000])("covers both edges of a scrolled hour-long viewport at %i Hz", (sampleRate) => {
    const durationSec = 4 * 3600;
    const pxPerSec = 1200 / (90 * 60);
    const window = recordingPreviewWindow(0, durationSec * pxPerSec,
      { scrollLeft: 90 * 60 * pxPerSec, viewportWidth: 1200 });
    const range = recordingPreviewPeakRange(durationSec * sampleRate, sampleRate, pxPerSec, window);
    const framesPerBin = recordingPeakFramesPerBin(range.level);
    const startFrame = (window.offsetPx / pxPerSec) * sampleRate;
    const endFrame = ((window.offsetPx + window.widthPx) / pxPerSec) * sampleRate;
    expect(range.first * framesPerBin).toBeLessThanOrEqual(startFrame);
    expect((range.first + 1) * framesPerBin).toBeGreaterThan(startFrame);
    expect((range.first + range.count) * framesPerBin).toBeGreaterThanOrEqual(endFrame);
    expect(range.count).toBeLessThanOrEqual(4096);
  });

  it("keeps a full-day 192 kHz overview within the live level and chunk bounds", () => {
    const durationSec = 24 * 3600;
    const range = recordingPreviewPeakRange(durationSec * 192000, 192000, 4096 / durationSec,
      recordingPreviewWindow(0, 4096));
    expect(range.level).toBe(15);
    expect(range.first).toBe(0);
    expect(range.count).toBeLessThanOrEqual(4096);
    expect(range.count * recordingPeakFramesPerBin(range.level)).toBeGreaterThanOrEqual(durationSec * 192000);
  });

  it("fits both extreme pitches and a centered held note into short lanes", () => {
    const spread = recordingMidiPreviewLayout([0, 127], 16);
    expect(spread.top(127)).toBeGreaterThanOrEqual(0);
    expect(spread.top(0) + spread.height).toBeLessThanOrEqual(16);
    const single = recordingMidiPreviewLayout([60], 16);
    expect(single.top(60) + single.height / 2).toBe(8);
    expect(single.height).toBe(4);
  });

  it("retains distinct MIDI controller edges across latest-wins telemetry snapshots", () => {
    const down = { id: 0, controller: 64, channel: 0, value: 127, beat: 2 };
    const release = { id: 1, controller: 64, channel: 0, value: 0, beat: 6 };
    expect(mergeLiveMidiControllerEvents([down], [release, down])).toEqual([down, release]);
    expect(mergeLiveMidiControllerEvents([down], [{ ...release, beat: Number.NaN }]))
      .toEqual([down]);
    expect(mergeLiveMidiControllerEvents([down, release], [], 1)).toEqual([release]);
    expect(mergeLiveMidiControllerEvents([down], [], 0)).toEqual([]);
  });
});
