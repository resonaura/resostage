import { useLayoutEffect, useMemo, useRef } from "react";
import { RULER_HEIGHT } from "./constants";
import { formatTimeShort, getTickConfig } from "./geometry";

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
  /** Viewport-slice the tick loop the same way BeatGrid does -- without
   * this, generating marks from t=0 through the whole song, capped at a
   * fixed mark count, means a long song zoomed in far enough (minorStepSec
   * shrinks, so far more ticks are needed to reach the same song length)
   * exhausts the cap before ever reaching the marks that would fall to the
   * right of wherever the cap ran out -- the ruler and its labels just stop
   * rendering partway across. */
  scrollLeft?: number;
  viewportWidth?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { majorStepSec, minorStepSec, isBeatGrid, barSec } = useMemo(
    () => getTickConfig(pxPerSec, bpm, tsNum),
    [pxPerSec, bpm, tsNum],
  );

  // Quantize OUTSIDE the draw effect so it only invalidates every 250px of
  // pan -- not on every follow/scrollState tick. Raw scrollLeft in the dep
  // array redrew the whole ruler every frame ("сетка прыгает" -- same reason
  // BeatGrid quantizes its own canvas window below).
  const quantizedLeft = Math.max(
    0,
    Math.floor((scrollLeft || 0) / 250) * 250 - 250,
  );
  const bufferedWidth = Math.min(contentWidth, (viewportWidth || 1200) + 500);

  // Canvas, not DOM divs (see BeatGrid below for the same pattern): the tick
  // list was previously one <div> pair per mark, up to ~2000 of them,
  // rebuilt and reconciled on every pxPerSec change -- i.e. on every step of
  // a zoom gesture, on top of every visible region doing the same. Drawing
  // is imperative here so a redraw costs a canvas clear + fillRect/fillText
  // loop, never a React reconciliation.
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

    const startTime = Math.max(0, quantizedLeft / pxPerSec);
    const endTime = Math.min(
      songLength + majorStepSec,
      (quantizedLeft + bufferedWidth) / pxPerSec + minorStepSec,
    );
    const startTick = Math.floor(startTime / minorStepSec) * minorStepSec;

    // Hard cap so a bad step never floods the draw loop -- viewport-slicing
    // above already bounds this to roughly one screen's worth of ticks,
    // this is just a safety net for a pathologically wide viewport.
    const maxMarks = 2000;
    let n = 0;

    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.font =
      "600 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

    for (let t = startTick; t <= endTime && n < maxMarks; t += minorStepSec) {
      const rounded = Math.round(t / minorStepSec) * minorStepSec;
      if (rounded < 0) continue;
      const x = Math.round(rounded * pxPerSec);
      if (x > contentWidth + 8) break;
      n += 1;

      const canvasX = x - quantizedLeft;
      if (canvasX < -8 || canvasX > bufferedWidth + 8) continue;

      const phase = ((rounded % majorStepSec) + majorStepSec) % majorStepSec;
      const isMajor =
        phase < majorStepSec * 0.02 || phase > majorStepSec * 0.98;

      const tickH = isMajor ? 14 : 6;
      ctx.fillStyle = isMajor
        ? "rgba(255,255,255,0.18)"
        : "rgba(255,255,255,0.06)";
      ctx.fillRect(canvasX, RULER_HEIGHT - tickH, 1, tickH);

      if (isMajor) {
        const label =
          isBeatGrid && barSec > 0
            ? // At coarse zoom majorStep is many bars -- show bar number,
              // not every bar.
              `${Math.round(rounded / barSec) + 1}`
            : formatTimeShort(rounded);
        ctx.fillStyle = "rgba(255,255,255,0.38)";
        ctx.fillText(label, canvasX + 3, RULER_HEIGHT - 14);
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
    quantizedLeft,
    bufferedWidth,
  ]);

  return (
    <div
      className="relative select-none border-b border-default/30 bg-background-tertiary shrink-0"
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
