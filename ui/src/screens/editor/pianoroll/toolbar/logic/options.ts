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
  { id: "velocity", label: "Velocity", section: "Notes" },
  { id: "cc1", label: "CC 1 · Modulation", section: "Common MIDI Controllers" },
  { id: "cc11", label: "CC 11 · Expression", section: "Common MIDI Controllers" },
  { id: "cc64", label: "CC 64 · Sustain", section: "Switch Pedals" },
  { id: "cc65", label: "CC 65 · Portamento", section: "Switch Pedals" },
  { id: "cc66", label: "CC 66 · Sostenuto", section: "Switch Pedals" },
  { id: "cc67", label: "CC 67 · Soft Pedal", section: "Switch Pedals" },
  { id: "cc68", label: "CC 68 · Legato", section: "Switch Pedals" },
  { id: "cc69", label: "CC 69 · Hold 2", section: "Switch Pedals" },
  { id: "pitchBend", label: "Pitch Bend", section: "Channel Events" },
];

const COMMON_CONTROLLER_IDS = new Set(
  PIANO_ROLL_LANE_OPTIONS
    .map((option) => option.id)
    .filter((id) => id.startsWith("cc")),
);

/** Add imported, nonstandard CC lanes without making the picker list all 128 by default. */
export function pianoRollLaneOptions(
  controllerNumbers: Iterable<number>,
  selectedLane: string,
  umpControllerNumbers: Iterable<number> = [],
  hasUmpPitchBend = false,
): readonly SelectOption[] {
  const customIds = new Set<string>();
  for (const controller of controllerNumbers) {
    if (Number.isInteger(controller) && controller >= 0 && controller <= 127) {
      const id = `cc${controller}`;
      if (!COMMON_CONTROLLER_IDS.has(id)) customIds.add(id);
    }
  }
  if (/^cc(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(selectedLane)
      && !COMMON_CONTROLLER_IDS.has(selectedLane))
    customIds.add(selectedLane);

  const umpIds = new Set<number>();
  for (const controller of umpControllerNumbers) {
    if (Number.isInteger(controller) && controller >= 0 && controller <= 127)
      umpIds.add(controller);
  }
  const selectedUmpMatch = /^umpCc(\d{1,3})$/.exec(selectedLane);
  if (selectedUmpMatch) {
    const controller = Number(selectedUmpMatch[1]);
    if (controller <= 127) umpIds.add(controller);
  }
  const includeUmpPitchBend = hasUmpPitchBend || selectedLane === "umpPitchBend";

  if (customIds.size === 0 && umpIds.size === 0 && !includeUmpPitchBend)
    return PIANO_ROLL_LANE_OPTIONS;
  const customOptions = [...customIds]
    .sort((left, right) => Number(left.slice(2)) - Number(right.slice(2)))
    .map((id) => ({ id, label: `CC ${id.slice(2)}`, section: "Other MIDI Controllers" }));
  const pitchBendIndex = PIANO_ROLL_LANE_OPTIONS.findIndex((option) => option.id === "pitchBend");
  const umpOptions: SelectOption[] = [
    ...[...umpIds].sort((left, right) => left - right).map((controller) => ({
      id: `umpCc${controller}`,
      label: `MIDI 2.0 CC ${controller} · Preview`,
      section: "MIDI 2.0 UMP",
    })),
    ...(includeUmpPitchBend ? [{
      id: "umpPitchBend",
      label: "MIDI 2.0 Pitch Bend · Preview",
      section: "MIDI 2.0 UMP",
    }] : []),
  ];
  return [
    ...PIANO_ROLL_LANE_OPTIONS.slice(0, pitchBendIndex),
    ...customOptions,
    ...PIANO_ROLL_LANE_OPTIONS.slice(pitchBendIndex),
    ...umpOptions,
  ];
}

export const PIANO_ROLL_ROOT_OPTIONS: readonly SelectOption[] = NOTE_NAMES.map(
  (label, root) => ({ id: String(root), label }),
);

export const PIANO_ROLL_SCALE_OPTIONS: readonly SelectOption[] = Object.entries(
  SCALE_LABELS,
).map(([id, label]) => ({ id, label }));
