import { useRef } from "react";
import { CROSSFADE_SHAPES, type CrossfadeShape } from "./crossfade";

/**
 * The X drawn over the span where two regions on a track overlap.
 *
 * That span IS the crossfade -- both regions sound through it, the earlier
 * one fading out and the later one fading in, and the engine sums them (see
 * AudioEngine's per-track region loop). So this is not decoration over some
 * separate crossfade object: it is the picture of the two fades that already
 * exist, drawn as one figure because they are one edit. The regions' own fade
 * triangles are suppressed underneath it for the same reason -- drawing both
 * gave four lines for two fades.
 *
 * Dragging the seam grows or shrinks the crossfade symmetrically, by trimming
 * the earlier region's end later and the later region's start earlier in equal
 * measure. Neither region's audio moves in time, and the seam stays where it
 * is -- see crossfadeResize.ts for why that symmetry is worth the clamping it
 * costs.
 */
export function CrossfadeOverlay({
  leftPx,
  widthPx,
  topInset,
  bottomInset,
  color,
  shape = "equalPower",
  readOnly,
  isActive,
  pxPerSec,
  onResize,
}: {
  /** Overlap start, in the same coordinate space as the region blocks. */
  leftPx: number;
  widthPx: number;
  /** Match the region block's own inset so the X cannot spill past it. */
  topInset: number;
  bottomInset: number;
  /** The track accent, so the X reads as belonging to these regions. */
  color: string;
  shape?: CrossfadeShape;
  readOnly: boolean;
  /** True while this crossfade is the thing being dragged. */
  isActive: boolean;
  pxPerSec: number;
  /** Positive grows the crossfade. `commit` on pointer-up. */
  onResize: (deltaSeconds: number, commit: boolean) => void;
}) {
  const dragRef = useRef<{ startX: number } | null>(null);

  // Below this the X is a smudge and the grab strip covers all of it, so
  // there is nothing left to aim at -- draw the seam alone.
  const tiny = widthPx < 10;

  const curve = CROSSFADE_SHAPES[shape];
  // The same shaping the engine applies: gain = t ^ 2^(-curve*2).
  const exp = Math.pow(2, -curve * 2);
  const steps = 16;
  const rising: string[] = [];
  const falling: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (t * 100).toFixed(2);
    rising.push(`${x},${(100 - Math.pow(t, exp) * 100).toFixed(2)}`);
    falling.push(`${x},${(100 - Math.pow(1 - t, exp) * 100).toFixed(2)}`);
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { startX: e.clientX };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // Dragging LEFT grows it: the handle sits on the overlap's left edge, so
    // pulling it away from the seam is the gesture that makes it wider.
    onResize((d.startX - e.clientX) / Math.max(1, pxPerSec), false);
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    onResize((d.startX - e.clientX) / Math.max(1, pxPerSec), true);
  };

  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{
        left: leftPx,
        width: Math.max(1, widthPx),
        top: topInset,
        bottom: bottomInset,
      }}
    >
      {/* preserveAspectRatio="none" so the curves stretch with the overlap
          rather than keeping a square aspect. */}
      {!tiny && (
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <polyline
            points={falling.join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            opacity={0.9}
          />
          <polyline
            points={rising.join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            opacity={0.9}
          />
        </svg>
      )}

      {/* Where the curves cross -- the -3dB point of the join. Drawn even when
          the overlap is too narrow for the curves, because it is then the only
          thing saying a crossfade is here at all. */}
      <div
        className="absolute top-0 bottom-0 w-px"
        style={{
          left: "50%",
          background: color,
          opacity: isActive ? 0.9 : 0.45,
        }}
      />

      {!readOnly && (
        <div
          className="pointer-events-auto absolute top-0 bottom-0 w-3 -translate-x-1/2 cursor-ew-resize"
          style={{ left: 0 }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          title="Drag to resize the crossfade (both sides move together)"
        >
          <div
            className="absolute top-1/2 left-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: color, opacity: isActive ? 1 : 0.75 }}
          />
        </div>
      )}
    </div>
  );
}
