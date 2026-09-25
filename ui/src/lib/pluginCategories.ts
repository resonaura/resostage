import {
  AudioLines,
  Cable,
  Clock,
  FolderTree,
  Gauge,
  Layers,
  LayoutGrid,
  MoveHorizontal,
  Orbit,
  Piano,
  ShieldAlert,
  SlidersVertical,
  Sparkles,
  TrendingUp,
  Waves,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

export const CATEGORY_HINTS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "Dynamics",
    /comp\b|\bcomp|pressor|compress|limit|gate|expander|dynamic|transient|de.?ess|leveler|slam|maximiz|pro.?c|pro.?g|pro.?l|pro.?ds|pro.?mb|fetish|fetsnap|diode.?609|fet.?76|vca.?65/i,
  ],
  [
    "EQ",
    /eq\b|\beq|equaliz|filter|shelf|bandpass|hi.?pass|low.?pass|pro.?q|volcano|bchannel|channel|simplon/i,
  ],
  [
    "Reverb",
    /reverb|room|plate|hall|space|spring|chamber|ambience|\brev\b|pro.?r|crystallin|magic dice/i,
  ],
  ["Delay", /delay|echo|timeless|comeback/i],
  [
    "Modulation",
    /chorus|flang|phaser|tremolo|vibrato|rotary|modulat|shaperbox|magic switch/i,
  ],
  ["Pitch", /pitch|tune|vocal|formant|transpose|humanoid|autotune|quickvox/i],
  [
    "Distortion",
    /distort|saturat|overdrive|clip|crusher|amp|drive|fuzz|tube|prebox|preamp|warmth|fatten|saturn|exciter|mello.?fi|vhs|tape|\bpre\b|coldfire/i,
  ],
  ["Spatial", /stereo|image|spatial|surround|panner|binaural|pan\b|dearvr/i],
  [
    "Utility",
    /utility|gain|trim|tool|mixer|send|receive|generator|meter|analy[sz]|scope|loudness|spectrum|repair|restore|de.?noise|tuner|insight|patchwork/i,
  ],
];

/**
 * Normalizes plugin category into standard DAW categories.
 * Works with explicit JUCE category paths (e.g. `Fx|Dynamics`, `Fx|EQ`)
 * as well as vendor fallbacks (like Apple AudioUnit `Effect`).
 */
export function displayCategory(plugin: {
  name: string;
  category?: string;
  instrument?: boolean;
}): string {
  if (plugin.instrument) return "Instrument";

  const rawCategory = plugin.category || "";
  const parts = rawCategory
    .split(/[|/>\\]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^(fx|effect|effects)$/i.test(part));
  const explicit = parts.at(-1);
  if (explicit) {
    if (/eq|equaliz|filter|shelf|bandpass/i.test(explicit)) return "EQ";
    if (/dynamic|compress|limit|gate|expander|transient|de.?ess/i.test(explicit))
      return "Dynamics";
    if (/reverb|room|hall|plate|spring|space/i.test(explicit)) return "Reverb";
    if (/delay|echo/i.test(explicit)) return "Delay";
    if (
      /modulation|chorus|flang|phaser|tremolo|vibrato|rotary/i.test(explicit)
    )
      return "Modulation";
    if (/distort|overdrive|saturat|clip|amp|fuzz/i.test(explicit))
      return "Distortion";
    if (/pitch/i.test(explicit)) return "Pitch";
    if (/spatial|stereo|panner|imaging|ambisonic|surround/i.test(explicit))
      return "Spatial";
    if (
      /tool|utility|analyzer|meter|restoration|mastering|mixer|generator/i.test(
        explicit,
      )
    )
      return "Utility";
  }

  const searchable = `${plugin.name} ${rawCategory}`;
  for (const [cat, pattern] of CATEGORY_HINTS) {
    if (pattern.test(searchable)) return cat;
  }

  return explicit || "Other";
}

export interface CategoryFilterDef {
  id: string;
  label: string;
  icon: LucideIcon;
}

export const GLOBAL_CATEGORIES: ReadonlyArray<CategoryFilterDef> = [
  { id: "all", label: "All Categories", icon: Layers },
  { id: "eq", label: "EQ", icon: SlidersVertical },
  { id: "dynamics", label: "Dynamics", icon: Gauge },
  { id: "reverb", label: "Reverb", icon: Waves },
  { id: "delay", label: "Delay", icon: Clock },
  { id: "modulation", label: "Modulation", icon: Orbit },
  { id: "distortion", label: "Distortion", icon: Zap },
  { id: "pitch", label: "Pitch", icon: TrendingUp },
  { id: "spatial", label: "Spatial", icon: MoveHorizontal },
  { id: "utility", label: "Utility", icon: Wrench },
  { id: "other", label: "Other", icon: FolderTree },
];

export interface ScopeFilterDef {
  id: "all" | "effects" | "instruments" | "multi-io" | "new" | "quarantined";
  label: string;
  icon: LucideIcon;
  tone?: "accent-soft" | "warning-soft" | "danger-soft";
}

export const SCOPE_FILTERS: ReadonlyArray<ScopeFilterDef> = [
  { id: "all", label: "All", icon: LayoutGrid },
  { id: "effects", label: "Effects", icon: AudioLines },
  { id: "instruments", label: "Instruments", icon: Piano },
  { id: "multi-io", label: "Multi-I/O", icon: Cable },
  { id: "new", label: "New", icon: Sparkles, tone: "warning-soft" },
  { id: "quarantined", label: "Quarantined", icon: ShieldAlert, tone: "danger-soft" },
];

/**
 * Normalizes plug-in format name for display across the application.
 * E.g. "AudioUnit" -> "AU".
 */
export function displayFormat(format: string): string {
  if (format === "AudioUnit") return "AU";
  return format;
}

/**
 * Priority rank for format selection when deduplicating.
 * Lower number = higher priority.
 * Prefers AU on macOS (AU > VST3 > VST > LV2 > others).
 */
function formatRank(format: string): number {
  const f = format.toLowerCase();
  if (f === "audiounit" || f === "au") return 1;
  if (f === "vst3") return 2;
  if (f === "vst" || f === "vst2") return 3;
  if (f === "lv2") return 4;
  if (f === "ladspa") return 5;
  return 6;
}

/**
 * Intelligently deduplicates plug-ins by name + manufacturer, choosing the
 * best format variant (preferring AU over VST3 on macOS, etc.).
 */
export function deduplicatePlugins<
  T extends { name: string; manufacturer?: string; format: string },
>(plugins: T[]): T[] {
  const chosen = new Map<string, T>();
  for (const plugin of plugins) {
    const key = `${(plugin.manufacturer || "").trim().toLowerCase()}\0${plugin.name.trim().toLowerCase()}`;
    const existing = chosen.get(key);
    if (!existing) {
      chosen.set(key, plugin);
      continue;
    }
    if (formatRank(plugin.format) < formatRank(existing.format)) {
      chosen.set(key, plugin);
    }
  }
  return Array.from(chosen.values());
}
