/**
 * Cosmetic/informational metadata for DmxGeneric fixtures -- shape (which 3D
 * mesh the stage draws) and channelProfile (a named DMX personality preset).
 * Neither concept is known to the engine: a fixture's actual wire behavior
 * is entirely a function of addressable/ledCount and the resolved cue value
 * (see engine/lighting/LightOutputResolver.h). This table is the ONE place
 * that maps a channelProfile to a channel count and per-channel role labels
 * -- picking a profile in the UI writes both channelProfile and the derived
 * dmxChannelCount in the same fixtureUpdate call, so the backend never needs
 * to know this table exists.
 */

export type FixtureShape = "bar" | "par" | "wash" | "spot" | "movingHead" | "strip";

export const SHAPE_META: Record<FixtureShape, { label: string }> = {
  bar: { label: "Bar" },
  par: { label: "PAR Can" },
  wash: { label: "Wash" },
  spot: { label: "Spot" },
  movingHead: { label: "Moving Head" },
  strip: { label: "Strip" },
};

// Shapes offered to DmxGeneric fixtures -- "bar" is a ResoLightBar's own
// shape (a literal LED bar), not a style choice a generic fixture can pick.
export const DMX_GENERIC_SHAPES: FixtureShape[] = ["par", "wash", "spot", "movingHead", "strip"];

export type ChannelProfile =
  | "dimmer"
  | "rgb"
  | "rgbw"
  | "rgbwa"
  | "dimmerRgb"
  | "dimmerRgbw"
  | "panTiltDimmerRgb"
  | "panTiltDimmerRgbw"
  | "custom";

export const CHANNEL_PROFILES: Record<
  ChannelProfile,
  { label: string; channelCount: number; roles: string[] }
> = {
  dimmer: { label: "Dimmer", channelCount: 1, roles: ["Dimmer"] },
  rgb: { label: "RGB", channelCount: 3, roles: ["R", "G", "B"] },
  rgbw: { label: "RGBW", channelCount: 4, roles: ["R", "G", "B", "W"] },
  rgbwa: { label: "RGBWA", channelCount: 5, roles: ["R", "G", "B", "W", "A"] },
  dimmerRgb: { label: "Dimmer + RGB", channelCount: 4, roles: ["Dimmer", "R", "G", "B"] },
  dimmerRgbw: { label: "Dimmer + RGBW", channelCount: 5, roles: ["Dimmer", "R", "G", "B", "W"] },
  panTiltDimmerRgb: {
    label: "Pan/Tilt + Dimmer + RGB",
    channelCount: 6,
    roles: ["Pan", "Tilt", "Dimmer", "R", "G", "B"],
  },
  panTiltDimmerRgbw: {
    label: "Pan/Tilt + Dimmer + RGBW",
    channelCount: 7,
    roles: ["Pan", "Tilt", "Dimmer", "R", "G", "B", "W"],
  },
  // channelCount 0 is a sentinel meaning "don't touch dmxChannelCount" --
  // Custom is the escape hatch for a fixture that doesn't match any named
  // personality; the user drives Ch Count by hand instead.
  custom: { label: "Custom", channelCount: 0, roles: [] },
};

/** `["Ch50 Dimmer", "Ch51 R", ...]` for the read-only breakdown under the profile picker. */
export function channelRoleLabels(profile: ChannelProfile, startChannel: number): string[] {
  return CHANNEL_PROFILES[profile].roles.map((role, i) => `Ch${startChannel + i} ${role}`);
}
