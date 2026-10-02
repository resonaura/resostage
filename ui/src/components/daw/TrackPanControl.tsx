/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { MouseEventHandler } from "react";
import { Knob } from "@/components/daw/Knob";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "@/components/common/ContextMenu";
import type { TrackPanLawOption } from "@/components/daw/logic/panLaw";

/** Presentational track-pan control; state and commands come from its owner. */
export function TrackPanControl({
  value,
  valueLabel,
  trackName,
  activePanLaw,
  panLaws,
  menuPosition,
  color,
  knobSize,
  showPanValue,
  onCommit,
  onDragStart,
  onDragEnd,
  onContextMenu,
  onCloseMenu,
  onSelectPanLaw,
}: {
  value: number;
  valueLabel: string;
  trackName: string;
  activePanLaw: string;
  panLaws: readonly TrackPanLawOption[];
  menuPosition: { x: number; y: number } | null;
  color: string;
  knobSize: number;
  showPanValue: boolean;
  onCommit: (value: number) => void;
  onDragStart?: (initialValue: number) => void;
  onDragEnd?: (finalValue: number) => void;
  onContextMenu: MouseEventHandler<HTMLDivElement>;
  onCloseMenu: () => void;
  onSelectPanLaw: (lawId: number) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-0.5"
      title={`Pan: ${valueLabel} · ${activePanLaw} pan law (right-click to change)`}
      onContextMenu={onContextMenu}
    >
      <Knob
        value={value}
        min={-1}
        max={1}
        defaultValue={0}
        size={knobSize}
        accent={color}
        onCommit={onCommit}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />
      {showPanValue && (
        <span className="w-4 text-center font-mono font-medium text-foreground/50 text-[8px]">
          {valueLabel}
        </span>
      )}
      {menuPosition && (
        <ContextMenu
          x={menuPosition.x}
          y={menuPosition.y}
          width={232}
          onClose={onCloseMenu}
        >
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
        </ContextMenu>
      )}
    </div>
  );
}
