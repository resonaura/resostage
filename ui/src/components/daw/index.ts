/**
 * DAW primitives — the controls that make this app look like a DAW rather than
 * a web app: rotaries, meters, the transport clock, and the button set that
 * used to be hand-rolled at every call site.
 *
 * Import from the barrel (`../daw`), not the individual files, so a component
 * can be split or renamed without touching call sites.
 *
 * What belongs here: anything reusable that is specific to audio/lighting
 * control surfaces. What does not: screen-specific composition (ChannelStrip,
 * TimelineToolbar) and anything HeroUI already does well — this is a
 * supplement to HeroUI, not a replacement for it. Styling goes through the
 * accent tokens (see styles/theme.css) rather than literal colours, so the
 * whole set re-themes from one place.
 */

export { Knob } from "./Knob";
export { SendArcKnob, SEND_CEILING_DB, SEND_FLOOR_DB } from "./SendArcKnob";
export { LevelMeterBar, CLIP_COLOR, CLIP_GLOW } from "./LevelMeterBar";
export { VUMeter } from "./VUMeter";
export { TimeDisplay } from "./TimeDisplay";
export { formatBarBeat, formatClock, formatClockPrecise } from "./timeFormat";
export {
  DawButton,
  IconButton,
  SoftButton,
  ToggleButton,
  type DawButtonSize,
} from "./Buttons";
export {
  parseTintColor,
  readableOn,
  tintClass,
  tintVars,
  type TintEmphasis,
} from "./tint";
