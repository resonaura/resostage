/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Input } from "@/components/ui";

/** Presentation only: the owning hook arbitrates submit, cancel and stale edits. */
export function AutomationValueEditor({ x, y, width, height, initialValue, minValue, maxValue,
  step, unit, onSubmit, onCancel, onReturnFocus }: {
  x: number; y: number; width: number; height: number; initialValue: number;
  minValue: number; maxValue: number; step: number; unit?: string;
  onSubmit: (value: number) => void; onCancel: () => void; onReturnFocus: () => void;
}) {
  return <div className="absolute z-40 flex items-center gap-1.5 rounded-md border border-default/60 bg-background-secondary px-2 py-1 shadow-sm"
    style={{ left: Math.max(8, Math.min(width - 140, x - 30)), top: Math.max(4, Math.min(height - 32, y - 14)) }}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <Input autoFocus ownsEditingKeys type="number" data-testid="automation-exact-value-input"
      aria-label="Set exact automation value" step={step} min={minValue} max={maxValue}
      defaultValue={String(initialValue)}
      className="h-6 w-20 min-w-0 rounded px-1.5 py-0.5 text-xs font-mono"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        if (event.key === "Escape") onCancel();
        else onSubmit(Number.parseFloat(event.currentTarget.value));
        onReturnFocus();
      }}
      onBlur={(event) => onSubmit(Number.parseFloat(event.currentTarget.value))} />
    {unit && <span className="text-[10px] text-muted font-mono">{unit}</span>}
  </div>;
}
