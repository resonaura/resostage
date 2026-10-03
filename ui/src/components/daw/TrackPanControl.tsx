/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MouseEventHandler } from "react";
import { Knob } from "@/components/daw/Knob";
import { formatPan } from "@/components/daw/logic/panLaw";
import { RotaryControlMenu } from "@/components/daw/RotaryControlMenu";
import type { RotaryMidiTarget } from "@/components/daw/logic/rotaryMidiTarget";
import { ContextMenuDivider, ContextMenuItem } from "@/components/common/ContextMenu";
import type { TrackPanLawOption } from "@/components/daw/logic/panLaw";
import { EasedReadout } from "@/components/daw/EasedReadout";

/** Presentational track-pan control; state and commands come from its owner. */
export function TrackPanControl({
  value,
  automationValue,
  valueLabel,
  trackName,
  activePanLaw,
  panLaws,
  menuPosition,
  color,
  knobSize,
  showPanValue,
  interacting = false,
  motionKey,
  midiTarget,
  onCommit,
  onDragStart,
  onDragEnd,
  onDragCancel,
  onContextMenu,
  onCloseMenu,
  onSelectPanLaw,
}: {
  value: number;
  automationValue?: number | null;
  valueLabel: string;
  trackName: string;
  activePanLaw: string;
  panLaws: readonly TrackPanLawOption[];
  menuPosition: { x: number; y: number } | null;
  color: string;
  knobSize: number;
  showPanValue: boolean;
  interacting?: boolean;
  motionKey?: string;
  midiTarget: RotaryMidiTarget;
  onCommit: (value: number) => void;
  onDragStart?: (initialValue: number) => void;
  onDragEnd?: (finalValue: number) => void;
  onDragCancel?: (originalValue: number) => void;
  onContextMenu: MouseEventHandler<HTMLDivElement>;
  onCloseMenu: () => void;
  onSelectPanLaw: (lawId: number) => void;
}) {
  const shownValueLabel = automationValue == null
    ? valueLabel
    : formatPan(automationValue);
  return (
    <div
      className="flex shrink-0 items-center gap-0.5"
      title={`Pan: ${shownValueLabel} · ${activePanLaw} pan law (right-click for options)`}
      onContextMenu={onContextMenu}
    >
      <Knob
        value={value}
        automationValue={automationValue}
        cancelValue={value}
        min={-1}
        max={1}
        defaultValue={0}
        size={knobSize}
        accent={color}
        onCommit={onCommit}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      />
      {showPanValue && (
        <span className="w-4 text-center font-mono font-medium text-foreground/50 text-[8px]">
          {automationValue == null
            ? <span>{shownValueLabel}</span>
            : (
              <EasedReadout
                value={automationValue}
                format={formatPan}
                interacting={interacting}
                motionKey={motionKey}
              />
            )}
        </span>
      )}
      {menuPosition && (
        <RotaryControlMenu
          x={menuPosition.x}
          y={menuPosition.y}
          onClose={onCloseMenu}
          onReset={() => onCommit(0)}
          resetLabel="Reset Pan to Center"
          midiTarget={midiTarget}
        >
          <ContextMenuDivider />
          <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-foreground/45">
            Pan law · {trackName}
          </div>
          {panLaws.map((law) => (
            <ContextMenuItem
              key={law.value}
              checked={activePanLaw === law.value}
              radio
              onClick={() => onSelectPanLaw(law.id)}
            >
              {law.label}
            </ContextMenuItem>
          ))}
          <ContextMenuDivider />
          <div className="px-2.5 py-1.5 text-[10px] leading-snug text-foreground/45">
            Right-click the pan knob to choose how its center level is compensated.
          </div>
        </RotaryControlMenu>
      )}
    </div>
  );
}
