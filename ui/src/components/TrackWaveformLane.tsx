import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchWaveformRaw } from "../lib/api";
import type { PeakLevelData } from "../lib/types";

export const LANE_HEIGHT = 56;

/** Pick the peak pyramid level whose bin width matches the current zoom. */
export function pickLevelForZoom(
  levels: PeakLevelData[],
  durationSeconds: number,
  pxPerSec: number,
): PeakLevelData | null {
  if (levels.length === 0 || durationSeconds <= 0 || pxPerSec <= 0) return null;
  const pixelDurationSec = 1 / pxPerSec;
  const finestBins = levels[0].min.length || 1;
  if (durationSeconds / finestBins > pixelDurationSec) return null;
  let best = levels[0];
  for (const level of levels) {
    const bins = level.min.length || 1;
    if (durationSeconds / bins <= pixelDurationSec) best = level;
    else break;
  }
  return best;
}

function cubicHermite(
  y0: number,
  y1: number,
  y2: number,
  y3: number,
  mu: number,
): number {
  const mu2 = mu * mu;
  const a0 = y3 - y2 - y0 + y1;
  const a1 = y0 - y1 - a0;
  const a2 = y2 - y0;
  const a3 = y1;
  return a0 * mu * mu2 + a1 * mu2 + a2 * mu + a3;
}

export function TrackWaveformLane({
  levels,
  durationSeconds,
  regionFile,
  gestureActive,
  verticalZoom,
  contentWidth,
  scrollLeft,
  viewportWidth,
  pxPerSec,
  color,
  muted,
  /** Offset into the source file (region trim / split). */
  sourceOffsetSec = 0,
  /** When true, no lane chrome — meant to sit inside a clipped region. */
  embedded = false,
  loop = false,
  loopLengthSec = 0,
}: {
  levels: PeakLevelData[];
  durationSeconds: number;
  regionFile?: string;
  gestureActive: boolean;
  verticalZoom: number;
  contentWidth: number;
  scrollLeft: number;
  viewportWidth: number;
  pxPerSec: number;
  color: string;
  muted: boolean;
  sourceOffsetSec?: number;
  embedded?: boolean;
  loop?: boolean;
  loopLengthSec?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rawWindow, setRawWindow] = useState<{
    sampleRate: number;
    startSec: number;
    samples: number[];
  } | null>(null);

  const needsRaw =
    pickLevelForZoom(levels, durationSeconds, pxPerSec) === null &&
    levels.length > 0;

  // Quantize the fetch range so panning by a pixel at a time doesn't refire
  // a network request every frame -- half-second buckets with a half-second
  // margin on each side comfortably cover a viewport's worth of scrolling
  // between refetches. Times are in *source file* seconds.
  const visibleStartSec = sourceOffsetSec + scrollLeft / pxPerSec;
  const visibleEndSec =
    sourceOffsetSec + (scrollLeft + viewportWidth) / pxPerSec;
  const quantStart = Math.max(0, Math.floor(visibleStartSec / 0.5) * 0.5 - 0.5);
  const quantEnd = Math.min(
    durationSeconds,
    Math.ceil(visibleEndSec / 0.5) * 0.5 + 0.5,
  );

  useEffect(() => {
    if (!needsRaw || !regionFile || gestureActive || quantEnd <= quantStart)
      return;
    let cancelled = false;
    const endSec = Math.min(quantEnd, quantStart + 9); // stay under the server's window cap
    fetchWaveformRaw(regionFile, quantStart, endSec)
      .then((res) => {
        if (!cancelled && res.samples.length > 0) setRawWindow(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRaw, regionFile, gestureActive, quantStart, quantEnd]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportWidth <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const renderWidth = Math.min(viewportWidth, contentWidth);
    const laneH = Math.max(20, Math.round(LANE_HEIGHT * verticalZoom));
    const targetW = Math.max(1, Math.floor(renderWidth * dpr));
    const targetH = Math.max(1, Math.floor((laneH - 6) * dpr));

    // Only resize canvas backing store when dimensions actually change to prevent zoom/scroll flickering
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${renderWidth}px`;
      canvas.style.height = `${laneH - 6}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, renderWidth, laneH - 6);
    if (levels.length === 0 || durationSeconds <= 0) return;

    const height = laneH - 6;
    const mid = height / 2;
    const halfH = Math.max(1, height / 2 - 2);
    const alpha = muted ? 0.35 : 1.0;
    ctx.globalAlpha = alpha;

    const isRawActive = needsRaw && rawWindow && rawWindow.samples.length > 1;
    const level =
      pickLevelForZoom(levels, durationSeconds, pxPerSec) ?? levels[0];

    if (level && !isRawActive) {
      const bins = level.min.length;
      const step = gestureActive
        ? Math.max(1, Math.floor(renderWidth / 200))
        : 1;

      // Build 1:1 aligned top and bottom vertices with range aggregation
      const topPoints: { x: number; y: number }[] = [];
      const botPoints: { x: number; y: number }[] = [];
      const rmsTopPoints: { x: number; y: number }[] = [];
      const rmsBotPoints: { x: number; y: number }[] = [];

      const availSec = Math.max(0.01, durationSeconds - sourceOffsetSec);
      const cycleSec = (loopLengthSec && loopLengthSec > 0)
        ? loopLengthSec
        : availSec;

      for (let x = 0; x <= renderWidth; x += step) {
        // Map lane-local time → source-file time (honours region trim/split & loop).
        const intoSecStart = (scrollLeft + x) / pxPerSec;
        const intoSecEnd = (scrollLeft + x + step) / pxPerSec;

        let tStartSec = sourceOffsetSec + intoSecStart;
        let tEndSec = sourceOffsetSec + intoSecEnd;

        if (loop && cycleSec > 0) {
          let mStart = intoSecStart % cycleSec;
          if (mStart < 0) mStart += cycleSec;
          tStartSec = sourceOffsetSec + mStart;

          let mEnd = intoSecEnd % cycleSec;
          if (mEnd < 0) mEnd += cycleSec;
          tEndSec = sourceOffsetSec + mEnd;
        }

        const startBin = Math.max(
          0,
          Math.min(bins - 1, Math.floor((tStartSec / durationSeconds) * bins)),
        );
        const endBin = Math.max(
          startBin,
          Math.min(bins - 1, Math.floor((tEndSec / durationSeconds) * bins)),
        );

        let maxV = -1;
        let minV = 1;
        let rmsV = 0;

        if (startBin === endBin) {
          maxV = level.max[startBin] ?? 0;
          minV = level.min[startBin] ?? 0;
          rmsV = level.rms[startBin] ?? 0;
        } else {
          for (let b = startBin; b <= endBin; ++b) {
            const mx = level.max[b] ?? 0;
            const mn = level.min[b] ?? 0;
            const rm = level.rms[b] ?? 0;
            if (maxV === -1 || mx > maxV) maxV = mx;
            if (minV === 1 || mn < minV) minV = mn;
            if (rm > rmsV) rmsV = rm;
          }
        }

        if (maxV === -1) maxV = 0;
        if (minV === 1) minV = 0;

        // Past the end of the source file (non-loop only): draw silence so trimmed tails stay flat.
        if (!loop && tStartSec >= durationSeconds) {
          maxV = 0;
          minV = 0;
          rmsV = 0;
        }

        const yTop = mid - maxV * halfH * verticalZoom;
        const yBot = mid - minV * halfH * verticalZoom;
        topPoints.push({ x, y: yTop });
        botPoints.push({ x, y: yBot });

        const rmsH = rmsV * halfH * verticalZoom;
        rmsTopPoints.push({ x, y: mid - rmsH });
        rmsBotPoints.push({ x, y: mid + rmsH });
      }

      // Outer Peak Envelope Path (continuous smooth contour)
      if (topPoints.length > 0) {
        ctx.beginPath();
        ctx.moveTo(topPoints[0].x, topPoints[0].y);
        for (let i = 1; i < topPoints.length; ++i) {
          ctx.lineTo(topPoints[i].x, topPoints[i].y);
        }
        for (let i = botPoints.length - 1; i >= 0; --i) {
          ctx.lineTo(botPoints[i].x, botPoints[i].y);
        }
        ctx.closePath();

        // Soft crisp gradient fill
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, color + "aa");
        grad.addColorStop(0.5, color + "77");
        grad.addColorStop(1, color + "aa");
        ctx.fillStyle = grad;
        ctx.fill();

        // Sharp outer contour line
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // RMS Core Fill
      if (rmsTopPoints.length > 0) {
        ctx.beginPath();
        ctx.moveTo(rmsTopPoints[0].x, rmsTopPoints[0].y);
        for (let i = 1; i < rmsTopPoints.length; ++i) {
          ctx.lineTo(rmsTopPoints[i].x, rmsTopPoints[i].y);
        }
        for (let i = rmsBotPoints.length - 1; i >= 0; --i) {
          ctx.lineTo(rmsBotPoints[i].x, rmsBotPoints[i].y);
        }
        ctx.closePath();
        ctx.fillStyle = color + "ee";
        ctx.fill();
      }
    }

    // Extreme zoom: true per-sample curve through the fetched raw window
    if (isRawActive && rawWindow) {
      const windowEndSec =
        rawWindow.startSec + rawWindow.samples.length / rawWindow.sampleRate;
      if (
        rawWindow.startSec <= visibleStartSec + 1e-6 &&
        windowEndSec >= visibleEndSec - 1e-6
      ) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        const { samples, sampleRate, startSec } = rawWindow;
        let first = true;
        for (let x = 0; x < renderWidth; ++x) {
          const tSec = sourceOffsetSec + (scrollLeft + x) / pxPerSec;
          const exactIdx = (tSec - startSec) * sampleRate;
          const baseIdx = Math.floor(exactIdx);
          const mu = exactIdx - baseIdx;
          const y0 = samples[baseIdx - 1] ?? samples[0] ?? 0;
          const y1 = samples[baseIdx] ?? 0;
          const y2 = samples[baseIdx + 1] ?? samples[samples.length - 1] ?? 0;
          const y3 = samples[baseIdx + 2] ?? samples[samples.length - 1] ?? 0;
          const v = cubicHermite(y0, y1, y2, y3, mu);
          const y = mid - v * halfH * verticalZoom;
          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
  }, [
    levels,
    durationSeconds,
    needsRaw,
    rawWindow,
    gestureActive,
    verticalZoom,
    contentWidth,
    scrollLeft,
    viewportWidth,
    pxPerSec,
    color,
    muted,
    sourceOffsetSec,
    visibleStartSec,
    visibleEndSec,
  ]);

  return (
    <div
      className={
        embedded
          ? "pointer-events-none absolute inset-0 flex items-center"
          : "relative flex items-center border-b border-default/15 bg-default/10"
      }
      style={
        embedded
          ? { opacity: muted ? 0.4 : 1 }
          : {
              width: contentWidth,
              height: LANE_HEIGHT * verticalZoom,
              opacity: muted ? 0.4 : 1,
            }
      }
    >
      {levels.length === 0 ? (
        <div
          className="absolute inset-x-0"
          style={{
            top: "50%",
            height: 1,
            transform: "translateY(-50%)",
            background: color + "55",
          }}
        />
      ) : (
        <canvas
          ref={canvasRef}
          className={
            embedded
              ? "pointer-events-none absolute transition-opacity duration-300 ease-out"
              : "pointer-events-none absolute top-1 transition-opacity duration-300 ease-out"
          }
          style={
            embedded
              ? {
                  left: scrollLeft,
                  top: "50%",
                  transform: "translateY(-50%)",
                }
              : { left: scrollLeft }
          }
        />
      )}
    </div>
  );
}
