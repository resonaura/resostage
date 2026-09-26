import type { MidiNoteRow, MidiRegionRow } from "../../lib/types";

export type PianoRollTool = "select" | "draw" | "erase" | "brush" | "slice";

export type PianoRollBottomLane =
  | "velocity"
  | "cc1" // Modulation Wheel
  | "cc11" // Expression
  | "cc64" // Sustain Pedal
  | "pitchBend";

export type GridSnapValue =
  | 4.0   // 1 Bar (4/4)
  | 2.0   // 1/2 Bar
  | 1.0   // 1/4 (1 Beat)
  | 0.5   // 1/8 Beat
  | 0.25  // 1/16 Beat
  | 0.125 // 1/32 Beat
  | 0;    // Off

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
  type: "move" | "resize" | "marquee" | "velocity" | "draw" | "brush" | "slice" | "cc";
  startPointerX: number;
  startPointerY: number;
  startBeat: number;
  startPitch: number;
  initialNotesSnapshot: Map<number, MidiNoteRow>;
  marqueeBox?: {
    startBeat: number;
    startPitch: number;
    currentBeat: number;
    currentPitch: number;
  };
}

export interface PianoRollProps {
  region: MidiRegionRow;
  companionRegions?: MidiRegionRow[];
  track?: import("../../lib/types").TrackRow | null;
  tracks?: import("../../lib/types").TrackRow[];
  onSelectTrack?: (trackId: string) => void;
  regions?: MidiRegionRow[];
  onSelectRegion?: (regionId: string) => void;
  trackColor?: string;
  playheadBeats?: number;
  isPlaying?: boolean;
  onNotesChange: (notes: MidiNoteRow[]) => void;
  onRegionChange?: (region: MidiRegionRow) => void;
  className?: string;
}
