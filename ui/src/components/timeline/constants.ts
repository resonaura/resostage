export const SIDEBAR_WIDTH = 240;
export const EVENT_LANE_HEIGHT = 24;
export const SECTION_LANE_HEIGHT = 22;
export const RULER_HEIGHT = 32;
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

export const TRACK_COLORS = [
  "#0091ff",
  "#30d158",
  "#ff9230",
  "#db34f2",
  "#ff375f",
  "#00d2e0",
  "#ff4245",
  "#6d7cff",
  "#00dac3",
  "#3cd3fe",
  "#ffd600",
  "#b78a66",
];

/** Edge hit zone width (fade / trim / loop / duration). */
export const EDGE_PX = 12;

export const EVENT_COLORS: Record<string, string> = {
  programChange: "#30d158",
  noteOn: "#30d158",
  noteOff: "#30d158",
  cc: "#0091ff",
  http: "#ff9230",
  dmx: "#db34f2",
};
