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
