// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import type { CSSProperties } from "react";
import { withHexAlpha } from "@/lib/theme/cssColor";
import type { LightCueRow } from "@/lib/state/types";
import { themeAdaptedColor } from "@/screens/light/logic/tintFilter";

export const CUE_EDGE_PX = 10;

/**
 * A cue with its colour leaned toward the theme.
 *
 * Applied to the cue rather than over it. Filters and blend overlays both
 * covered the whole block, which squared off its rounded corners and, on the
 * hint strip, painted the gaps between cues -- and both replaced the cue's
 * hue outright instead of adapting it. Rewriting the colour before anything
 * draws leaves the geometry alone entirely.
 */
export function adaptCueToTheme(cue: LightCueRow, themeColor: string): LightCueRow {
  const hex = rgbToHexTriple(cue.color.r, cue.color.g, cue.color.b);
  const out = themeAdaptedColor(hex, themeColor);
  const n = parseInt(out.slice(1), 16);
  return {
    ...cue,
    color: {
      ...cue.color,
      r: (n >> 16) & 0xff,
      g: (n >> 8) & 0xff,
      b: n & 0xff,
    },
  };
}

function rgbToHexTriple(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Selection chrome — outline only when selected (no default border). */
export function lightCueSelectionStyle(
  selected: boolean,
  accentColor: string,
): CSSProperties {
  // Same crossfade as the body: switching colour modes should read as one
  // deliberate change, not as the lane blinking.
  const transition = "border-color 260ms ease-out, box-shadow 260ms ease-out";
  if (!selected) return { border: "none", transition };
  return {
    border: `1.5px solid ${accentColor}`,
    boxShadow: `0 0 0 1px ${withHexAlpha(accentColor, "aa")}, 0 0 8px ${withHexAlpha(accentColor, "44")}`,
    transition,
  };
}
