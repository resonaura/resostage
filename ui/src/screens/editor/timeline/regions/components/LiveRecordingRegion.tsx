/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useRef, useState } from "react";
import { recording as recordingApi } from "@/lib/state/api";
import type {
  LivePeakChunkResponse,
  LiveRecordingRegion as LiveRecordingRegionType,
} from "@/lib/state/types";
import {
  recordingMidiPreviewLayout,
  recordingPeakFramesPerBin,
  recordingPreviewPeakRange,
  recordingPreviewWindow,
  type RecordingPreviewViewport,
} from "@/screens/editor/timeline/regions/logic/liveRecordingPreview";

export interface LiveRecordingRegionProps {
  recording: LiveRecordingRegionType;
  songOffsetSec: number;
  sampleRate: number;
  pxPerSec: number;
  laneHeight: number;
  bpm: number;
  rowColor: string;
  viewport?: RecordingPreviewViewport;
}

export function LiveRecordingRegion({
  recording,
  songOffsetSec,
  sampleRate,
  pxPerSec,
  laneHeight,
  bpm,
  rowColor,
  viewport,
}: LiveRecordingRegionProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peakChunk, setPeakChunk] = useState<{
    recordingId: string;
    data: LivePeakChunkResponse;
  } | null>(null);

  const safeRate = sampleRate > 0 ? sampleRate : 48000;
  const startSec =
    songOffsetSec + Math.max(0, recording.timelineStartSample) / safeRate;
  const durationSec = Math.max(0, recording.capturedFrames) / safeRate;
  const leftPx = startSec * pxPerSec;
  const widthPx = Math.max(12, durationSec * pxPerSec);
  const preview = recordingPreviewWindow(leftPx, widthPx, viewport);
  const insetPx = laneHeight <= 32 ? 2 : 4;
  const previewHeight = Math.max(1, laneHeight - insetPx * 2);
  const contentHeight = Math.max(1, previewHeight - 2);
  // The timer reads fresh geometry without restarting at telemetry frequency.
  const peakRequestRef = useRef({ capturedFrames: recording.capturedFrames, safeRate, pxPerSec, preview });
  peakRequestRef.current = { capturedFrames: recording.capturedFrames, safeRate, pxPerSec, preview };

  // Poll live peak chunk data while recording is active
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pollPeaks() {
      if (cancelled) return;
      if (recording.kind === 1) return;
      const request = peakRequestRef.current;
      if (request.preview.widthPx > 0) {
        try {
          const range = recordingPreviewPeakRange(
            request.capturedFrames, request.safeRate, request.pxPerSec, request.preview,
          );
          const resp = await recordingApi.fetchLivePeaks(
            recording.recordingId, range.level, range.first, range.count,
          );
          // The writer may not have completed the newest mip bin yet. Retain
          // the last valid sample positions until a nonempty chunk arrives.
          if (!cancelled && resp && Array.isArray(resp.peaks) && resp.peaks.length > 0) {
            setPeakChunk({ recordingId: recording.recordingId, data: resp });
          }
        } catch {
          // Backend live peaks might still be initializing.
        }
      }

      if (!cancelled && recording.state === 1) {
        timer = setTimeout(pollPeaks, 80); // ~12 fps live waveform refresh
      }
    }

    void pollPeaks();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [recording.recordingId, recording.state, recording.kind]);

  // Draw real-time bipolar waveform onto the canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || recording.kind === 1) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.ceil(preview.widthPx));
    const h = Math.max(1, Math.round(contentHeight));

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    // Centerline
    const midY = h / 2;
    ctx.strokeStyle = rowColor;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    if (!peakChunk || peakChunk.recordingId !== recording.recordingId) return;
    const { peaks, first, level } = peakChunk.data;
    if (peaks.length === 0) return;

    // Draw min/max peaks
    ctx.fillStyle = rowColor;
    ctx.globalAlpha = 0.95;

    // Bins retain their real sample positions as the region grows and scrolls.
    const step = (recordingPeakFramesPerBin(level) / safeRate) * pxPerSec;
    const amplitude = Math.max(0, midY - 2);
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i];
      const x = (first + i) * step - preview.offsetPx;
      if (x + step < 0 || x >= w) continue;
      // Normalise int16 [-32768, 32767] to [-1, 1]
      const minNorm = Math.max(-1, Math.min(1, p.min / 32768));
      const maxNorm = Math.max(-1, Math.min(1, p.max / 32768));

      const yTop = midY - maxNorm * amplitude;
      const yBottom = midY - minNorm * amplitude;
      ctx.fillRect(x, Math.min(yTop, yBottom), Math.max(1, step), Math.max(1, Math.abs(yBottom - yTop)));
    }
  }, [peakChunk, preview.widthPx, preview.offsetPx, contentHeight, recording.kind, recording.recordingId, safeRate, pxPerSec, rowColor]);

  const isMidi = recording.kind === 1;
  const safeBpm = bpm > 0 ? bpm : 120;
  const recordingStartBeat =
    (Math.max(0, recording.timelineStartSample) / safeRate) * (safeBpm / 60);
  const midiNotes = recording.midiNotes ?? [];
  const midiLayout = recordingMidiPreviewLayout(midiNotes.map((note) => note.pitch), contentHeight);

  if (preview.widthPx <= 0) return null;

  return (
    <div
      aria-label={isMidi ? "MIDI recording preview" : "Audio recording preview"}
      className="absolute pointer-events-none rounded-md overflow-hidden z-20"
      style={{
        top: `${insetPx}px`,
        left: `${preview.leftPx}px`,
        width: `${preview.widthPx}px`,
        height: `${previewHeight}px`,
        border: "1px solid var(--rs-record)",
        background: `color-mix(in oklab, ${rowColor} 22%, var(--color-background-secondary))`,
        boxShadow: "inset 0 2px 0 color-mix(in oklab, var(--rs-record) 55%, transparent)",
      }}
    >
      {isMidi ? (
        <div className="absolute inset-0 overflow-hidden">
          {midiNotes.map((note) => {
            const noteStartSec =
              ((note.startBeats - recordingStartBeat) * 60) / safeBpm;
            const noteDurationSec = Math.max(
              0.04,
              (note.durationBeats * 60) / safeBpm,
            );
            return (
              <span
                key={`${note.id}:${note.pitch}`}
                data-active={note.active || undefined}
                className="absolute rounded-sm"
                style={{
                  left: `${Math.max(0, noteStartSec * pxPerSec) - preview.offsetPx}px`,
                  width: `${Math.max(3, noteDurationSec * pxPerSec)}px`,
                  top: `${midiLayout.top(note.pitch)}px`,
                  height: `${midiLayout.height}px`,
                  background: `color-mix(in oklab, ${rowColor} 65%, var(--foreground))`,
                  boxShadow: note.active ? "inset -2px 0 0 var(--foreground)" : undefined,
                  opacity: 0.55 + Math.min(1, note.velocity) * 0.45,
                }}
              />
            );
          })}
        </div>
      ) : (
        /* Live waveform canvas */
        <canvas
          ref={canvasRef}
          className="w-full h-full block"
          style={{ width: `${preview.widthPx}px`, height: `${contentHeight}px` }}
        />
      )}
      {/* A quiet capture edge keeps the live boundary visible without obscuring content. */}
      {preview.offsetPx + preview.widthPx >= widthPx - 1 && (
        <div className="absolute inset-y-0 right-0 w-0.5 bg-(--rs-record)" />
      )}
    </div>
  );
}
