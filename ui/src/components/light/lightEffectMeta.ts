import React from "react";
import {
  Activity,
  BarChart2,
  Barcode,
  CircleDot,
  CloudLightning,
  Droplet,
  Flame,
  Lightbulb,
  Merge,
  Minus,
  Rainbow,
  ScanLine,
  Sparkles,
  Waves,
  Zap,
} from "lucide-react";
import type { EffectType } from "./LightSidePanel";

export type SourceType = "bus" | "track";
export type GradientPreset =
  | "solid"
  | "greenYellowRed"
  | "custom"
  | "vulcanFire"
  | "toxicFire"
  | "cryoFire"
  | "cyberpunkFire";

export const SUBDIVISIONS = [
  "2",
  "1",
  "1/2",
  "1/3",
  "1/4",
  "1/6",
  "1/8",
  "1/16",
  "1/32",
  "1/64",
] as const;
export type TempoSubdiv = (typeof SUBDIVISIONS)[number];

export const EFFECT_META: Record<
  EffectType,
  { label: string; desc: string; icon: React.ReactNode }
> = {
  none: {
    label: "None",
    desc: "Static color, no modulation",
    icon: React.createElement(Minus, { size: 12 }),
  },
  meter: {
    label: "Meter",
    desc: "Brightness follows audio level (VU meter)",
    icon: React.createElement(BarChart2, { size: 12 }),
  },
  strobe: {
    label: "Strobe",
    desc: "Rapid on/off flashes at set rate",
    icon: React.createElement(Zap, { size: 12 }),
  },
  pulse: {
    label: "Pulse",
    desc: "Smooth brightness pulse",
    icon: React.createElement(Activity, { size: 12 }),
  },
  ripple: {
    label: "Ripple",
    desc: "Travelling wave across fixtures left→right",
    icon: React.createElement(Waves, { size: 12 }),
  },
  converge: {
    label: "Converge",
    desc: "Lines race in from both ends and meet at the centre",
    icon: React.createElement(Merge, { size: 12 }),
  },
  gradientflow: {
    label: "Gradient",
    desc: "Flowing rainbow shimmer along the bar",
    icon: React.createElement(Rainbow, { size: 12 }),
  },
  chase: {
    label: "Chase",
    desc: "Phase-locked bright runner travelling up the bar (addressable fixtures)",
    icon: React.createElement(Zap, { size: 12 }),
  },
  helix: {
    label: "Helix",
    desc: "Double-strand colour wave projected onto the bar (addressable fixtures)",
    icon: React.createElement(Waves, { size: 12 }),
  },
  plasma: {
    label: "Plasma",
    desc: "Liquid three-wave colour interference (addressable fixtures)",
    icon: React.createElement(Activity, { size: 12 }),
  },
  twinkle: {
    label: "Twinkle",
    desc: "Deterministic sparkling star field (addressable fixtures)",
    icon: React.createElement(Lightbulb, { size: 12 }),
  },
  sonicboom: {
    label: "Boom",
    desc: "Rhythmic wave expanding from the centre (addressable fixtures)",
    icon: React.createElement(Zap, { size: 12 }),
  },
  fire: {
    label: "Fire",
    desc: "Procedural flame -- pick a palette below (Vulcan/Toxic/Cryo/Cyberpunk/custom) (addressable fixtures)",
    icon: React.createElement(Flame, { size: 12 }),
  },
  bouncing: {
    label: "Bounce",
    desc: "Three balls bouncing with decaying energy (addressable fixtures)",
    icon: React.createElement(CircleDot, { size: 12 }),
  },
  drip: {
    label: "Drip",
    desc: "Droplets falling from the tip and splashing at the base (addressable fixtures)",
    icon: React.createElement(Droplet, { size: 12 }),
  },
  fireworks: {
    label: "Fireworks",
    desc: "Rockets launch and burst into fading sparks (addressable fixtures)",
    icon: React.createElement(Sparkles, { size: 12 }),
  },
  colorwaves: {
    label: "Waves",
    desc: "Multi-wave palette scan that never quite repeats (addressable fixtures)",
    icon: React.createElement(Waves, { size: 12 }),
  },
  strobeswipe: {
    label: "Swipe",
    desc: "Fast bottom-to-top fill on every beat, then decays (addressable fixtures)",
    icon: React.createElement(Zap, { size: 12 }),
  },
  vupeak: {
    label: "VU Peak",
    desc: "Continuous VU fill with a highlighted peak cap",
    icon: React.createElement(BarChart2, { size: 12 }),
  },
  geq: {
    label: "GEQ",
    desc: "Graphic-equalizer columns riding the audio spectrum",
    icon: React.createElement(BarChart2, { size: 12 }),
  },
  blurz: {
    label: "Blurz",
    desc: "Spectrum smeared into a flowing colour wash",
    icon: React.createElement(Waves, { size: 12 }),
  },
  scanner: {
    label: "Scanner",
    desc: "Larson-style bouncing point sweeps end to end with a trailing glow (addressable fixtures)",
    icon: React.createElement(ScanLine, { size: 12 }),
  },
  lightning: {
    label: "Lightning",
    desc: "Sporadic white-hot bolt strikes flicker across a jagged span (addressable fixtures)",
    icon: React.createElement(CloudLightning, { size: 12 }),
  },
  barberpole: {
    label: "Barberpole",
    desc: "Hard-edged stripes scroll continuously up the bar (addressable fixtures)",
    icon: React.createElement(Barcode, { size: 12 }),
  },
};

export function effectUsesOwnColor(
  t: EffectType,
  gradientPreset?: string,
): boolean {
  if (
    t === "fire" ||
    t === "gradientflow" ||
    t === "helix" ||
    t === "plasma" ||
    t === "colorwaves" ||
    t === "fireworks" ||
    t === "twinkle" ||
    t === "bouncing" ||
    t === "blurz"
  ) {
    return true;
  }
  if (t === "barberpole" || t === "meter") {
    return gradientPreset !== undefined && gradientPreset !== "solid";
  }
  return false;
}

export function effectSupportsGradient(t: EffectType): boolean {
  return (
    t === "fire" ||
    t === "barberpole" ||
    t === "colorwaves" ||
    t === "meter" ||
    t === "geq"
  );
}

export function effectRequiresAddressable(t: EffectType): boolean {
  return (
    t === "chase" ||
    t === "helix" ||
    t === "plasma" ||
    t === "twinkle" ||
    t === "sonicboom" ||
    t === "fire" ||
    t === "bouncing" ||
    t === "drip" ||
    t === "fireworks" ||
    t === "colorwaves" ||
    t === "strobeswipe" ||
    t === "scanner" ||
    t === "lightning" ||
    t === "barberpole"
  );
}

export const GRADIENT_META: Record<GradientPreset, string> = {
  solid: "Solid Color",
  greenYellowRed: "Green → Yellow → Red",
  vulcanFire: "Vulcan Flame",
  toxicFire: "Toxic Alien",
  cryoFire: "Cryo Ice",
  cyberpunkFire: "Cyberpunk",
  custom: "Custom palette",
};
