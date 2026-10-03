/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useKnobDrag } from "@/hooks/useKnobDrag";

/**
 * Shared rotary knob (mixer canonical). Vertical drag maps to value;
 * double-click resets to `defaultValue`; Esc mid-drag puts it back where the
 * drag started. Used by Mixer pan and Timeline track headers — keep
 * interaction (sensitivity, angle sweep) identical everywhere so the two
 * screens feel like one control set.
 *
 * Drag behaviour — pointer ownership, streaming commits, Esc, the optimistic
 * window — lives in useKnobDrag, shared with SendArcKnob. This file is the
 * geometry.
 */
export function Knob({
  value,
  automationValue,
  cancelValue,
  min,
  max,
  defaultValue = 0,
  accent = "var(--accent, #0091ff)",
  onCommit,
  onDragStart,
  onDragEnd,
  onDragCancel,
  size = 26,
  title,
}: {
  value: number;
  /** Core-evaluated value used for playback display; never committed by render. */
  automationValue?: number | null;
  /** Persisted/manual value restored if a drag is cancelled. */
  cancelValue?: number;
  min: number;
  max: number;
  defaultValue?: number;
  accent?: string;
  onCommit: (v: number) => void;
  onDragStart?: (initialValue: number) => void;
  onDragEnd?: (finalValue: number) => void;
  onDragCancel?: (originalValue: number) => void;
  size?: number;
  title?: string;
}) {
  const roundValue = (v: number) => Math.round(v * 100) / 100;

  const knob = useKnobDrag({
    value: automationValue ?? value,
    cancelValue: cancelValue ?? value,
    min,
    max,
    onCommit,
    onDragStart,
    onDragEnd,
    onDragCancel,
    round: roundValue,
    // Centre on a pan knob, zero on a send: the one place on the sweep worth
    // feeling for.
    detent: defaultValue,
  });

  const angleFor = (v: number) => {
    const t = (v - min) / (max - min);
    return -135 + t * 270;
  };

  return (
    <div
      role="slider"
      aria-label={title}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={knob.value}
      title={title}
      {...knob.dragProps}
      onDoubleClick={() => knob.setValue(defaultValue)}
      className="relative shrink-0 cursor-ns-resize touch-none select-none rounded-full border border-default/60 bg-default/20"
      style={{ width: size, height: size }}
    >
      <div
        className={`absolute left-1/2 top-1/2 w-0.5 -translate-x-1/2 -translate-y-full rounded-full ${
          knob.dragging
            ? "transition-none"
            : "transition-transform duration-75 ease-out motion-reduce:transition-none"
        }`}
        style={{
          height: size * 0.4,
          backgroundColor: accent,
          transformOrigin: "bottom center",
          transform: `translateX(-50%) rotate(${angleFor(knob.value)}deg)`,
        }}
      />
    </div>
  );
}
