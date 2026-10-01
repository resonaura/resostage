// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

export type TrackPolarity = "left" | "right" | "none" | "both";

export type TrackPolarityOption = {
  value: TrackPolarity;
  label: string;
};

/** Prefer the optimistic edit, then persisted per-channel state, then legacy phase inversion. */
export function resolveTrackPolarity(
  optimistic: TrackPolarity | null,
  persisted?: TrackPolarity,
  legacyPhaseInvert?: boolean,
): TrackPolarity {
  return optimistic ?? persisted ?? (legacyPhaseInvert ? "both" : "none");
}

/** Toggle polarity off when active; when enabling, choose the usable channels. */
export function toggleTrackPolarity(
  current: TrackPolarity,
  isMono: boolean,
): TrackPolarity {
  return current !== "none" ? "none" : isMono ? "left" : "both";
}

/** Mono strips cannot expose independent left/right polarity choices. */
export function getTrackPolarityOptions(
  isMono: boolean,
): TrackPolarityOption[] {
  return [
    { value: "both", label: "Both Channels (L+R)" },
    ...(!isMono
      ? [
          { value: "left" as const, label: "Left Channel Only (L)" },
          { value: "right" as const, label: "Right Channel Only (R)" },
        ]
      : []),
    { value: "none", label: "Normal (0°)" },
  ];
}
