import { useKnobDrag } from "../../lib/knobDrag";

/**
 * Floor for a send knob that hasn't been touched yet -- matches native
 * MixerStrip's convention (see MixerPanel.cpp's auxSlotTemplate): a track
 * with no TrackSendDef for a given aux bus is treated as "sending at -60dB",
 * and turning the knob up from there implicitly creates the send.
 */
export const SEND_FLOOR_DB = -60;

/**
 * Unity, and the knob's hard ceiling. A send's level is stored as the
 * schema's 0-100 LINEAR percent, so 100% (= 0 dB) is the most that can ever
 * be persisted -- SendConfig::level clamps there. The knob used to run to
 * +6 dB, which meant a send saved at 100% still showed a fifth of the arc
 * unfilled and let you keep dragging into a range the format silently threw
 * away. The ceiling is the format's, not a taste call.
 */
export const SEND_CEILING_DB = 0;

/**
 * Ableton-style arc send knob. Shared so any surface that exposes aux sends
 * (mixer strips today) uses the same look and drag feel. Esc mid-drag puts the
 * send back where the drag started.
 *
 * Drag behaviour lives in useKnobDrag, shared with Knob — including the rule
 * that only the primary button starts a drag, which matters most here: the
 * right button opens this knob's own context menu.
 */
export function SendArcKnob({
  value,
  min = SEND_FLOOR_DB,
  max = SEND_CEILING_DB,
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
  const roundValue = (v: number) => Math.round(v * 10) / 10;

  const knob = useKnobDrag({
    value,
    min,
    max,
    onCommit: onChange,
    round: roundValue,
  });

  const norm = Math.max(0, Math.min(1, (knob.value - min) / (max - min)));
  const radius = 9;
  const strokeWidth = 2.5;
  const circumference = 2 * Math.PI * radius;
  const arcLength = circumference * (270 / 360);
  const strokeDashoffset = arcLength * (1 - norm);

  return (
    <div
      className="relative flex items-center justify-center cursor-ns-resize select-none touch-none"
      title={title}
      {...knob.dragProps}
      onContextMenu={onContextMenu}
      onDoubleClick={() => knob.setValue(min)}
      onWheel={(e) => {
        e.preventDefault();
        knob.setValue(
          knob.value + (e.deltaY < 0 ? 1 : -1) * ((max - min) / 40),
        );
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
          stroke={busColor || "var(--muted)"}
          strokeWidth={strokeWidth}
          strokeDasharray={`${arcLength} ${circumference}`}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          style={{
            // No easing while the finger is down -- the arc must track the
            // cursor, not lag it. `dragging` is real state (not a ref) so this
            // actually re-renders when the drag starts and ends; reading a ref
            // here never did.
            transition: knob.dragging
              ? "none"
              : "stroke-dashoffset 0.1s ease-out",
          }}
        />
      </svg>
    </div>
  );
}
