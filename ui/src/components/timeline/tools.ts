/** Shared editor tools for audio + light timeline modes. */
export type TimelineTool = "pointer" | "pencil" | "eraser" | "scissors";

export const TIMELINE_TOOLS: {
  id: TimelineTool;
  label: string;
  shortcut: string;
  /** Short tip shown in the toolbar. */
  tip: string;
}[] = [
  {
    id: "pointer",
    label: "Pointer",
    shortcut: "V",
    tip: "Select, move, marquee",
  },
  {
    id: "pencil",
    label: "Pencil",
    shortcut: "B",
    tip: "Audio: import WAV as region · Light: add cue",
  },
  {
    id: "eraser",
    label: "Eraser",
    shortcut: "E",
    tip: "Click a region or cue to delete it",
  },
  {
    id: "scissors",
    label: "Scissors",
    shortcut: "X",
    tip: "Click a region or cue to split at the click",
  },
];

export function toolCursor(tool: TimelineTool, readOnly: boolean): string {
  if (readOnly) return "default";
  switch (tool) {
    case "pencil":
      return "copy";
    case "eraser":
      return "cell";
    case "scissors":
      // crosshair, not col-resize: splitting aims at a point, and col-resize
      // promises a horizontal drag that resizes something. It is the same
      // cursor the ruler uses for scrubbing, so with the tool active the
      // whole timeline claimed to be scrubbable.
      return "crosshair";
    default:
      return "default";
  }
}
