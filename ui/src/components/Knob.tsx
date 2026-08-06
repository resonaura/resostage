import { useEffect, useRef, useState } from "react";

/**
 * Shared rotary knob (mixer canonical). Vertical drag maps to value;
 * double-click resets to `defaultValue`. Used by Mixer pan and Timeline
 * track headers — keep interaction (sensitivity, angle sweep) identical
 * everywhere so the two screens feel like one control set.
 */
export function Knob({
  value,
  min,
  max,
  defaultValue = 0,
  accent = "var(--accent, #0091ff)",
  onCommit,
  size = 26,
  title,
}: {
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  accent?: string;
  onCommit: (v: number) => void;
  size?: number;
  title?: string;
}) {
  const roundValue = (v: number) => Math.round(v * 100) / 100;

  const [localValue, setLocalValue] = useState(() => roundValue(value));
  const dragging = useRef(false);
  const startY = useRef(0);
  const startValue = useRef(0);
  const rafId = useRef<number | null>(null);
  const pendingCommit = useRef<number | null>(null);
  const lastEditTime = useRef(0);

  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // Sync external value when not dragging and optimistic lock window (500ms) has expired
  useEffect(() => {
    if (!dragging.current && Date.now() - lastEditTime.current > 500) {
      setLocalValue(roundValue(value));
    }
  }, [value]);

  const angleFor = (v: number) => {
    const t = (v - min) / (max - min);
    return -135 + t * 270;
  };

  const scheduleCommit = (v: number) => {
    pendingCommit.current = v;
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        if (pendingCommit.current != null) {
          onCommitRef.current(pendingCommit.current);
          pendingCommit.current = null;
        }
      });
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    lastEditTime.current = Date.now();
    startY.current = e.clientY;
    startValue.current = localValue;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    lastEditTime.current = Date.now();
    const dy = startY.current - e.clientY;
    const range = max - min;
    const next = roundValue(
      Math.max(min, Math.min(max, startValue.current + (dy / 120) * range)),
    );
    setLocalValue(next);
    scheduleCommit(next);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    lastEditTime.current = Date.now();
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    if (pendingCommit.current != null) {
      onCommitRef.current(pendingCommit.current);
      pendingCommit.current = null;
    }
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {}
  };

  return (
    <div
      role="slider"
      aria-label={title}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={localValue}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => {
        lastEditTime.current = Date.now();
        const resetVal = roundValue(defaultValue);
        setLocalValue(resetVal);
        onCommitRef.current(resetVal);
      }}
      className="relative shrink-0 cursor-ns-resize touch-none select-none rounded-full border border-default/60 bg-default/20"
      style={{ width: size, height: size }}
    >
      <div
        className="absolute left-1/2 top-1/2 w-[2px] -translate-x-1/2 -translate-y-full rounded-full"
        style={{
          height: size * 0.4,
          backgroundColor: accent,
          transformOrigin: "bottom center",
          transform: `translateX(-50%) rotate(${angleFor(localValue)}deg)`,
        }}
      />
    </div>
  );
}

