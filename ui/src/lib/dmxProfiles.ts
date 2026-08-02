/**
 * Cosmetic/informational fixture metadata, shared by both fixture kinds:
 * `shape` (which 3D layout the stage draws -- a mesh silhouette for
 * DmxGeneric, a pixel-array rearrangement for ResoLightBar) and
 * `channelProfile` (a named DMX personality preset, DmxGeneric only).
 * Neither concept is known to the engine: a fixture's actual wire behavior
 * is entirely a function of addressable/ledCount and the resolved cue value
 * (see engine/lighting/LightOutputResolver.h). This table is the ONE place
 * that maps a channelProfile to a channel count and per-channel role labels
 * -- picking a profile in the UI writes both channelProfile and the derived
 * dmxChannelCount in the same fixtureUpdate call, so the backend never needs
 * to know this table exists.
 */

export type FixtureShape = "bar" | "strip" | "ring" | "matrix" | "par" | "wash" | "spot" | "movingHead";

export const SHAPE_META: Record<FixtureShape, { label: string }> = {
  bar: { label: "Bar" },
  strip: { label: "Strip" },
  ring: { label: "Ring" },
  matrix: { label: "Matrix" },
  par: { label: "PAR Can" },
  wash: { label: "Wash" },
  spot: { label: "Spot" },
  movingHead: { label: "Moving Head" },
};

// Shapes offered to DmxGeneric fixtures -- a single non-addressable point
// has nothing to spatially rearrange, so these are all about overall
// housing silhouette (which real third-party instrument this is), not
// pixel layout.
export const DMX_GENERIC_SHAPES: FixtureShape[] = ["par", "wash", "spot", "movingHead", "strip"];

// Shapes offered to ResoLightBar fixtures -- ResoStage's own addressable
// product, so these rearrange the SAME linear ledCount pixel array into a
// different physical layout (see ProjectSchema.h's LightFixture::shape doc
// comment): "bar" (default) keeps the existing vertical stack, "strip" is
// the same stack in a thinner cross-section, "ring"/"matrix" genuinely
// reposition each pixel (circle / grid) -- see ResoLightStage3D.tsx.
export const RESOLIGHT_SHAPES: FixtureShape[] = ["bar", "strip", "ring", "matrix"];

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

// ─── ResoLightBar color type ────────────────────────────────────────────────
//
// Unlike DmxGeneric's channelProfile above (a UI label/channel-count
// convenience the engine never reads), a ResoLightBar's color type
// genuinely changes how many bytes get written per pixel and what they
// mean -- see engine/lighting/ResoLightChannelMap.h's colorProfileByteCount
// and LightOutputResolver.h's resolveLedWireColors (the RGBW split /
// Dimmer's loudest-channel conversion). Only these three: no Pan/Tilt or
// other leading-channel concept applies to ResoStage's own addressable
// product the way it might to a third-party DMX fixture.
export type ResoLightColorType = "dimmer" | "rgb" | "rgbw";
export const RESOLIGHT_COLOR_TYPES: ResoLightColorType[] = ["dimmer", "rgb", "rgbw"];

export const RESOLIGHT_COLOR_TYPE_META: Record<ResoLightColorType, { label: string; description: string }> = {
  dimmer: { label: "Dimmer", description: "1 channel per pixel: brightness only -- set the cue color to white." },
  rgb: { label: "RGB", description: "3 channels per pixel: full color (the default)." },
  rgbw: { label: "RGBW", description: "4 channels per pixel: color plus a dedicated white channel, split out automatically." },
};

// Hand-ported copy of colorProfileByteCount + resoLightBarChannelCount
// (ResoLightChannelMap.h) -- purely for the UI's own "real channel count"
// readout, kept in sync by hand like every other math duplicated across
// the two languages in this codebase (see RESTORE_POINT.md).
export function resoLightRealChannelCount(
  colorType: ResoLightColorType,
  ledCount: number,
  addressable: boolean,
): number {
  const perPixel = colorType === "dimmer" ? 1 : colorType === "rgbw" ? 4 : 3;
  return addressable ? Math.max(1, ledCount) * perPixel : perPixel;
}
