/**
 * LightSidePanel -- right-hand sidebar in the Timeline's Light mode.
 *
 * Contains:
 *   1. Compact 3D preview, driven by the backend-authoritative lightOutput
 *      (see WebUiState.lightOutput's doc comment) -- not a re-simulation.
 *   2. Selected track settings.
 *   3. Selected cue settings (color, audio-reactive effect, fades).
 */
import { Slider } from "@heroui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Barcode,
  BarChart2,
  CircleDot,
  CloudLightning,
  Droplet,
  Flame,
  FlipHorizontal2,
  Lightbulb,
  Link2,
  Link2Off,
  Merge,
  Minus,
  Palette,
  Plus,
  Rainbow,
  ScanLine,
  Sparkles,
  Trash2,
  TriangleAlert,
  Waves,
  X,
  Zap,
} from "lucide-react";
import { lighting } from "../../lib/api";
import type {
  BusRow,
  LightCueRow,
  LightFixtureRow,
  LightTrackRow,
  TrackRow,
  WebUiState,
} from "../../lib/types";
import type { LightCueValue } from "../../lib/lightCueInterpolation";
import { builtinPalette, parseGradientStops, type GradientStop } from "../../lib/lightCueInterpolation";
import { getLiveLedOutputs, subscribeLiveLedOutputs, type LiveLedOutput } from "../../lib/liveLevels";
import { ResoLightStage3D, type PreviewColor } from "./ResoLightStage3D";

const labelCls =
  "text-[11px] font-semibold uppercase tracking-wide text-foreground/50";
const inputCls =
  "w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-xs outline-none focus:border-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

// Shared horizontal slider -- HeroUI's own Slider compound component
// (same one MixerScreen.tsx uses for gain), not a hand-rolled <input
// type=range>. Every plain 0..1-ish slider in this panel (intensity,
// fades, effect depth/rate) goes through this one wrapper.
export function LabeledSlider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <Slider
        value={value}
        onChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
        minValue={min}
        maxValue={max}
        step={step}
        aria-label={label}
      >
        <Slider.Track className="relative h-1.5 w-full rounded-full bg-default/30">
          <Slider.Fill className="bg-accent" />
          <Slider.Thumb className="h-3.5 w-3.5 rounded-full border-2 border-accent bg-background shadow" />
        </Slider.Track>
      </Slider>
    </Field>
  );
}

// ─── HSL Color Picker ─────────────────────────────────────────────────────

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "").match(/(.{2})/g);
  if (!m || m.length < 3) return [255, 255, 255];
  return [parseInt(m[0], 16), parseInt(m[1], 16), parseInt(m[2], 16)];
}

const PRESET_COLORS: [number, number, number][] = [
  [255, 159, 10],   // amber
  [255, 214, 10],   // yellow
  [255, 55, 95],    // rose
  [191, 90, 242],   // purple
  [100, 210, 255],  // cyan
  [48, 209, 88],    // green
  [255, 69, 58],    // red
  [0, 199, 190],    // teal
  [255, 255, 255],  // white
  [0, 91, 255],     // blue
  [255, 120, 0],    // orange
  [200, 200, 200],  // cool white
];

export function HslColorPicker({
  r, g, b,
  onChange,
}: {
  r: number;
  g: number;
  b: number;
  onChange: (r: number, g: number, b: number) => void;
}) {
  const [hsl, setHsl] = useState<[number, number, number]>(() => rgbToHsl(r, g, b));
  const lastRgb = useRef<[number, number, number]>([r, g, b]);

  // Sync from outside only when not dragging
  if (lastRgb.current[0] !== r || lastRgb.current[1] !== g || lastRgb.current[2] !== b) {
    lastRgb.current = [r, g, b];
    const newHsl = rgbToHsl(r, g, b);
    if (Math.abs(newHsl[0] - hsl[0]) > 2 || Math.abs(newHsl[1] - hsl[1]) > 2 || Math.abs(newHsl[2] - hsl[2]) > 2) {
      setHsl(newHsl);
    }
  }

  const applyHsl = (newHsl: [number, number, number]) => {
    setHsl(newHsl);
    const [nr, ng, nb] = hslToRgb(...newHsl);
    lastRgb.current = [nr, ng, nb];
    onChange(nr, ng, nb);
  };

  const hex = rgbToHex(r, g, b);

  return (
    <div className="flex flex-col gap-3">
      {/* Presets swatches */}
      <div className="flex flex-wrap gap-1.5">
        {PRESET_COLORS.map(([pr, pg, pb], i) => (
          <button
            key={i}
            type="button"
            title={`rgb(${pr},${pg},${pb})`}
            onClick={() => {
              lastRgb.current = [pr, pg, pb];
              onChange(pr, pg, pb);
              setHsl(rgbToHsl(pr, pg, pb));
            }}
            className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 active:scale-95"
            style={{
              background: `rgb(${pr},${pg},${pb})`,
              borderColor: pr === r && pg === g && pb === b ? "#fff" : "transparent",
            }}
          />
        ))}
      </div>

      {/* Hex + native color picker */}
      <div className="flex items-center gap-2">
        <div
          className="h-8 w-8 shrink-0 rounded-lg border border-white/20"
          style={{ background: hex }}
        />
        <input
          type="color"
          value={hex}
          onChange={(e) => {
            const [nr, ng, nb] = hexToRgb(e.target.value);
            lastRgb.current = [nr, ng, nb];
            onChange(nr, ng, nb);
            setHsl(rgbToHsl(nr, ng, nb));
          }}
          className="h-8 w-10 cursor-pointer rounded border border-default/40 bg-transparent p-0.5"
          title="Native color picker"
        />
        <input
          type="text"
          value={hex.toUpperCase()}
          onChange={(e) => {
            if (e.target.value.match(/^#?[0-9a-fA-F]{6}$/)) {
              const clean = e.target.value.startsWith("#") ? e.target.value : "#" + e.target.value;
              const [nr, ng, nb] = hexToRgb(clean);
              lastRgb.current = [nr, ng, nb];
              onChange(nr, ng, nb);
              setHsl(rgbToHsl(nr, ng, nb));
            }
          }}
          className="flex-1 rounded-lg border border-default/60 bg-default/20 px-2 py-1 text-xs font-mono outline-none focus:border-accent uppercase"
          maxLength={7}
        />
      </div>

      {/* HSL sliders */}
      {[
        { label: "H", index: 0, max: 360, unit: "°", color: `hsl(${hsl[0]}, 100%, 50%)` },
        { label: "S", index: 1, max: 100, unit: "%", color: `hsl(${hsl[0]}, ${hsl[1]}%, 50%)` },
        { label: "L", index: 2, max: 100, unit: "%", color: `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)` },
      ].map(({ label, index, max, unit, color }) => (
        <div key={label} className="flex items-center gap-2">
          <span className="w-4 shrink-0 text-xs text-foreground/50 font-mono">{label}</span>
          <div className="relative flex-1 h-3 flex items-center">
            {/* Gradient track */}
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: index === 0
                  ? `linear-gradient(to right, hsl(0,${hsl[1]}%,${hsl[2]}%), hsl(60,${hsl[1]}%,${hsl[2]}%), hsl(120,${hsl[1]}%,${hsl[2]}%), hsl(180,${hsl[1]}%,${hsl[2]}%), hsl(240,${hsl[1]}%,${hsl[2]}%), hsl(300,${hsl[1]}%,${hsl[2]}%), hsl(360,${hsl[1]}%,${hsl[2]}%))`
                  : index === 1
                  ? `linear-gradient(to right, hsl(${hsl[0]},0%,${hsl[2]}%), hsl(${hsl[0]},100%,${hsl[2]}%))`
                  : `linear-gradient(to right, hsl(${hsl[0]},${hsl[1]}%,0%), hsl(${hsl[0]},${hsl[1]}%,50%), hsl(${hsl[0]},${hsl[1]}%,100%))`,
              }}
            />
            <input
              type="range"
              min={0}
              max={max}
              value={hsl[index]}
              onChange={(e) => {
                const next = [...hsl] as [number, number, number];
                next[index] = Number(e.target.value);
                applyHsl(next);
              }}
              className="relative w-full h-full opacity-0 cursor-pointer z-10"
            />
            {/* Thumb */}
            <div
              className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 -translate-x-1/2 rounded-full border-2 border-white shadow-md"
              style={{
                left: `${(hsl[index] / max) * 100}%`,
                background: color,
              }}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-xs font-mono text-foreground/50">
            {hsl[index]}{unit}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Visual gradient-stop editor ───────────────────────────────────────────
//
// Replaces the old raw comma-separated hex textbox (see RESTORE_POINT.md
// Feature 6). Stops are evenly spaced along the bar (the C++/TS samplers
// interpolate at `t * (n - 1)`, so a stop's position is just its index --
// drag reorders the sequence rather than storing absolute positions).
// Editing writes back the same "#RRGGBB,#RRGGBB,..." string the backend
// persists, so nothing downstream knows the editor exists.

function GradientStopEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (colors: string) => void;
}) {
  const stops = useMemo(() => parseGradientStops(value, builtinPalette("vulcanFire")), [value]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const serialize = (next: GradientStop[]) =>
    next.map((s) => rgbToHex(s.r, s.g, s.b)).join(",");

  const commit = (next: GradientStop[]) => onChange(serialize(next));

  const recolor = (i: number, hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    commit(stops.map((s, idx) => (idx === i ? { r, g, b } : s)));
  };

  const removeStop = (i: number) => {
    // The parsers require at least 2 stops (a single color isn't a
    // gradient), so the last removable stop is #2.
    if (stops.length <= 2) return;
    commit(stops.filter((_, idx) => idx !== i));
  };

  const addStop = () => {
    // Append a midpoint color between the last two stops so adding doesn't
    // shift the perceived shape of the ramp -- the new stop is blended from
    // its neighbours instead of being an arbitrary new color.
    if (stops.length < 2) return;
    const a = stops[stops.length - 2];
    const b = stops[stops.length - 1];
    const mid: GradientStop = {
      r: Math.round((a.r + b.r) / 2),
      g: Math.round((a.g + b.g) / 2),
      b: Math.round((a.b + b.b) / 2),
    };
    commit([...stops, mid]);
  };

  // Inserts a stop blended from the pair at (i, i+1) right between them --
  // addStop only ever appends at the end, which makes refining the middle
  // of a ramp (the part that usually matters most) a drag-to-reorder chore.
  const insertStopBetween = (i: number) => {
    if (stops.length >= 8) return;
    const a = stops[i];
    const b = stops[i + 1];
    const mid: GradientStop = {
      r: Math.round((a.r + b.r) / 2),
      g: Math.round((a.g + b.g) / 2),
      b: Math.round((a.b + b.b) / 2),
    };
    const next = [...stops];
    next.splice(i + 1, 0, mid);
    commit(next);
  };

  const reverseStops = () => commit([...stops].reverse());

  const handleDrop = (target: number) => {
    if (dragIndex !== null && dragIndex !== target) {
      const next = [...stops];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(target, 0, moved);
      commit(next);
    }
    setDragIndex(null);
    setOverIndex(null);
  };

  const gradientCss = stops
    .map((s) => rgbToHex(s.r, s.g, s.b))
    .map((hex, i) => `${hex} ${(i / (stops.length - 1)) * 100}%`)
    .join(", ");

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {/* Preview bar */}
      <div className="relative">
        <div
          className="h-5 w-full rounded-lg border border-default/40"
          style={{ background: `linear-gradient(to right, ${gradientCss})` }}
          aria-hidden
        />
        <button
          type="button"
          onClick={reverseStops}
          className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-default/60 bg-surface text-foreground/60 hover:bg-accent/20 hover:text-accent transition-colors"
          title="Reverse gradient direction"
          aria-label="Reverse gradient direction"
        >
          <FlipHorizontal2 size={9} />
        </button>
      </div>

      {/* Stops */}
      <div className="flex flex-wrap items-center gap-1">
        {stops.flatMap((s, i) => {
          const nodes: React.ReactNode[] = [];
          if (i > 0) {
            nodes.push(
              <button
                key={`ins-${i}`}
                type="button"
                onClick={() => insertStopBetween(i - 1)}
                disabled={stops.length >= 8}
                className="h-7 w-3 shrink-0 flex items-center justify-center rounded text-foreground/15 hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-0 disabled:pointer-events-none"
                title={stops.length >= 8 ? undefined : "Insert a stop here"}
                aria-label={`Insert a stop between ${i} and ${i + 1}`}
              >
                <Plus size={9} />
              </button>,
            );
          }
          nodes.push(
            <div
              key={i}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIndex(i);
              }}
              onDrop={() => handleDrop(i)}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={`group relative flex h-7 w-12 cursor-grab items-center justify-center overflow-visible rounded-md border text-[8px] font-medium transition-all active:cursor-grabbing ${
                overIndex === i
                  ? "border-accent ring-1 ring-accent/50"
                  : "border-default/50"
              }`}
              style={{ background: rgbToHex(s.r, s.g, s.b) }}
              title="Drag to reorder"
            >
              <input
                type="color"
                value={rgbToHex(s.r, s.g, s.b)}
                onChange={(e) => recolor(i, e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label={`Stop ${i + 1} color`}
              />
              <button
                type="button"
                onClick={() => removeStop(i)}
                disabled={stops.length <= 2}
                className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-default/60 bg-surface text-[8px] leading-none text-foreground/70 hover:bg-danger hover:text-white disabled:opacity-30 disabled:hover:bg-surface"
                title={stops.length <= 2 ? "A gradient needs at least 2 stops" : "Remove stop"}
              >
                <X size={8} />
              </button>
              <span
                className="pointer-events-none relative"
                style={{ textShadow: "0 1px 2px rgba(0,0,0,0.8)" }}
              >
                {i + 1}
              </span>
            </div>,
          );
          return nodes;
        })}

        <button
          type="button"
          onClick={addStop}
          disabled={stops.length >= 8}
          className="flex h-7 items-center gap-1 rounded-md border border-dashed border-default/50 px-2 text-[9px] text-foreground/50 hover:border-accent hover:text-accent disabled:opacity-30"
          title={stops.length >= 8 ? "Max 8 stops" : "Add a stop (blended from the last two)"}
        >
          <Plus size={10} />
          Add
        </button>
      </div>

      <div className="text-[9px] text-foreground/35">
        Stops are spread evenly. Drag to reorder, click a swatch to recolor,
        the + between stops to insert, × to remove.
      </div>
    </div>
  );
}

// Effects with a Rate control -- these are the "rhythmic" ones that make
// sense synced to song tempo. Shared between the effect grid (which decides
// whether to show the Rate/tempo-sync section at all) and the default-on
// tempo-sync behavior when a cue first picks one of these (see
// CueSettingsPanel.handleEffectType).
function effectHasRate(t: EffectType): boolean {
  return (
    t === "strobe" || t === "pulse" || t === "ripple" ||
    t === "converge" || t === "gradientflow" || t === "chase" ||
    t === "helix" || t === "plasma" || t === "twinkle" || t === "sonicboom" ||
    t === "fire" || t === "bouncing" || t === "drip" ||
    t === "fireworks" || t === "colorwaves" || t === "strobeswipe" ||
    t === "scanner" || t === "lightning" || t === "barberpole"
  );
}

// ─── Audio effect selector (props-driven — state lives in LightSidePanel) ──

type EffectType =
  | "none" | "meter" | "strobe" | "pulse" | "ripple" | "converge" | "gradientflow"
  | "chase" | "helix" | "plasma" | "twinkle" | "sonicboom"
  | "fire" | "bouncing" | "drip" | "fireworks" | "colorwaves" | "strobeswipe" | "vupeak"
  | "geq" | "blurz" | "scanner" | "lightning" | "barberpole";

const EFFECT_META: Record<EffectType, { label: string; desc: string; icon: React.ReactNode }> = {
  none:         { label: "None",     desc: "Static color, no modulation",                      icon: <Minus size={12} /> },
  meter:        { label: "Meter",    desc: "Brightness follows audio level (VU meter)",         icon: <BarChart2 size={12} /> },
  strobe:       { label: "Strobe",   desc: "Rapid on/off flashes at set rate",                   icon: <Zap size={12} /> },
  pulse:        { label: "Pulse",    desc: "Smooth brightness pulse",                            icon: <Activity size={12} /> },
  ripple:       { label: "Ripple",   desc: "Travelling wave across fixtures left→right",         icon: <Waves size={12} /> },
  converge:     { label: "Converge", desc: "Lines race in from both ends and meet at the centre", icon: <Merge size={12} /> },
  gradientflow: { label: "Gradient", desc: "Flowing rainbow shimmer along the bar", icon: <Rainbow size={12} /> },
  chase:        { label: "Chase",    desc: "Phase-locked bright runner travelling up the bar (addressable fixtures)", icon: <Zap size={12} /> },
  helix:        { label: "Helix",    desc: "Double-strand colour wave projected onto the bar (addressable fixtures)", icon: <Waves size={12} /> },
  plasma:       { label: "Plasma",   desc: "Liquid three-wave colour interference (addressable fixtures)", icon: <Activity size={12} /> },
  twinkle:      { label: "Twinkle",  desc: "Deterministic sparkling star field (addressable fixtures)", icon: <Lightbulb size={12} /> },
  sonicboom:    { label: "Boom",     desc: "Rhythmic wave expanding from the centre (addressable fixtures)", icon: <Zap size={12} /> },
  fire:         { label: "Fire",     desc: "Procedural flame -- pick a palette below (Vulcan/Toxic/Cryo/Cyberpunk/custom) (addressable fixtures)", icon: <Flame size={12} /> },
  bouncing:     { label: "Bounce",   desc: "Three balls bouncing with decaying energy (addressable fixtures)", icon: <CircleDot size={12} /> },
  drip:         { label: "Drip",     desc: "Droplets falling from the tip and splashing at the base (addressable fixtures)", icon: <Droplet size={12} /> },
  fireworks:    { label: "Fireworks", desc: "Rockets launch and burst into fading sparks (addressable fixtures)", icon: <Sparkles size={12} /> },
  colorwaves:   { label: "Waves",    desc: "Multi-wave palette scan that never quite repeats (addressable fixtures)", icon: <Waves size={12} /> },
  strobeswipe:  { label: "Swipe",    desc: "Fast bottom-to-top fill on every beat, then decays (addressable fixtures)", icon: <Zap size={12} /> },
  vupeak:       { label: "VU Peak",  desc: "Continuous VU fill with a highlighted peak cap", icon: <BarChart2 size={12} /> },
  geq:          { label: "GEQ",      desc: "Graphic-equalizer columns riding the audio spectrum", icon: <BarChart2 size={12} /> },
  blurz:        { label: "Blurz",    desc: "Spectrum smeared into a flowing colour wash", icon: <Waves size={12} /> },
  scanner:      { label: "Scanner",  desc: "Larson-style bouncing point sweeps end to end with a trailing glow (addressable fixtures)", icon: <ScanLine size={12} /> },
  lightning:    { label: "Lightning", desc: "Sporadic white-hot bolt strikes flicker across a jagged span (addressable fixtures)", icon: <CloudLightning size={12} /> },
  barberpole:   { label: "Barberpole", desc: "Hard-edged stripes scroll continuously up the bar (addressable fixtures)", icon: <Barcode size={12} /> },
};

// Effects whose per-LED shape (addressableEffectLedColor in
// LightCueInterpolation.h) is the whole point -- on a non-addressable
// fixture, applyEffect's fallback for every one of these is the *static*
// `level = p.intensity` case (no time modulation at all), so picking one
// on a plain bar silently does nothing. Converge/GradientFlow/VuPeak/
// Geq/Blurz are NOT in this set: their non-addressable fallback still
// computes a real, animated/audio-reactive level, just without the
// per-LED spatial pattern -- so they stay genuinely useful either way.
function effectRequiresAddressable(t: EffectType): boolean {
  return (
    t === "chase" || t === "helix" || t === "plasma" || t === "twinkle" ||
    t === "sonicboom" || t === "fire" || t === "bouncing" || t === "drip" ||
    t === "fireworks" || t === "colorwaves" || t === "strobeswipe" ||
    t === "scanner" || t === "lightning" || t === "barberpole"
  );
}

// ─── Tempo subdivisions ───────────────────────────────────────────────────

const SUBDIVISIONS = [
  "2", "1", "1/2", "1/3", "1/4", "1/6", "1/8", "1/16", "1/32", "1/64",
] as const;
type TempoSubdiv = typeof SUBDIVISIONS[number];

type SourceType = "bus" | "track";
type GradientPreset = "solid" | "greenYellowRed" | "custom" | "vulcanFire" | "toxicFire" | "cryoFire" | "cyberpunkFire";

const GRADIENT_META: Record<GradientPreset, string> = {
  solid: "Solid Color",
  greenYellowRed: "Green → Yellow → Red",
  vulcanFire: "Vulcan Flame",
  toxicFire: "Toxic Alien",
  cryoFire: "Cryo Ice",
  cyberpunkFire: "Cyberpunk",
  custom: "Custom palette",
};

type BlendModeUi = "normal" | "additive" | "multiply" | "difference" | "lighten" | "subtractive";
const BLEND_META: Record<BlendModeUi, string> = {
  normal: "Normal (replace)",
  additive: "Additive",
  multiply: "Multiply",
  difference: "Difference",
  lighten: "Lighten",
  subtractive: "Subtractive",
};

function EffectPanel({
  effectType, effectSourceType, effectSourceId, effectIntensity, effectRate,
  tempoSync, tempoSubdiv, gradientPreset, gradientColors, blendMode, showGradient,
  hasAddressableFixture,
  onType, onSourceType, onSourceId, onIntensity, onRate, onTempoSync, onTempoSubdiv,
  onGradientPreset, onGradientColors, onBlendMode,
  busses, tracks, bpm,
}: {
  effectType: EffectType;
  effectSourceType: SourceType;
  effectSourceId: string;
  effectIntensity: number;
  effectRate: number;
  tempoSync: boolean;
  tempoSubdiv: TempoSubdiv;
  gradientPreset: GradientPreset;
  gradientColors: string;
  blendMode: BlendModeUi;
  /** Only meaningful (and only shown) when the effect is Meter and at least
   * one assigned fixture is addressable -- a non-addressable bar has no
   * per-LED concept for a gradient to apply to. */
  showGradient: boolean;
  /** Whether the track/cue's assigned fixtures include an addressable one --
   * gates which effect *options* are even offered (see
   * effectRequiresAddressable): no point showing an effect that renders as
   * a flat, unmodulated color on the fixtures actually assigned. */
  hasAddressableFixture: boolean;
  onType: (t: EffectType) => void;
  onSourceType: (t: SourceType) => void;
  onSourceId: (id: string) => void;
  onIntensity: (v: number) => void;
  onRate: (v: number) => void;
  onTempoSync: (v: boolean) => void;
  onTempoSubdiv: (v: TempoSubdiv) => void;
  onGradientPreset: (g: GradientPreset) => void;
  onGradientColors: (colors: string) => void;
  onBlendMode: (b: BlendModeUi) => void;
  busses: BusRow[];
  tracks: TrackRow[];
  bpm: number;
}) {
  const hasRate = effectHasRate(effectType);
  const sourceItems = effectSourceType === "track" ? tracks : busses;
  return (
    <div className="flex flex-col gap-3">
      <Field label="Audio Effect">
        <div className="grid grid-cols-4 gap-1">
          {([
            "none", "meter", "strobe", "pulse", "ripple", "converge", "gradientflow",
            "chase", "helix", "plasma", "twinkle", "sonicboom",
            "fire", "bouncing", "drip", "fireworks", "colorwaves", "strobeswipe", "vupeak",
            "geq", "blurz", "scanner", "lightning", "barberpole",
          ] as EffectType[])
            // Hide addressable-only effects once no assigned fixture can
            // actually render their pattern -- except the one already
            // active, so switching fixture assignment never strands the
            // cue on a selection that silently vanishes from the grid.
            .filter((et) => hasAddressableFixture || et === effectType || !effectRequiresAddressable(et))
            .map((et) => {
            const meta = EFFECT_META[et];
            return (
              <button
                key={et}
                type="button"
                title={meta.desc}
                onClick={() => onType(et)}
                className={`flex flex-col items-center gap-0.5 rounded-lg border py-1.5 px-1 text-[10px] font-medium transition-colors ${
                  effectType === et
                    ? "border-accent bg-accent/20 text-accent"
                    : "border-default/40 bg-default/10 text-foreground/60 hover:bg-default/20"
                }`}
              >
                {meta.icon}
                <span>{meta.label}</span>
              </button>
            );
          })}
        </div>
        {effectType !== "none" && (
          <div className="mt-1 text-[10px] text-foreground/40 italic">
            {EFFECT_META[effectType].desc}
          </div>
        )}
      </Field>

      {effectType !== "none" && (
        <>
          <Field label="Audio Source">
            <div className="flex gap-1.5">
              <select
                className="w-24 shrink-0 rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-xs outline-none focus:border-accent"
                value={effectSourceType}
                onChange={(e) => {
                  const t = e.target.value as SourceType;
                  onSourceType(t);
                  // Switching pools invalidates whatever id was picked from
                  // the other one -- reset to "master mix" (bus) / nothing
                  // selected (track) rather than silently keeping a stale id.
                  onSourceId("");
                }}
              >
                <option value="bus">Bus</option>
                <option value="track">Track</option>
              </select>
              <select
                className="flex-1 rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-xs outline-none focus:border-accent"
                value={effectSourceId}
                onChange={(e) => onSourceId(e.target.value)}
              >
                {effectSourceType === "bus" && <option value="">— Master mix</option>}
                {sourceItems.map((item) => {
                  const db = item.peakDb ?? -100;
                  const dbStr = db > -100 ? `${db.toFixed(1)} dB` : "silence";
                  return (
                    <option key={item.id} value={item.id}>
                      {item.name} · {dbStr}
                    </option>
                  );
                })}
              </select>
            </div>
          </Field>

          {showGradient && (
            <Field label="Gradient">
              <div className="grid grid-cols-2 gap-1.5">
                {(Object.keys(GRADIENT_META) as GradientPreset[]).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => onGradientPreset(g)}
                    className={`rounded-lg border px-2 py-1.5 text-[10px] font-medium transition-colors ${
                      gradientPreset === g
                        ? "border-accent bg-accent/20 text-accent"
                        : "border-default/40 bg-default/10 text-foreground/60 hover:bg-default/20"
                    }`}
                  >
                    {GRADIENT_META[g]}
                  </button>
                ))}
              </div>
              {gradientPreset === "custom" && (
                <GradientStopEditor value={gradientColors} onChange={onGradientColors} />
              )}
            </Field>
          )}

          <LabeledSlider
            label={`Depth: ${Math.round(effectIntensity * 100)}%`}
            value={effectIntensity}
            onChange={onIntensity}
            step={0.05}
          />

          <Field label="Layer Blend">
            <select
              className="w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-xs outline-none focus:border-accent"
              value={blendMode}
              onChange={(e) => onBlendMode(e.target.value as BlendModeUi)}
            >
              {(Object.keys(BLEND_META) as BlendModeUi[]).map((b) => (
                <option key={b} value={b}>{BLEND_META[b]}</option>
              ))}
            </select>
            <div className="mt-1 text-[10px] text-foreground/40 italic">
              Only matters if another track's cue is active on the same fixture at the same time (base + accent layers).
            </div>
          </Field>

          {hasRate && (
            <div className="flex flex-col gap-2">
              {/* Tempo sync toggle */}
              <div className="flex items-center justify-between">
                <span className={labelCls}>Rate</span>
                <button
                  type="button"
                  onClick={() => onTempoSync(!tempoSync)}
                  title={tempoSync ? `Synced to tempo (${bpm.toFixed(0)} BPM)` : "Free rate — click to sync to tempo"}
                  className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    tempoSync
                      ? "bg-accent/20 text-accent border border-accent/40"
                      : "bg-default/10 text-foreground/40 border border-default/30 hover:text-foreground/70"
                  }`}
                >
                  {tempoSync ? <Link2 size={10} /> : <Link2Off size={10} />}
                  <span>{tempoSync ? `♩${bpm.toFixed(0)}` : "Free"}</span>
                </button>
              </div>

              {tempoSync ? (
                // Subdivision grid
                <div className="grid grid-cols-5 gap-1">
                  {SUBDIVISIONS.map((sub) => (
                    <button
                      key={sub}
                      type="button"
                      onClick={() => onTempoSubdiv(sub)}
                      className={`rounded py-1 text-[9px] font-mono font-medium border transition-colors ${
                        tempoSubdiv === sub
                          ? "border-accent bg-accent/20 text-accent"
                          : "border-default/30 bg-default/10 text-foreground/50 hover:bg-default/20"
                      }`}
                    >
                      {sub}
                    </button>
                  ))}
                </div>
              ) : (
                <Slider
                  value={effectRate}
                  onChange={(v) => onRate(Array.isArray(v) ? v[0] : v)}
                  minValue={0.1}
                  maxValue={20}
                  step={0.1}
                  aria-label="Effect rate (Hz)"
                >
                  <Slider.Track className="relative h-1.5 w-full rounded-full bg-default/30">
                    <Slider.Fill className="bg-accent" />
                    <Slider.Thumb className="h-3.5 w-3.5 rounded-full border-2 border-accent bg-background shadow" />
                  </Slider.Track>
                </Slider>
              )}
              <div className="text-[10px] text-foreground/35 text-right">
                {tempoSync
                  ? `= ${(bpm / 60 / ({
                      "2": 8, "1": 4, "1/2": 2, "1/3": 4/3, "1/4": 1,
                      "1/6": 2/3, "1/8": 0.5, "1/16": 0.25, "1/32": 0.125, "1/64": 0.0625,
                    }[tempoSubdiv] ?? 1)).toFixed(2)} Hz`
                  : `${effectRate.toFixed(1)} Hz`}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}


// ─── Track Settings panel ─────────────────────────────────────────────────

function TrackSettingsPanel({
  track,
  index,
  fixtures,
  onRequestClose,
}: {
  track: LightTrackRow;
  index: number;
  fixtures: LightFixtureRow[];
  onRequestClose?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className={labelCls}>Track: {track.name}</span>
        {onRequestClose && (
          <button
            type="button"
            onClick={onRequestClose}
            className="rounded p-0.5 text-foreground/40 hover:text-foreground transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <Field label="Name">
        <input
          type="text"
          value={track.name}
          placeholder="Light track name"
          className={inputCls}
          onChange={(e) =>
            void lighting.trackUpdate({ index, name: e.target.value })
          }
        />
      </Field>

      {fixtures.length > 0 && track.fixtureIds.length === 0 && (
        <div className="flex items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[10px] text-warning">
          <TriangleAlert size={12} className="shrink-0" />
          No fixtures checked below -- cues on this track won&apos;t drive anything yet.
        </div>
      )}

      <Field label="Assigned Fixtures">
        <div className="flex flex-col gap-1">
          {fixtures.length === 0 ? (
            <div className="text-[10px] text-foreground/40 italic">
              No fixtures — add bars in Settings → Light first.
            </div>
          ) : (
            fixtures.map((f) => (
              <label
                key={f.id}
                className="flex items-center gap-2 py-0.5 text-xs text-foreground/70 cursor-pointer hover:text-foreground"
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={track.fixtureIds.includes(f.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...track.fixtureIds, f.id]
                      : track.fixtureIds.filter((id) => id !== f.id);
                    void lighting.trackUpdate({ index, fixtureIds: next });
                  }}
                />
                <span className="truncate">{f.name}</span>
              </label>
            ))
          )}
        </div>
      </Field>

      <button
        type="button"
        onClick={() => {
          void lighting.trackRemove(index);
          onRequestClose?.();
        }}
        className="self-start flex items-center gap-1.5 rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/20 transition-colors"
      >
        <Trash2 size={11} />
        Remove Track
      </button>
    </div>
  );
}

// ─── Cue Settings panel ───────────────────────────────────────────────────

function CueSettingsPanel({
  cue, songIndex, busses, tracks, bpm, hasAddressableFixture,
  effectType, effectSourceType, effectSourceId, effectIntensity, effectRate,
  tempoSync, tempoSubdiv, gradientPreset, gradientColors, blendMode,
  onEffectType, onEffectSourceType, onEffectSourceId, onEffectIntensity, onEffectRate,
  onTempoSync, onTempoSubdiv, onGradientPreset, onGradientColors, onBlendMode,
}: {
  cue: LightCueRow;
  songIndex: number;
  busses: BusRow[];
  tracks: TrackRow[];
  bpm: number;
  hasAddressableFixture: boolean;
  effectType: EffectType;
  effectSourceType: SourceType;
  effectSourceId: string;
  effectIntensity: number;
  effectRate: number;
  tempoSync: boolean;
  tempoSubdiv: TempoSubdiv;
  gradientPreset: GradientPreset;
  gradientColors: string;
  blendMode: BlendModeUi;
  onEffectType: (t: EffectType) => void;
  onEffectSourceType: (t: SourceType) => void;
  onEffectSourceId: (id: string) => void;
  onEffectIntensity: (v: number) => void;
  onEffectRate: (v: number) => void;
  onTempoSync: (v: boolean) => void;
  onTempoSubdiv: (v: TempoSubdiv) => void;
  onGradientPreset: (g: GradientPreset) => void;
  onGradientColors: (colors: string) => void;
  onBlendMode: (b: BlendModeUi) => void;
}) {
  const update = (patch: Omit<Parameters<typeof lighting.cueUpdate>[0], "songIndex" | "cueId">) =>
    void lighting.cueUpdate({ songIndex, cueId: cue.id, ...patch });

  // Persist effect changes to the backend immediately.
  const handleEffectType = (t: EffectType) => {
    onEffectType(t);
    // Rhythmic effects (anything with a Rate control) default to tempo
    // sync -- only when *newly* turning an effect on (previous type was
    // "none"), so flipping between two rhythmic effects never silently
    // re-syncs a rate the user deliberately freed from tempo.
    const nextTempoSync = effectType === "none" && effectHasRate(t) ? true : tempoSync;
    if (nextTempoSync !== tempoSync) onTempoSync(nextTempoSync);
    update({
      effectType: t, effectSourceType, effectSourceId, effectIntensity,
      tempoSync: nextTempoSync, tempoSubdiv, effectRateHz: effectRate, gradientPreset, gradientColors, blendMode,
    });
  };
  const handleEffectSourceType = (t: SourceType) => {
    onEffectSourceType(t);
    update({ effectSourceType: t });
  };
  const handleEffectSourceId = (id: string) => {
    onEffectSourceId(id);
    update({ effectSourceId: id });
  };
  const handleEffectIntensity = (v: number) => {
    onEffectIntensity(v);
    update({ effectIntensity: v });
  };
  const handleEffectRate = (v: number) => {
    onEffectRate(v);
    update({ effectRateHz: v });
  };
  const handleTempoSync = (v: boolean) => {
    onTempoSync(v);
    update({ tempoSync: v, tempoSubdiv });
  };
  const handleTempoSubdiv = (v: TempoSubdiv) => {
    onTempoSubdiv(v);
    update({ tempoSync: true, tempoSubdiv: v });
  };
  const handleGradientPreset = (g: GradientPreset) => {
    onGradientPreset(g);
    update({ gradientPreset: g });
  };
  const handleGradientColors = (colors: string) => {
    onGradientColors(colors);
    update({ gradientColors: colors });
  };
  const handleBlendMode = (b: BlendModeUi) => {
    onBlendMode(b);
    update({ blendMode: b });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className={labelCls + " mb-2"}>Color</div>
        <HslColorPicker
          r={cue.colorR} g={cue.colorG} b={cue.colorB}
          onChange={(r, g, b) => update({ colorR: r, colorG: g, colorB: b })}
        />
      </div>

      <Field label="Label">
        <input type="text" value={cue.label} placeholder="Cue label (optional)"
          className={inputCls} onChange={(e) => update({ label: e.target.value })} />
      </Field>

      <LabeledSlider
        label={`Intensity: ${Math.round(cue.intensity * 100)}%`}
        value={cue.intensity}
        onChange={(v) => update({ intensity: v })}
      />

      <div className="grid grid-cols-2 gap-3">
        <LabeledSlider
          label={`Fade In: ${cue.fadeInSeconds.toFixed(1)}s`}
          value={cue.fadeInSeconds}
          onChange={(v) => update({ fadeInSeconds: v })}
          max={Math.min(cue.durationSeconds / 2, 10)}
          step={0.1}
        />
        <LabeledSlider
          label={`Fade Out: ${cue.fadeOutSeconds.toFixed(1)}s`}
          value={cue.fadeOutSeconds}
          onChange={(v) => update({ fadeOutSeconds: v })}
          max={Math.min(cue.durationSeconds / 2, 10)}
          step={0.1}
        />
      </div>

      <div className="border-t border-default/20 pt-3">
        <EffectPanel
          effectType={effectType} effectSourceType={effectSourceType} effectSourceId={effectSourceId}
          effectIntensity={effectIntensity} effectRate={effectRate}
          tempoSync={tempoSync} tempoSubdiv={tempoSubdiv}
          gradientPreset={gradientPreset}
          gradientColors={gradientColors}
          blendMode={blendMode}
          showGradient={effectType !== "none" && hasAddressableFixture}
          hasAddressableFixture={hasAddressableFixture}
          onType={handleEffectType} onSourceType={handleEffectSourceType} onSourceId={handleEffectSourceId}
          onIntensity={handleEffectIntensity} onRate={handleEffectRate}
          onTempoSync={handleTempoSync} onTempoSubdiv={handleTempoSubdiv}
          onGradientPreset={handleGradientPreset} onGradientColors={handleGradientColors}
          onBlendMode={handleBlendMode}
          busses={busses} tracks={tracks} bpm={bpm}
        />
      </div>
    </div>
  );
}

// ─── Main LightSidePanel ──────────────────────────────────────────────────

export type LightSidePanelSelection =
  | {
      type: "track";
      trackIndex: number;
      track: LightTrackRow;
    }
  | {
      type: "cue";
      songIndex: number;
      cue: LightCueRow;
      trackIndex: number;
      track: LightTrackRow;
    };

export function LightSidePanel({
  state,
  selection,
  fixtures,
  previewColors,
  onClearSelection,
}: {
  state: WebUiState;
  selection: LightSidePanelSelection | null;
  fixtures: LightFixtureRow[];
  previewColors: Record<string, LightCueValue>;
  onClearSelection: () => void;
}) {
  // ── Effect editor state, seeded from the selected cue's real (persisted)
  // values -- not hardcoded defaults, since state.lightCues now actually
  // carries them (see RESTORE_POINT.md Feature 6's sync fix). ──
  const [effectType, setEffectType] = useState<EffectType>("none");
  const [effectSourceType, setEffectSourceType] = useState<SourceType>("bus");
  const [effectSourceId, setEffectSourceId] = useState("");
  const [effectIntensity, setEffectIntensity] = useState(0.8);
  const [effectRate, setEffectRate] = useState(2);
  const [tempoSync, setTempoSync] = useState(false);
  const [tempoSubdiv, setTempoSubdiv] = useState<TempoSubdiv>("1/4");
  const [gradientPreset, setGradientPreset] = useState<GradientPreset>("solid");
  const [gradientColors, setGradientColors] = useState("");
  const [blendMode, setBlendMode] = useState<BlendModeUi>("normal");

  // BPM for the currently active song
  const currentSongIdx = selection?.type === "cue" ? selection.songIndex : 0;
  const currentBpm = state.songs[currentSongIdx]?.bpm ?? 120;

  // Re-seed the editor fields whenever the selected cue changes.
  const prevCueId = useRef<string | null>(null);
  const currentCueId = selection?.type === "cue" ? selection.cue.id : null;
  if (prevCueId.current !== currentCueId) {
    prevCueId.current = currentCueId;
    const cue = selection?.type === "cue" ? selection.cue : null;
    setEffectType((cue?.effectType || "none") as EffectType);
    setEffectSourceType((cue?.effectSourceType || "bus") as SourceType);
    setEffectSourceId(cue?.effectSourceId ?? "");
    setEffectIntensity(cue?.effectIntensity ?? 0.8);
    setEffectRate(cue?.effectRateHz ?? 2);
    setTempoSync(cue?.tempoSync ?? false);
    setTempoSubdiv((cue?.tempoSubdiv || "1/4") as TempoSubdiv);
    setGradientPreset((cue?.gradientPreset || "solid") as GradientPreset);
    setGradientColors(cue?.gradientColors ?? "");
    setBlendMode(((cue?.blendMode as BlendModeUi) || "normal") as BlendModeUi);
  }

  const hasAddressableFixture =
    selection?.type === "cue" || selection?.type === "track"
      ? fixtures.some((f) => selection.track.fixtureIds.includes(f.id) && f.addressable)
      : false;

  // Backend-rendered per-LED state from the binary websocket stream (see
  // liveLevels.ts) -- the preview draws these colors as-is, never
  // re-simulating an effect. Fixtures with no live row (idle, or the song
  // isn't playing) fall back to the editor `previewColors` (cue color /
  // black).
  const [liveLedOutputs, setLiveLedOutputs] = useState<LiveLedOutput[]>([]);
  useEffect(
    () =>
      subscribeLiveLedOutputs(() =>
        setLiveLedOutputs(getLiveLedOutputs()),
      ),
    [],
  );

  const displayColors = useMemo(() => {
    const merged: Record<string, PreviewColor> = { ...previewColors };
    for (const lo of liveLedOutputs) {
      const fixture = fixtures[lo.fixtureIdx];
      if (!fixture) continue;
      merged[fixture.id] = {
        r: 0,
        g: 0,
        b: 0,
        intensity: 1,
        ledColors: lo.ledColors,
      };
    }
    return merged;
  }, [previewColors, liveLedOutputs, fixtures]);

  return (
    <div
      className="flex flex-col shrink-0 border-l border-default/30 bg-surface/30 overflow-hidden"
      style={{ width: 288 }}
    >
      {/* 3D Preview — shows modulated colors when an effect is active */}
      <div
        className="shrink-0 border-b border-default/20 bg-background"
        style={{ height: 200 }}
        onWheel={(e) => e.stopPropagation()}
      >
        <ResoLightStage3D
          mode="preview"
          fixtures={fixtures}
          previewColors={displayColors}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {!selection && (
          <div className="flex flex-col items-center justify-center flex-1 gap-2 text-foreground/30 text-xs text-center py-8">
            <Lightbulb size={28} strokeWidth={1} />
            <span>Click a track header or cue block to edit it</span>
          </div>
        )}

        {selection?.type === "cue" && (
          <>
            <div className="rounded-xl border border-default/30 bg-default/10 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Palette size={13} className="shrink-0 text-foreground/50" />
                  <span className="text-xs font-semibold text-foreground/80 truncate">
                    {selection.cue.label || selection.cue.id.slice(0, 8)}
                  </span>
                </div>
                <button type="button" onClick={onClearSelection}
                  className="shrink-0 rounded p-0.5 text-foreground/40 hover:text-foreground transition-colors">
                  <X size={13} />
                </button>
              </div>
              <CueSettingsPanel
                cue={selection.cue}
                songIndex={selection.songIndex}
                busses={state.busses}
                tracks={state.tracks}
                bpm={currentBpm}
                hasAddressableFixture={hasAddressableFixture}
                effectType={effectType}
                effectSourceType={effectSourceType}
                effectSourceId={effectSourceId}
                effectIntensity={effectIntensity}
                effectRate={effectRate}
                tempoSync={tempoSync}
                tempoSubdiv={tempoSubdiv}
                gradientPreset={gradientPreset}
                gradientColors={gradientColors}
                blendMode={blendMode}
                onEffectType={setEffectType}
                onEffectSourceType={setEffectSourceType}
                onEffectSourceId={setEffectSourceId}
                onEffectIntensity={setEffectIntensity}
                onEffectRate={setEffectRate}
                onTempoSync={setTempoSync}
                onTempoSubdiv={setTempoSubdiv}
                onGradientPreset={setGradientPreset}
                onGradientColors={setGradientColors}
                onBlendMode={setBlendMode}
              />
            </div>

            <div className="rounded-xl border border-default/20 bg-default/5 p-3">
              <TrackSettingsPanel
                track={selection.track}
                index={selection.trackIndex}
                fixtures={fixtures}
              />
            </div>
          </>
        )}

        {selection?.type === "track" && (
          <div className="rounded-xl border border-default/30 bg-default/10 p-3">
            <TrackSettingsPanel
              track={selection.track}
              index={selection.trackIndex}
              fixtures={fixtures}
              onRequestClose={onClearSelection}
            />
          </div>
        )}
      </div>
    </div>
  );
}
