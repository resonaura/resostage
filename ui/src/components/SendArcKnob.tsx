import { useRef, useState } from "react";

/**
 * Floor for a send knob that hasn't been touched yet -- matches native
 * MixerStrip's convention (see MixerPanel.cpp's auxSlotTemplate): a track
 * with no TrackSendDef for a given aux bus is treated as "sending at -60dB",
 * and turning the knob up from there implicitly creates the send.
 */
export const SEND_FLOOR_DB = -60;

/**
 * Ableton-style arc send knob. Shared so any surface that exposes aux sends
 * (mixer strips today) uses the same look and drag feel.
 */
export function SendArcKnob({
  value,
  min = SEND_FLOOR_DB,
  max = 6,
  busColor,
  title,
  onChange,
  onContextMenu,
  size = 24,
}: {
  value: number;
  min?: number;
  max?: number;
  busColor: string;
  title?: string;
  onChange: (val: number) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  size?: number;
}) {
  const [localValue, setLocalValue] = useState(value);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startValue = useRef(0);
  const rafId = useRef<number | null>(null);
  const pendingCommit = useRef<number | null>(null);
  const lastEditTime = useRef(0);

  // Sync external value when not dragging and optimistic lock window (500ms) has expired
  if (
    !dragging.current &&
    Date.now() - lastEditTime.current > 500 &&
    localValue !== value
  ) {
    setLocalValue(value);
  }

  const norm = Math.max(0, Math.min(1, (localValue - min) / (max - min)));
  const radius = 9;
  const strokeWidth = 2.5;
  const circumference = 2 * Math.PI * radius;
  const arcLength = circumference * (270 / 360);
  const strokeDashoffset = arcLength * (1 - norm);

  const scheduleCommit = (v: number) => {
    pendingCommit.current = v;
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        if (pendingCommit.current != null) {
          onChange(pendingCommit.current);
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
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    lastEditTime.current = Date.now();
    const dy = startY.current - e.clientY;
    const range = max - min;
    const next = Math.max(
      min,
      Math.min(max, startValue.current + (dy / 120) * range),
    );
    setLocalValue(next);
    scheduleCommit(next);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    lastEditTime.current = Date.now();
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    if (pendingCommit.current != null) {
      onChange(pendingCommit.current);
      pendingCommit.current = null;
    }
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="relative flex items-center justify-center cursor-ns-resize select-none touch-none"
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
      onDoubleClick={() => {
        setLocalValue(min);
        onChange(min);
      }}
      onWheel={(e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1 : -1;
        const step = (max - min) / 40;
        const newVal = Math.max(min, Math.min(max, localValue + delta * step));
        setLocalValue(newVal);
        onChange(newVal);
      }}
    >
      {/*
        SVG stroke starts at 3 o'clock; rotate +135° so dash begins at SW
        (CSS rotate(-135°) / 7:30) and sweeps 270° CW to SE (CSS +135°),
        matching the white indicator. rotate(-135°) was 90° off.
      */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className="overflow-visible"
        style={{ transform: "rotate(135deg)" }}
      >
        <circle
          cx={12}
          cy={12}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.15)"
          strokeWidth={strokeWidth}
          strokeDasharray={`${arcLength} ${circumference}`}
          strokeLinecap="round"
        />
        <circle
          cx={12}
          cy={12}
          r={radius}
          fill="none"
          stroke={busColor || "rgba(255,255,255,0.9)"}
          strokeWidth={strokeWidth}
          strokeDasharray={`${arcLength} ${circumference}`}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          style={{
            transition: dragging.current
              ? "none"
              : "stroke-dashoffset 0.1s ease-out",
          }}
        />
      </svg>
    </div>
  );
}
