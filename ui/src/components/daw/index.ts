// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

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

export { Knob } from "@/components/daw/Knob";
export { LevelMeterBar } from "@/components/daw/LevelMeterBar";
export { LiveReadout } from "@/components/daw/LiveReadout";
export { MeterFader } from "@/components/daw/MeterFader";
export { TrackPanControl } from "@/components/daw/TrackPanControl";
export { clipColor, clipGlow } from "@/components/daw/logic/meterBallistics";
export { SEND_CEILING_DB, SEND_FLOOR_DB, SendArcKnob } from "@/components/daw/SendArcKnob";
export { TimeDisplay } from "@/components/daw/TimeDisplay";
export { formatBarBeat, formatClock, formatClockPrecise } from "@/components/daw/logic/timeFormat";
export { VUMeter } from "@/components/daw/VUMeter";
