import { getTrackColor } from "../../components/timeline/constants";

// Re-export mixer role colours so strip files can import from one place.
export {
  busCycleColor,
  extOutColor,
  masterColor,
  metronomeColor,
  monoOutColor,
  sendColor,
} from "../../lib/mixerColors";

// Sentinel for the primary routing <select>: picking it reveals the channel
// list in the secondary select (two-step Ext. Out UX).
export const EXT_OUTPUT_VALUE = "__ext_output__";
export const SENDS_ONLY_VALUE = "__sends_only__";

// Shared native <select> chrome — primary and secondary must match so the
// secondary Ext. Out channel picker does not look like a different control.
// Keep labels plain (no "Out: " prefix): the OS native popup shows option
// text as-is and we should not decorate it.
export const ROUTING_SELECT_CLASS =
  "w-full box-border rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] font-medium text-foreground focus:outline-none h-[22px]";

// Same footprint as ROUTING_SELECT_CLASS, inert placeholder when the second
// picker is hidden (keeps faders level across strips).
export const ROUTING_SELECT_SPACER =
  "w-full box-border rounded border border-default/40 bg-background px-1 py-0.5 h-[22px]";

/** Track strip accent — resolved hex from theme.css `--track-color-N`. */
export function colorForIndex(i: number): string {
  return getTrackColor(i);
}

export const GAIN_MIN = -60;
export const GAIN_MAX = 12;
