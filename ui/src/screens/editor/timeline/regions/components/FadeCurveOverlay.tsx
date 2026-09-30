/** SVG fade triangle with curved edge driven by curve ∈ [-1, 1]. */
export function FadeCurveOverlay({
  side,
  widthPx,
  heightPct,
  curve,
  color,
  readOnly,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  side: "in" | "out";
  widthPx: number;
  heightPct: number;
  curve: number;
  color: string;
  readOnly: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  /** Optional -- region drag uses window listeners after pointerdown. */
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
}) {
  const steps = 12;
  // Match engine: exp = 2^(-curve*2). +curve → ease-out, −curve → ease-in.
  const exp = Math.pow(2, -(curve || 0) * 2); // 4..0.25
  const pts: string[] = [];
  if (side === "in") {
    pts.push("0,100");
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const g = Math.pow(t, exp);
      pts.push(`${(t * 100).toFixed(1)},${(100 - g * 100).toFixed(1)}`);
    }
    pts.push("100,100");
  } else {
    pts.push("0,100");
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const g = Math.pow(1 - t, exp);
      pts.push(`${(t * 100).toFixed(1)},${(100 - g * 100).toFixed(1)}`);
    }
    pts.push("100,100");
  }
  return (
    <div
      className={`absolute top-0 bottom-0 ${side === "in" ? "left-0" : "right-0"} ${
        readOnly
          ? "pointer-events-none"
          : "pointer-events-auto cursor-ns-resize"
      }`}
      style={{ width: widthPx, height: `${heightPct}%` }}
      title={
        side === "in"
          ? "Drag vertically to reshape fade-in curve"
          : "Drag vertically to reshape fade-out curve"
      }
      onPointerDown={readOnly ? undefined : onPointerDown}
      onPointerMove={readOnly ? undefined : onPointerMove}
      onPointerUp={readOnly ? undefined : onPointerUp}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-full w-full pointer-events-none"
      >
        <polygon points={pts.join(" ")} fill={color} opacity={0.28} />
        <polyline
          points={pts.slice(1, -1).join(" ")}
          fill="none"
          stroke={color}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          opacity={0.85}
        />
      </svg>
    </div>
  );
}
