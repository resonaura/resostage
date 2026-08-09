import {
  paletteColor,
  paletteSize,
  roleColor,
  type ColorRole,
} from "../../lib/theme";

export const SIDEBAR_WIDTH = 240;
export const EVENT_LANE_HEIGHT = 24;
export const SECTION_LANE_HEIGHT = 22;
/**
 * Logic Pro–style two-tier bar ruler:
 *   upper = cycle / bar numbers (create·move cycle only)
 *   lower = beat subdivisions + playhead scrub
 */
export const RULER_CYCLE_HEIGHT = 16;
export const RULER_BEAT_HEIGHT = 18;
export const RULER_HEIGHT = RULER_CYCLE_HEIGHT + RULER_BEAT_HEIGHT;
export const SECTION_PRESETS = [
  "Intro",
  "Verse",
  "Chorus",
  "Bridge",
  "Solo",
  "Outro",
];
export const MIN_PX_PER_SEC = 0.25; // allow zoom-out until whole set fits (no H-scroll)
export const MAX_PX_PER_SEC = 400;

export const TRACK_COLOR_COUNT = paletteSize("track");

/**
 * Resolved `#rrggbb` for an audio track palette slot.
 * Concrete hex (not `var(...)`) so canvas, dimHexColor and `${color}55` alpha
 * suffixes all keep working. Values live in lib/theme's PALETTES.
 */
export function getTrackColor(index: number): string {
  return paletteColor("track", index);
}

/** Edge hit zone width (fade / trim / loop / duration). */
export const EDGE_PX = 12;

/**
 * Free canvas past the end of the last song.
 *
 * Out of bounds, not part of the project: the transport will not run into it
 * and it is drawn dimmed. It exists so the last song's end marker has
 * somewhere to be dragged TO -- you cannot extend a song into space that
 * isn't there -- and so the arrangement does not feel like it hits a wall.
 *
 * Both a time and a pixel floor, because either alone breaks at an extreme of
 * the zoom range: 30s is invisible at MIN_PX_PER_SEC, and 240px is a
 * meaningless sliver of a set at MAX_PX_PER_SEC.
 */
export const TRAILING_SLACK_SECONDS = 30;
export const TRAILING_SLACK_MIN_PX = 240;

/** Event type on the wire -> the role that names its colour. */
const EVENT_COLOR_ROLES: Record<string, ColorRole> = {
  programChange: "eventProgramChange",
  noteOn: "eventNoteOn",
  noteOff: "eventNoteOff",
  cc: "eventCc",
  http: "eventHttp",
  dmx: "eventDmx",
};

/** Resolved event-marker colour by event type; grey for an unknown type. */
export function getEventColor(type: string): string {
  const role = EVENT_COLOR_ROLES[type];
  return role ? roleColor(role) : "#8e8e93";
}
