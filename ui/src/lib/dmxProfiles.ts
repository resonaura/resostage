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

// Deliberately NOT offering Dimmer+RGB / Pan+Tilt+Dimmer+RGB(W) personalities
// here, even though they're common on real fixtures: writeDmxChannels (see
// LightEngine.cpp) always writes the resolved R/G/B bytes starting at a
// fixture's OWN dmxStartChannel (channel-count-clamped, but not offset), so
// a profile whose real channel 1 is Pan/Tilt/Dimmer would get color-derived
// bytes written into its movement/level channel instead -- on a real moving
// head that can mean unexpected physical movement, not just a cosmetic
// mismatch. Every profile below is safe because it's honest about what
// actually happens: R/G/B (if present) really do land on channels 1-3, and
// any channel beyond the 3 that get written (W, A) just stays at 0 instead
// of being misdirected. Properly supporting a leading channel would need a
// real dmxColorOffset (or a genuine dimmer/pan/tilt value from the cue
// model, which doesn't exist yet) -- worth doing, not worth faking.
export type ChannelProfile = "dimmer" | "rgb" | "rgbw" | "rgbwa" | "custom";

export const CHANNEL_PROFILES: Record<
  ChannelProfile,
  { label: string; channelCount: number; roles: string[] }
> = {
  // A 1-channel "dimmer" fixture has no color channels for R to misdirect
  // into -- set the cue color to white so the resolved brightness rides
  // this single channel as a de-facto master dimmer.
  dimmer: { label: "Dimmer", channelCount: 1, roles: ["Dimmer (set cue color to white)"] },
  rgb: { label: "RGB", channelCount: 3, roles: ["R", "G", "B"] },
  rgbw: { label: "RGBW", channelCount: 4, roles: ["R", "G", "B", "W (unused)"] },
  rgbwa: { label: "RGBWA", channelCount: 5, roles: ["R", "G", "B", "W (unused)", "A (unused)"] },
  // channelCount 0 is a sentinel meaning "don't touch dmxChannelCount" --
  // Custom is the escape hatch for a fixture that doesn't match any named
  // personality; the user drives Ch Count by hand instead.
  custom: { label: "Custom", channelCount: 0, roles: [] },
};

/** `["Ch50 Dimmer", "Ch51 R", ...]` for the read-only breakdown under the profile picker. */
export function channelRoleLabels(profile: ChannelProfile, startChannel: number): string[] {
  return CHANNEL_PROFILES[profile].roles.map((role, i) => `Ch${startChannel + i} ${role}`);
}
