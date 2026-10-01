// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { paletteColor, paletteSize } from "@/lib/theme";

// Distinct palette from the audio tracks so light reads as a different layer.
// Source of truth for both the values and the size: lib/theme's PALETTES.
export const LIGHT_COLOR_COUNT = paletteSize("light");

/**
 * Resolved `#rrggbb` for a light-track palette slot.
 * Concrete hex so canvas and alpha suffixes keep working.
 */
export function getLightColor(index: number): string {
  return paletteColor("light", index);
}
