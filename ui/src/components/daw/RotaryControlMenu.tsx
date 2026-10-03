/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "@/components/common/ContextMenu";
import type { RotaryMidiTarget } from "@/components/daw/logic/rotaryMidiTarget";
import { settings as settingsApi } from "@/lib/state/api";

/** Shared right-click actions for rotary controls, with screen-specific items
 * composed after the common reset and safe continuous MIDI binding actions. */
export function RotaryControlMenu({
  x,
  y,
  onClose,
  onReset,
  resetLabel = "Reset to Default",
  midiTarget,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onReset: () => void;
  resetLabel?: string;
  midiTarget?: RotaryMidiTarget;
  children?: ReactNode;
}) {
  return (
    <ContextMenu x={x} y={y} width={232} onClose={onClose}>
      <ContextMenuItem
        onClick={() => {
          onReset();
          onClose();
        }}
      >
        {resetLabel}
      </ContextMenuItem>
      {midiTarget && (
        <>
          <ContextMenuDivider />
          <ContextMenuItem
            onClick={() => {
              void settingsApi.midiLearn(midiTarget);
              onClose();
            }}
          >
            MIDI CC Learn…
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void settingsApi.midiClear(midiTarget);
              onClose();
            }}
          >
            Clear MIDI Binding
          </ContextMenuItem>
        </>
      )}
      {children}
    </ContextMenu>
  );
}
