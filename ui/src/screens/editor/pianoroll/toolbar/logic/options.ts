/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { SelectOption } from "@/components/ui";
import { NOTE_NAMES, SCALE_LABELS } from "@/screens/editor/pianoroll/logic/scales";

// These are note values expressed in quarter-note beats, not bars. Calling
// four beats "1 Bar" is incorrect when the song is not in 4/4.
export const PIANO_ROLL_SNAP_OPTIONS: readonly SelectOption[] = [
  { id: "4", label: "1/1" },
  { id: "2", label: "1/2" },
  { id: "1", label: "1/4" },
  { id: "0.5", label: "1/8" },
  { id: "0.25", label: "1/16" },
  { id: "0.125", label: "1/32" },
  { id: "0", label: "Off" },
];

export const PIANO_ROLL_LANE_OPTIONS: readonly SelectOption[] = [
  { id: "velocity", label: "Velocity" },
  { id: "cc1", label: "CC 1 · Modulation" },
  { id: "cc11", label: "CC 11 · Expression" },
  { id: "cc64", label: "CC 64 · Sustain" },
  { id: "pitchBend", label: "Pitch Bend" },
];

export const PIANO_ROLL_ROOT_OPTIONS: readonly SelectOption[] = NOTE_NAMES.map(
  (label, root) => ({ id: String(root), label }),
);

export const PIANO_ROLL_SCALE_OPTIONS: readonly SelectOption[] = Object.entries(
  SCALE_LABELS,
).map(([id, label]) => ({ id, label }));
