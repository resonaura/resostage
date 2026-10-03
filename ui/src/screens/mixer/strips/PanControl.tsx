/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useState } from "react";
import { Knob, RotaryControlMenu } from "@/components/daw";
import type { RotaryMidiTarget } from "@/components/daw/logic/rotaryMidiTarget";
import { createVerticalValueDragHandler } from "@/screens/mixer/strips/logic/verticalValueDrag";

function formatPan(value: number): string {
  if (Math.abs(value) < 0.05) return "C";
  if (value < 0) return `L${Math.round(-value * 100)}`;
  return `R${Math.round(value * 100)}`;
}

export function PanControl({
  value,
  automatedValue,
  onChange,
  size,
  midiTarget,
}: {
  value: number;
  automatedValue?: number | null;
  onChange: (value: number) => void;
  size: number;
  midiTarget?: RotaryMidiTarget;
}) {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const handlePointerDown = createVerticalValueDragHandler(value, onChange, {
    min: -1,
    max: 1,
    sensitivity: 0.01,
    step: 0.05,
    fineSensitivity: 0.01,
    fineStep: 0.01,
  });
  const shownValue = automatedValue ?? value;

  return (
    <div
      className="my-0.5 flex flex-col items-center gap-0.5"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      <Knob
        value={value}
        automationValue={automatedValue}
        cancelValue={value}
        min={-1}
        max={1}
        defaultValue={0}
        accent="color-mix(in oklab, var(--foreground) 90%, transparent)"
        onCommit={onChange}
        size={size}
        title="Pan"
      />
      <div
        className="font-mono text-[8.5px] text-foreground/50 hover:text-foreground cursor-ns-resize select-none transition-colors"
        title="Pan (Drag up/down to adjust, double-click for Center)"
        onPointerDown={handlePointerDown}
        onDoubleClick={(event) => {
          event.preventDefault();
          onChange(0);
        }}
      >
        {formatPan(shownValue)}
      </div>
      {menuPosition && (
        <RotaryControlMenu
          x={menuPosition.x}
          y={menuPosition.y}
          onClose={() => setMenuPosition(null)}
          onReset={() => onChange(0)}
          resetLabel="Reset Pan to Center"
          midiTarget={midiTarget}
        />
      )}
    </div>
  );
}
