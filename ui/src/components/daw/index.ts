/**
 * DAW primitives — the controls that make this app look like a DAW rather than
 * a web app: rotaries, meters, the transport clock, and button wrappers.
 *
 * Import from the barrel (`../daw`), not the individual files, so a component
 * can be split or renamed without touching call sites.
 *
 * What belongs here: anything reusable that is specific to audio/lighting
 * control surfaces. What does not: screen-specific composition (ChannelStrip,
 * TimelineToolbar) and anything HeroUI already does well — this is a
 * supplement to HeroUI, not a replacement for it.
 */

export { IconButton, SoftButton, ToggleButton } from "./Buttons";
export { Knob } from "./Knob";
export { CLIP_COLOR, CLIP_GLOW, LevelMeterBar } from "./LevelMeterBar";
export { SEND_CEILING_DB, SEND_FLOOR_DB, SendArcKnob } from "./SendArcKnob";
export { TimeDisplay } from "./TimeDisplay";
export { formatBarBeat, formatClock, formatClockPrecise } from "./timeFormat";
export { VUMeter } from "./VUMeter";
