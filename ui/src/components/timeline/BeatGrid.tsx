import { useLayoutEffect, useMemo, useRef } from "react";
import { getTickConfig } from "./geometry";

/** Beat/bar vertical grid lines drawn on a viewport-sliced canvas. */
export function BeatGrid({
  pxPerSec,
  contentWidth,
  scrollLeft,
  viewportWidth,
  songLength,
  bpm,
  tsNum,
}: {
  pxPerSec: number;
  contentWidth: number;
  scrollLeft: number;
  viewportWidth: number;
  songLength: number;
  bpm: number;
  tsNum: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { majorStepSec, minorStepSec } = useMemo(
    () => getTickConfig(pxPerSec, bpm, tsNum),
    [pxPerSec, bpm, tsNum],
  );

  // Quantize scrollLeft to 250px chunks so the canvas node stays static for 250px of scroll
  // and moves smoothly with native GPU layer scrolling without 60fps React redraw stutter
  const quantizedLeft = Math.max(
    0,
    Math.floor((scrollLeft || 0) / 250) * 250 - 250,
  );
  const bufferedWidth = Math.min(contentWidth, (viewportWidth || 1200) + 500);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || bufferedWidth <= 0) return;
    const parent = canvas.parentElement;
    const height = parent ? parent.clientHeight : 300;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.floor(bufferedWidth * dpr));
    const targetH = Math.max(1, Math.floor(height * dpr));

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${bufferedWidth}px`;
      canvas.style.height = `${height}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, bufferedWidth, height);

    if (minorStepSec > 0 && majorStepSec > 0) {
      const startTime = Math.max(0, quantizedLeft / pxPerSec);
      const endTime = Math.min(
        songLength + minorStepSec,
        (quantizedLeft + bufferedWidth) / pxPerSec,
      );
      const startTick = Math.floor(startTime / minorStepSec) * minorStepSec;
      const eps = Math.max(minorStepSec * 0.01, 1e-9);
      const maxStrokes = 1000;
      let strokes = 0;

      for (
        let t = startTick;
        t <= endTime && strokes < maxStrokes;
        t += minorStepSec
      ) {
        const rounded = Math.round(t / minorStepSec) * minorStepSec;
        const globalX = Math.round(rounded * pxPerSec);
        const canvasX = globalX - quantizedLeft;
        if (canvasX < 0 || canvasX > bufferedWidth) continue;

        const phase = ((rounded % majorStepSec) + majorStepSec) % majorStepSec;
        const isMajor = phase < eps || Math.abs(phase - majorStepSec) < eps;

        ctx.strokeStyle = isMajor
          ? "rgba(255,255,255,0.05)"
          : "rgba(255,255,255,0.015)";
        ctx.lineWidth = isMajor ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(canvasX, 0);
        ctx.lineTo(canvasX, height);
        ctx.stroke();
        strokes += 1;
      }
    }
  }, [
    pxPerSec,
    contentWidth,
    quantizedLeft,
    bufferedWidth,
    songLength,
    majorStepSec,
    minorStepSec,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute top-0 z-0"
      style={{ left: quantizedLeft }}
    />
  );
}
