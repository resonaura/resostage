/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { AutomationLaneRow, MidiNoteRow, MidiRegionRow, ProjectCycleRow, SongRow } from "@/lib/state/types";

export type PianoRollTool = "select" | "draw" | "erase" | "brush" | "slice";

export type PianoRollBottomLane =
  | "velocity"
  | "cc1" // Modulation Wheel
  | "cc11" // Expression
  | "cc64" // Sustain Pedal
  | "pitchBend";

export type GridSnapValue =
  | 4.0 // 1 Bar (4/4)
  | 2.0 // 1/2 Bar
  | 1.0 // 1/4 (1 Beat)
  | 0.5 // 1/8 Beat
  | 0.25 // 1/16 Beat
  | 0.125 // 1/32 Beat
  | 0; // Off

export type ScaleMode =
  | "chromatic"
  | "major"
  | "minor"
  | "harmonicMinor"
  | "melodicMinor"
  | "dorian"
  | "phrygian"
  | "lydian"
  | "mixolydian"
  | "majorPentatonic"
  | "minorPentatonic"
  | "blues";

export interface PianoRollViewport {
  pixelsPerBeat: number;
  pixelsPerPitch: number;
  scrollBeats: number;
  scrollPitch: number; // Bottom visible pitch (0..127)
  keyWidth: number;
  velocityLaneHeight: number;
}

export interface DraggingState {
  type:
    | "move"
    | "resize"
    | "marquee"
    | "velocity"
    | "draw"
    | "brush"
    | "slice"
    | "cc"
    | "playhead";
  startPointerX: number;
  startPointerY: number;
  startBeat: number;
  /** Most recent sampled beat during an interval sweep gesture (e.g. Brush). */
  lastBeat?: number;
  startPitch: number;
  targetNoteIds?: Set<number>;
  /** Pointer-down selection used by an additive Shift-marquee. */
  additiveSelection?: ReadonlySet<number>;
  initialNotesSnapshot: Map<number, MidiNoteRow>;
  marqueeBox?: {
    startBeat: number;
    startPitch: number;
    currentBeat: number;
    currentPitch: number;
  };
}

/** Mutable working copy used while painting velocities across note starts. */
export interface PianoRollVelocityPaintState {
  lastBeat: number;
  notes: MidiNoteRow[];
  noteById: Map<number, MidiNoteRow>;
}

/** Snapshot and cursor state for an in-progress region automation gesture. */
export interface PianoRollControllerGesture {
  beforeLanes: AutomationLaneRow[] | null;
  baseLanes: AutomationLaneRow[];
  laneIndex: number;
  pointIndex: number;
  added: boolean;
  anchorBeat: number;
  changed: boolean;
  lastBeat: number;
  lastValue: number;
}

/** Expected Core acknowledgement for the last region automation edit. */
export interface PianoRollPendingAutomationCommit {
  parameterId: string;
  points: AutomationLaneRow["points"];
}

export interface PianoRollProps {
  region: MidiRegionRow;
  companionRegions?: MidiRegionRow[];
  activeMidiNotes?: Array<{ trackId: string; pitch: number }>;
  track?: import("@/lib/state/types").TrackRow | null;
  tracks?: import("@/lib/state/types").TrackRow[];
  onSelectTrack?: (trackId: string) => void;
  regions?: MidiRegionRow[];
  onSelectRegion?: (regionId: string) => void;
  selectedRegionIds?: string[];
  onToggleRegionVisible?: (regionId: string, visible: boolean) => void;
  trackColor?: string;
  playheadBeats?: number;
  getLivePlayheadBeats?: () => number;
  timeSignatureNumerator?: number;
  isPlaying?: boolean;
  onSeek?: (beats: number) => void;
  onNotesChange: (notes: MidiNoteRow[]) => void;
  onRegionChange?: (region: MidiRegionRow) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoLabel?: string | null;
  redoLabel?: string | null;
  onUndo?: () => void;
  onRedo?: () => void;
  projectCycle?: ProjectCycleRow;
  projectSongIndex?: number;
  projectSong?: SongRow;
  projectSongLength?: number;
  className?: string;
}
