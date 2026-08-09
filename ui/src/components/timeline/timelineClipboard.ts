import type { CueClipboardEntry } from "./cueEdit";
import type { RegionClipboardEntry } from "./regionUtils";

/**
 * What was last cut or copied in the timeline.
 *
 * Module state rather than a ref inside Timeline, because Timeline unmounts:
 * it belongs to the Editor tab, so copying a region, stepping over to the
 * Player to hear where it should go, and stepping back used to lose the
 * clipboard. Nothing about a clipboard should depend on which screen you are
 * looking at.
 *
 * Two of them, not one. Regions and light cues are never interchangeable --
 * pasting a cue onto an audio track is not a thing that can mean anything --
 * and keeping separate buffers means switching between Audio and Light view
 * does not silently clobber what you had in the other.
 *
 * Deliberately NOT the system clipboard. These entries reference audio inside
 * the open project by path, so text on the pasteboard would be meaningless to
 * any other app and a promise this cannot keep between two ResoStage windows
 * with different projects open.
 */
let regions: RegionClipboardEntry[] = [];
let cues: CueClipboardEntry[] = [];

export function setClipboardRegions(entries: RegionClipboardEntry[]): void {
  regions = entries;
  cues = [];
}

export function getClipboardRegions(): RegionClipboardEntry[] {
  return regions;
}

export function setClipboardCues(entries: CueClipboardEntry[]): void {
  cues = entries;
  regions = [];
}

export function getClipboardCues(): CueClipboardEntry[] {
  return cues;
}

/** Whether a paste would do anything, for greying out the menu item. */
export function hasClipboard(kind: "region" | "cue"): boolean {
  return kind === "region" ? regions.length > 0 : cues.length > 0;
}
