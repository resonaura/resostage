/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { paletteColor, paletteSize } from "@/lib/theme/theme";

export const TRACK_COLOR_COUNT = paletteSize("track");

/**
 * Resolved `#rrggbb` for an audio track palette slot.
 * Concrete hex (not `var(...)`) so canvas, dimHexColor and `${color}55` alpha
 * suffixes all keep working. Values live in lib/theme's PALETTES.
 */
export function getTrackColor(index: number): string {
  return paletteColor("track", index);
}
