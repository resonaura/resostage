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

// Sentinel for the primary routing select: picking it reveals the channel
// list in the secondary select (two-step Ext. Out UX).
export const EXT_OUTPUT_VALUE = "__ext_output__";
export const SENDS_ONLY_VALUE = "__sends_only__";

// Every routing picker in the console is the same size, so the secondary
// Ext. Out channel picker never looks like a different control. `xs` is 22px
// tall — see the density block in styles/tones.css.
export const ROUTING_SELECT_SIZE = "xs" as const;

// Inert placeholder for when the second picker is hidden. Same footprint as a
// routing select, so faders stay level across strips whether or not a strip
// is showing its channel picker.
export const ROUTING_SELECT_SPACER = "w-full shrink-0 h-[22px]";

/** Track strip accent — resolved hex from theme.css `--track-color-N`. */
export function colorForIndex(i: number): string {
  return getTrackColor(i);
}

export const GAIN_MIN = -60;
export const GAIN_MAX = 12;
