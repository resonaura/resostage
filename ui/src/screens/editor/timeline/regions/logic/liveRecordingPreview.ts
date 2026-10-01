/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

export interface RecordingPreviewViewport {
  scrollLeft: number;
  viewportWidth: number;
}

export interface RecordingPreviewWindow {
  leftPx: number;
  widthPx: number;
  /** Pixel offset into the recorded region, before viewport clipping. */
  offsetPx: number;
}

/** Keep the live canvas within the viewport instead of allocating a show-wide bitmap. */
export function recordingPreviewWindow(
  leftPx: number,
  widthPx: number,
  viewport?: RecordingPreviewViewport,
): RecordingPreviewWindow {
  if (!viewport) return { leftPx, widthPx, offsetPx: 0 };
  const start = Math.max(leftPx, viewport.scrollLeft);
  const end = Math.min(leftPx + widthPx, viewport.scrollLeft + viewport.viewportWidth);
  return { leftPx: start, widthPx: Math.max(0, end - start), offsetPx: start - leftPx };
}

// Matches AudioRecordWorker's 16 disposable live levels (128..4,194,304 frames).
const BASE_PEAK_FRAMES = 128;
const MAX_PEAK_LEVEL = 15;
const MAX_REQUEST_PEAKS = 4096;

/**
 * Request approximately one min/max bin per visible pixel from the existing
 * live pyramid. One bounded chunk covers a complete day at up to 192 kHz;
 * bins retain their actual sample coordinates while the writer completes them.
 */
export function recordingPreviewPeakRange(
  capturedFrames: number,
  sampleRate: number,
  pxPerSec: number,
  window: RecordingPreviewWindow,
): { level: number; first: number; count: number } {
  const framesPerPixel = sampleRate / Math.max(0.001, pxPerSec);
  const startFrame = Math.min(capturedFrames, Math.max(0, window.offsetPx * framesPerPixel));
  const endFrame = Math.min(capturedFrames, (window.offsetPx + window.widthPx) * framesPerPixel);
  const targetBinFrames = Math.max(framesPerPixel, (endFrame - startFrame) / MAX_REQUEST_PEAKS);
  const level = Math.max(0, Math.min(MAX_PEAK_LEVEL,
    Math.ceil(Math.log2(Math.max(BASE_PEAK_FRAMES, targetBinFrames) / BASE_PEAK_FRAMES)),
  ));
  const framesPerBin = recordingPeakFramesPerBin(level);
  const end = Math.ceil(Math.max(0, endFrame) / framesPerBin);
  const first = Math.max(Math.floor(startFrame / framesPerBin), end - MAX_REQUEST_PEAKS);
  return { level, first, count: Math.max(1, Math.min(MAX_REQUEST_PEAKS, end - first)) };
}

export function recordingPeakFramesPerBin(level: number): number {
  return BASE_PEAK_FRAMES * 2 ** Math.max(0, Math.min(MAX_PEAK_LEVEL, level));
}

/** Full inner height belongs to notes; no space is reserved for recording chrome. */
export function recordingMidiPreviewLayout(
  pitches: readonly number[],
  contentHeight: number,
): { height: number; top: (pitch: number) => number } {
  const padding = Math.min(3, Math.max(0, contentHeight / 4));
  const areaHeight = Math.max(1, contentHeight - 2 * padding);
  let minPitch = 127;
  let maxPitch = 0;
  for (const pitch of pitches) {
    minPitch = Math.min(minPitch, pitch);
    maxPitch = Math.max(maxPitch, pitch);
  }
  const pitchSpan = pitches.length > 0 ? maxPitch - minPitch : 0;
  const height = Math.max(1, Math.min(4, areaHeight / Math.max(1, pitchSpan + 1)));
  return {
    height,
    top: (pitch) => pitchSpan > 0
      ? padding + ((maxPitch - pitch) / pitchSpan) * (areaHeight - height)
      : padding + (areaHeight - height) / 2,
  };
}
