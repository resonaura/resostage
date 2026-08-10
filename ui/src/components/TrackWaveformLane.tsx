import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchWaveformRaw } from "../lib/api";
import { withHexAlpha } from "../lib/cssColor";
import type { PeakLevelData } from "../lib/types";

import { isCompactLane, laneHeightPx } from "./timeline/laneDimensions";

/** Pick the peak pyramid level whose bin width matches the current zoom. */
function pickLevelForZoom(
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
  speed = 1,
  reverse = false,
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
  /**
   * Region playback speed. One timeline second covers `speed` source seconds,
   * so the waveform squeezes at 2x and stretches at 0.5x -- the peaks have to
   * describe the same audio the engine reads (see AudioEngine's shaped read,
   * where the region's source window is regLen * speed).
   */
  speed?: number;
  /**
   * Region played backwards. The peaks have to be mirrored inside the same
   * source window the engine mirrors in (AudioEngine's `srcFor`), or the
   * drawing describes the file while the ear hears its reverse.
   */
  reverse?: boolean;
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

  // Parent usually skips mounting us in compact mode; if still mounted, draw
  // nothing so we never spend paint or network on unreadable peaks.
  const compact = isCompactLane(verticalZoom);

  const needsRaw =
    !compact &&
    pickLevelForZoom(levels, durationSeconds, pxPerSec) === null &&
    levels.length > 0;

  // Quantize the fetch range so panning by a pixel at a time doesn't refire
  // a network request every frame -- half-second buckets with a half-second
  // margin on each side comfortably cover a viewport's worth of scrolling
  // between refetches. Times are in *source file* seconds.
  const srcPerSec = speed > 0 ? speed : 1;
  const visibleStartSec = sourceOffsetSec + (scrollLeft / pxPerSec) * srcPerSec;
  const visibleEndSec =
    sourceOffsetSec + ((scrollLeft + viewportWidth) / pxPerSec) * srcPerSec;
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
    if (!canvas || viewportWidth <= 0 || compact) return;

    const dpr = window.devicePixelRatio || 1;
    const renderWidth = Math.min(viewportWidth, contentWidth);
    const laneH = laneHeightPx(verticalZoom);
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
    // halfH already scales with lane height (verticalZoom) — do NOT multiply
    // samples by verticalZoom again or peaks clip / look wrong.
    const halfH = Math.max(1, height / 2 - 2);
    const alpha = muted ? 0.35 : 1.0;
    ctx.globalAlpha = alpha;

    const hasRaw =
      needsRaw && rawWindow != null && rawWindow.samples.length > 1;
    // Always draw the best peak pyramid we have (full quality). Raw samples
    // overlay on top when zoomed past the finest pyramid level — never hide
    // the envelope while waiting on / during a gesture (that was the blocky
    // "ugly zoom" look: gestureActive used ~200 columns and skipped detail).
    const level =
      pickLevelForZoom(levels, durationSeconds, pxPerSec) ?? levels[0];

    if (level) {
      const bins = level.min.length;
      // Full horizontal resolution always. Gesture used to step by
      // renderWidth/200 (~blocky columns) — looked broken while zooming.
      const step = 1;

      const topPoints: { x: number; y: number }[] = [];
      const botPoints: { x: number; y: number }[] = [];

      const availSec = Math.max(0.01, durationSeconds - sourceOffsetSec);
      const cycleSec =
        loopLengthSec && loopLengthSec > 0 ? loopLengthSec : availSec;
      // The stretch of source this region covers, in source seconds. Reverse
      // mirrors within exactly this, the same window the engine uses.
      const windowSec = Math.min(
        availSec,
        Math.max(0.01, (contentWidth / pxPerSec) * srcPerSec),
      );
      const mirrorSec = loop && cycleSec > 0 ? cycleSec : windowSec;

      for (let x = 0; x <= renderWidth; x += step) {
        // Map lane-local time → source-file time (honours region trim/split & loop).
        // Lane seconds -> source seconds. At any speed but 1x these differ,
        // which is what makes the drawn waveform narrower or wider than the
        // audio it came from.
        const intoSecStart = ((scrollLeft + x) / pxPerSec) * srcPerSec;
        const intoSecEnd = ((scrollLeft + x + step) / pxPerSec) * srcPerSec;

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

        if (reverse) {
          // Mirror both edges of this column's slice, then put them back in
          // order -- a mirrored range runs backwards, and the bin lookup
          // below wants start <= end.
          const a = mirrorSec - (tEndSec - sourceOffsetSec);
          const bEdge = mirrorSec - (tStartSec - sourceOffsetSec);
          tStartSec = sourceOffsetSec + Math.max(0, a);
          tEndSec = sourceOffsetSec + Math.max(0, bEdge);
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

        if (startBin === endBin) {
          maxV = level.max[startBin] ?? 0;
          minV = level.min[startBin] ?? 0;
        } else {
          // Aggregate min/max across bins covering this pixel column so
          // zoom-out stays peak-accurate (no thin-line aliasing).
          for (let b = startBin; b <= endBin; ++b) {
            const mx = level.max[b] ?? 0;
            const mn = level.min[b] ?? 0;
            if (maxV === -1 || mx > maxV) maxV = mx;
            if (minV === 1 || mn < minV) minV = mn;
          }
        }

        if (maxV === -1) maxV = 0;
        if (minV === 1) minV = 0;

        // Past the end of the source file (non-loop only): draw silence so trimmed tails stay flat.
        if (!loop && tStartSec >= durationSeconds) {
          maxV = 0;
          minV = 0;
        }

        topPoints.push({ x, y: mid - maxV * halfH });
        botPoints.push({ x, y: mid - minV * halfH });
      }

      if (topPoints.length > 0) {
        // Solid fill envelope.
        ctx.beginPath();
        ctx.moveTo(topPoints[0].x, topPoints[0].y);
        for (let i = 1; i < topPoints.length; ++i) {
          ctx.lineTo(topPoints[i].x, topPoints[i].y);
        }
        for (let i = botPoints.length - 1; i >= 0; --i) {
          ctx.lineTo(botPoints[i].x, botPoints[i].y);
        }
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        // Leading contour (top + bottom edge) — solid, same color.
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(topPoints[0].x, topPoints[0].y);
        for (let i = 1; i < topPoints.length; ++i) {
          ctx.lineTo(topPoints[i].x, topPoints[i].y);
        }
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(botPoints[0].x, botPoints[0].y);
        for (let i = 1; i < botPoints.length; ++i) {
          ctx.lineTo(botPoints[i].x, botPoints[i].y);
        }
        ctx.stroke();
      }
    }

    // Extreme zoom: per-sample curve on top of the peak envelope (detail).
    if (hasRaw && rawWindow) {
      const windowEndSec =
        rawWindow.startSec + rawWindow.samples.length / rawWindow.sampleRate;
      // Draw whatever of the window overlaps the view — don't require full
      // coverage (partial windows left blank-looking holes while loading).
      if (
        windowEndSec > visibleStartSec &&
        rawWindow.startSec < visibleEndSec
      ) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        const { samples, sampleRate, startSec } = rawWindow;
        let first = true;
        for (let x = 0; x < renderWidth; ++x) {
          const tSec = sourceOffsetSec + (scrollLeft + x) / pxPerSec;
          if (tSec < startSec || tSec > windowEndSec) {
            first = true;
            continue;
          }
          const exactIdx = (tSec - startSec) * sampleRate;
          const baseIdx = Math.floor(exactIdx);
          if (baseIdx < 0 || baseIdx >= samples.length) {
            first = true;
            continue;
          }
          const mu = exactIdx - baseIdx;
          const y0 = samples[baseIdx - 1] ?? samples[0] ?? 0;
          const y1 = samples[baseIdx] ?? 0;
          const y2 = samples[baseIdx + 1] ?? samples[samples.length - 1] ?? 0;
          const y3 = samples[baseIdx + 2] ?? samples[samples.length - 1] ?? 0;
          const v = cubicHermite(y0, y1, y2, y3, mu);
          const y = mid - v * halfH;
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
    compact,
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
    srcPerSec,
    reverse,
    visibleStartSec,
    visibleEndSec,
    loop,
    loopLengthSec,
  ]);

  if (compact) return null;

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
              height: laneHeightPx(verticalZoom),
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
            background: withHexAlpha(color, "55"),
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
