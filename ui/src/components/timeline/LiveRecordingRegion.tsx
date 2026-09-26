import { useEffect, useRef, useState } from "react";
import { recording as recordingApi } from "../../lib/api";
import type { LiveRecordingRegion as LiveRecordingRegionType } from "../../lib/types";

export interface LiveRecordingRegionProps {
  recording: LiveRecordingRegionType;
  songOffsetSec: number;
  sampleRate: number;
  pxPerSec: number;
  laneHeight: number;
}

export function LiveRecordingRegion({
  recording,
  songOffsetSec,
  sampleRate,
  pxPerSec,
  laneHeight,
}: LiveRecordingRegionProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<Array<{ min: number; max: number }>>([]);

  const safeRate = sampleRate > 0 ? sampleRate : 48000;
  const startSec = songOffsetSec + Math.max(0, recording.timelineStartSample) / safeRate;
  const durationSec = Math.max(0, recording.capturedFrames) / safeRate;
  const leftPx = startSec * pxPerSec;
  const widthPx = Math.max(12, durationSec * pxPerSec);

  // Poll live peak chunk data while recording is active
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pollPeaks() {
      if (cancelled) return;
      try {
        const resp = await recordingApi.fetchLivePeaks(recording.recordingId, 0, 0, 1024);
        if (!cancelled && resp && Array.isArray(resp.peaks)) {
          setPeaks(resp.peaks);
        }
      } catch {
        // Backend live peaks might still be initializing
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
  }, [recording.recordingId, recording.state]);

  // Draw real-time bipolar waveform onto the canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(widthPx));
    const h = Math.max(1, Math.round(laneHeight));

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    // Centerline
    const midY = h / 2;
    ctx.strokeStyle = "rgba(255, 69, 58, 0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    if (peaks.length === 0) return;

    // Draw min/max peaks
    ctx.strokeStyle = "rgba(255, 235, 235, 0.95)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();

    const step = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i];
      const x = i * step;
      // Normalise int16 [-32768, 32767] to [-1, 1]
      const minNorm = p.min / 32768.0;
      const maxNorm = p.max / 32768.0;

      const yTop = midY - maxNorm * (midY - 2);
      const yBottom = midY - minNorm * (midY - 2);

      ctx.moveTo(x, Math.min(yTop, yBottom));
      ctx.lineTo(x, Math.max(yTop, yBottom));
    }
    ctx.stroke();
  }, [peaks, widthPx, laneHeight]);

  const elapsedMins = Math.floor(durationSec / 60);
  const elapsedSecs = (durationSec % 60).toFixed(1).padStart(4, "0");

  return (
    <div
      className="absolute top-0 bottom-0 pointer-events-none rounded border border-[#ff453a] bg-[#ff453a]/30 shadow-[0_0_12px_rgba(255,69,58,0.45)] overflow-hidden z-20"
      style={{
        left: `${leftPx}px`,
        width: `${widthPx}px`,
        height: `${laneHeight}px`,
      }}
    >
      {/* Recording badge */}
      <div className="absolute top-1 left-1.5 flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-[#ff453a] text-white text-[9px] font-black uppercase tracking-wider shadow-sm z-10">
        <span className="inline-block w-2 h-2 rounded-full bg-white animate-ping" />
        <span>REC {elapsedMins}:{elapsedSecs}</span>
      </div>

      {/* Live waveform canvas */}
      <canvas
        ref={canvasRef}
        className="w-full h-full block"
        style={{ width: `${widthPx}px`, height: `${laneHeight}px` }}
      />
    </div>
  );
}
