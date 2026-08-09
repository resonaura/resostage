/**
 * DAW primitives — the controls that make this app look like a DAW rather than
 * a web app: rotaries, meters, and the transport clock.
 *
 * Import from the barrel (`../daw`), not the individual files, so a component
 * can be split or renamed without touching call sites.
 *
 * What belongs here: anything reusable that is specific to audio/lighting
 * control surfaces. What does not: screen-specific composition (ChannelStrip,
 * TimelineToolbar) and button wrappers — use HeroUI Button/ButtonGroup/
 * ToggleButtonGroup directly instead.
 */

export { Knob } from "./Knob";
export { LevelMeterBar } from "./LevelMeterBar";
export { LiveReadout } from "./LiveReadout";
export { MeterFader } from "./MeterFader";
export { CLIP_COLOR, CLIP_GLOW } from "./meterBallistics";
export { SEND_CEILING_DB, SEND_FLOOR_DB, SendArcKnob } from "./SendArcKnob";
export { TimeDisplay } from "./TimeDisplay";
export { formatBarBeat, formatClock, formatClockPrecise } from "./timeFormat";
export { VUMeter } from "./VUMeter";
