import { useLayoutEffect, useMemo, useRef } from "react";
import {
  RULER_BEAT_HEIGHT,
  RULER_CYCLE_HEIGHT,
  RULER_HEIGHT,
} from "./constants";
import { formatTimeShort, getTickConfig } from "./geometry";

/**
 * Two-tier Logic-style bar ruler (canvas).
 * - Upper band: bar numbers + major ticks that span the full height
 * - Lower band: beat / subdivision ticks only
 * Cycle paints in the upper band (CycleStrip); scrub lives on the lower band
 * (SongRulerHeader hit layer) — they do not share pointer space.
 */
export function Ruler({
  pxPerSec,
  contentWidth,
  songLength,
  bpm,
  tsNum,
  scrollLeft = 0,
  viewportWidth,
}: {
  pxPerSec: number;
  contentWidth: number;
  songLength: number;
  bpm: number;
  tsNum: number;
  scrollLeft?: number;
  viewportWidth?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { majorStepSec, minorStepSec, isBeatGrid, barSec, beatSec } = useMemo(
    () => getTickConfig(pxPerSec, bpm, tsNum),
    [pxPerSec, bpm, tsNum],
  );

  const quantizedLeft = Math.max(
    0,
    Math.floor((scrollLeft || 0) / 250) * 250 - 250,
  );
  const bufferedWidth = Math.min(contentWidth, (viewportWidth || 1200) + 500);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || bufferedWidth <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.floor(bufferedWidth * dpr));
    const targetH = Math.max(1, Math.floor(RULER_HEIGHT * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${bufferedWidth}px`;
      canvas.style.height = `${RULER_HEIGHT}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, bufferedWidth, RULER_HEIGHT);
    if (minorStepSec <= 0 || majorStepSec <= 0) return;

    // Cycle tier is intentionally more transparent than the beat tier.
    ctx.fillStyle = "rgba(255,255,255,0.015)";
    ctx.fillRect(0, 0, bufferedWidth, RULER_CYCLE_HEIGHT);
    ctx.fillStyle = "rgba(0,0,0,0.14)";
    ctx.fillRect(0, RULER_CYCLE_HEIGHT, bufferedWidth, 1);

    const startTime = Math.max(0, quantizedLeft / pxPerSec);
    const endTime = Math.min(
      songLength + majorStepSec,
      (quantizedLeft + bufferedWidth) / pxPerSec + minorStepSec,
    );
    const startTick = Math.floor(startTime / minorStepSec) * minorStepSec;

    const maxMarks = 2000;
    let n = 0;

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font =
      "600 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

    // Half-bar (or half-major) for medium ticks in the lower band.
    const midStepSec =
      isBeatGrid && beatSec > 0 && majorStepSec >= beatSec * 2 - 1e-9
        ? majorStepSec / 2
        : majorStepSec / 2;

    for (let t = startTick; t <= endTime && n < maxMarks; t += minorStepSec) {
      const rounded = Math.round(t / minorStepSec) * minorStepSec;
      if (rounded < 0) continue;
      const x = Math.round(rounded * pxPerSec);
      if (x > contentWidth + 8) break;
      n += 1;

      const canvasX = x - quantizedLeft;
      if (canvasX < -8 || canvasX > bufferedWidth + 8) continue;

      const phaseMaj = ((rounded % majorStepSec) + majorStepSec) % majorStepSec;
      const isMajor =
        phaseMaj < majorStepSec * 0.02 || phaseMaj > majorStepSec * 0.98;

      const phaseMid = ((rounded % midStepSec) + midStepSec) % midStepSec;
      const isMid =
        !isMajor &&
        midStepSec > minorStepSec * 1.5 &&
        (phaseMid < midStepSec * 0.02 || phaseMid > midStepSec * 0.98);

      if (isMajor) {
        // Full-height bar lines; slightly softer in the cycle tier.
        ctx.fillStyle = "rgba(255,255,255,0.14)";
        ctx.fillRect(canvasX, 0, 1, RULER_CYCLE_HEIGHT);
        ctx.fillStyle = "rgba(255,255,255,0.22)";
        ctx.fillRect(canvasX, RULER_CYCLE_HEIGHT, 1, RULER_BEAT_HEIGHT);

        const label =
          isBeatGrid && barSec > 0
            ? `${Math.round(rounded / barSec) + 1}`
            : formatTimeShort(rounded);
        ctx.fillStyle = "rgba(255,255,255,0.38)";
        ctx.fillText(label, canvasX + 3, RULER_CYCLE_HEIGHT * 0.5);
      } else if (isMid) {
        // Medium tick: lower band only, taller than minors.
        const h = Math.min(RULER_BEAT_HEIGHT - 2, 10);
        ctx.fillStyle = "rgba(255,255,255,0.14)";
        ctx.fillRect(canvasX, RULER_HEIGHT - h, 1, h);
      } else {
        // Short subdivision ticks in lower band only.
        const h = Math.min(RULER_BEAT_HEIGHT - 4, 5);
        ctx.fillStyle = "rgba(255,255,255,0.07)";
        ctx.fillRect(canvasX, RULER_HEIGHT - h, 1, h);
      }
    }
  }, [
    pxPerSec,
    contentWidth,
    songLength,
    majorStepSec,
    minorStepSec,
    isBeatGrid,
    barSec,
    beatSec,
    quantizedLeft,
    bufferedWidth,
  ]);

  return (
    <div
      className="pointer-events-none relative select-none border-b border-default/30 bg-background-tertiary shrink-0"
      style={{ height: RULER_HEIGHT, width: contentWidth }}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute top-0"
        style={{ left: quantizedLeft }}
      />
    </div>
  );
}
