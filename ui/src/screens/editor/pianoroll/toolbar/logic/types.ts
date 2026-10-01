/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { TimelineFollowMode } from "@/screens/editor/timeline/toolbar/logic/types";
import type {
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollTool,
  ScaleMode,
} from "@/screens/editor/pianoroll/logic/types";

/** Presentational toolbar callbacks; project and note ownership stay in PianoRoll. */
export interface PianoRollToolbarProps {
  tool: PianoRollTool;
  onToolChange: (tool: PianoRollTool) => void;
  snap: GridSnapValue;
  onSnapChange: (snap: GridSnapValue) => void;
  scaleMode: ScaleMode;
  onScaleModeChange: (mode: ScaleMode) => void;
  rootNote: number;
  onRootNoteChange: (root: number) => void;
  snapToScale: boolean;
  onSnapToScaleChange: (snap: boolean) => void;
  showGhostNotes: boolean;
  onShowGhostNotesChange: (show: boolean) => void;
  loopEnabled?: boolean;
  onLoopEnabledChange?: (enabled: boolean) => void;
  loopLengthBeats?: string;
  onLoopLengthBeatsChange?: (beats: string) => void;
  onLoopLengthBeatsCommit?: () => void;
  selectedCount: number;
  onQuantize: () => void;
  onHumanize: () => void;
  onLegato?: () => void;
  onOverlapTrim?: () => void;
  onTranspose: (semitones: number) => void;
  onDeleteSelected: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoLabel?: string | null;
  redoLabel?: string | null;
  onUndo?: () => void;
  onRedo?: () => void;
  onCopySelected?: () => void;
  onCutSelected?: () => void;
  onSplitAtPlayhead?: () => void;
  snapEnabled?: boolean;
  onToggleSnap?: () => void;
  bottomLane?: PianoRollBottomLane;
  onBottomLaneChange?: (lane: PianoRollBottomLane) => void;
  pixelsPerBeat?: number;
  onPixelsPerBeatChange?: (val: number) => void;
  pixelsPerPitch?: number;
  onPixelsPerPitchChange?: (val: number) => void;
  followMode?: TimelineFollowMode;
  onCycleFollowMode?: () => void;
  catchOnPlay?: boolean;
  onCatchOnPlayChange?: (v: boolean) => void;
  catchOnSeek?: boolean;
  onCatchOnSeekChange?: (v: boolean) => void;
}
