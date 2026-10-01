// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

export interface CueSelKey {
  songIndex: number;
  cueId: string;
}

/** Active cross-lane cue drag preview, acknowledged when project state updates. */
export interface LightCueDragState {
  key: string;
  songIndex: number;
  cueId: string;
  start: number;
  duration: number;
  targetTrackId: string;
}
