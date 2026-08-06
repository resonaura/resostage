import { useLayoutEffect, useRef } from "react";
import { formatTimeShort } from "./geometry";

// Visual ghost of an audio file being dragged over the timeline: "as if
// you'd just added it" -- filename, waveform and duration -- but nothing is
// committed until the user actually drops (see Timeline.tsx). Mirrors the
// real AudioRegionBlock chrome (top-1/bottom-1 rounded, border + tint) but
// with a dashed border + lower opacity so it reads as a preview.
export function AudioDropGhost({
  name,
  duration,
  min,
  max,
  color,
  leftPx,
  topPx,
  widthPx,
  laneH,
}: {
  name: string;
  duration: number;
  min: number[];
  max: number[];
  color: string;
  leftPx: number;
  topPx: number;
  widthPx: number;
  laneH: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compact = laneH <= 20;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || compact || widthPx <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const h = Math.max(1, laneH - 8);
    const w = Math.max(1, Math.floor(widthPx * dpr));
    const targetH = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.style.width = `${widthPx}px`;
    }
    if (canvas.height !== targetH) {
      canvas.height = targetH;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, widthPx, h);
    const mid = h / 2;
    const halfH = Math.max(1, mid - 2);

    if (min.length !== max.length || min.length === 0) {
      // Metadata-only preview (codec undecodable): flat silence line, like an
      // imported region with no peaks yet.
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(widthPx, mid);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    const bins = min.length;
    const top: [number, number][] = [];
    const bot: [number, number][] = [];
    for (let x = 0; x <= widthPx; x++) {
      const t = x / Math.max(1, widthPx);
      const b = Math.max(0, Math.min(bins - 1, Math.floor(t * bins)));
      top.push([x, mid - Math.min(0.98, max[b]) * halfH]);
      bot.push([x, mid - Math.max(-0.98, min[b]) * halfH]);
    }
    ctx.fillStyle = `${color}55`;
    ctx.beginPath();
    ctx.moveTo(top[0][0], top[0][1]);
    for (const [x, y] of top) ctx.lineTo(x, y);
    for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (const [x, y] of top) ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    for (const [x, y] of bot) ctx.lineTo(x, y);
    ctx.stroke();
  }, [compact, widthPx, laneH, min, max, color]);

  const label = `${name}${duration > 0 ? " · " + formatTimeShort(duration) : ""}`;

  return (
    <div
      className="pointer-events-none absolute z-[30] overflow-hidden rounded-md"
      style={{
        left: leftPx,
        top: topPx,
        width: widthPx,
        height: laneH,
      }}
    >
      <div
        className="absolute top-1 bottom-1 left-0 right-0 overflow-hidden rounded-md"
        style={{
          border: `1.5px dashed ${color}`,
          background: `${color}22`,
          opacity: 0.85,
        }}
      >
        {!compact && (
          <div className="absolute inset-0 flex items-center justify-center">
            <canvas
              ref={canvasRef}
              className="pointer-events-none absolute"
              style={{ opacity: 0.9 }}
            />
          </div>
        )}
        <div className="pointer-events-none absolute left-0.5 top-px z-[3] max-w-[min(90%,14rem)] select-none">
          <span
            className="inline-block max-w-full truncate rounded-md px-1 py-0.5 font-semibold leading-none"
            style={{
              color,
              fontSize: compact ? 8 : 10,
              background: "transparent",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
            }}
            title={label}
          >
            {label}
          </span>
        </div>
        {!compact && widthPx > 60 && duration > 0 && (
          <div
            className="pointer-events-none absolute bottom-0.5 right-1 select-none rounded-md px-1 text-[8px] font-semibold"
            style={{ color, opacity: 0.85 }}
          >
            {formatTimeShort(duration)}
          </div>
        )}
      </div>
    </div>
  );
}