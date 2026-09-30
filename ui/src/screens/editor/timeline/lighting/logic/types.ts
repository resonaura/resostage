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
