// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

/**
 * Logic Pro–style two-tier bar ruler:
 *   upper = cycle / bar numbers (create·move cycle only)
 *   lower = beat subdivisions + playhead scrub
 */
export const RULER_CYCLE_HEIGHT = 16;
export const RULER_BEAT_HEIGHT = 18;
export const RULER_HEIGHT = RULER_CYCLE_HEIGHT + RULER_BEAT_HEIGHT;
