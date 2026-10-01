// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

export interface PianoRollRenderTheme {
  background: string;
  backgroundSecondary: string;
  backgroundTertiary: string;
  surface: string;
  border: string;
  foreground: string;
  muted: string;
  accent: string;
  accentForeground: string;
}

export interface PianoRollNoteView {
  note: import("@/lib/state/types").MidiNoteRow;
  beat: number;
}
