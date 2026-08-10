import { addRafTask, setRafFrameRateCap } from "./rafLoop";

/**
 * How hard the UI is allowed to work.
 *
 * A stage machine is not a workstation: it may be a fanless laptop in a rack,
 * on battery, driving a projector, five years old. The app's job there is to
 * be reliable, not smooth -- a meter at 20fps that never stutters the audio is
 * strictly better than one at 60fps that does.
 *
 * Everything here is about the UI thread only. It cannot and must not touch
 * the audio path, which runs on its own real-time thread and is never traded
 * away for a nicer picture.
 */

export type PerformanceTier = "full" | "balanced" | "reduced" | "economy";

/**
 * Frames per second each tier lets the shared rAF driver do work at.
 *
 * 45 rather than a rounder 40 or 44: on a 60Hz panel it is exactly three
 * quarters of the refresh, which the driver's accumulator spends as a steady
 * 1,1,1,2 frame pattern. 44 would be a ragged pattern for a 2% saving over 45,
 * and 40 on 60Hz drops to a 1,2,1,2 that reads as judder rather than as a
 * slightly lower frame rate. See the note in rafLoop's frame().
 *
 * The steps below it halve each time, which is what a display can actually
 * deliver evenly and what makes each step feel like a real change.
 */
export const TIER_FPS: Record<PerformanceTier, number> = {
  full: 0, // uncapped -- whatever the display offers
  balanced: 45,
  reduced: 30,
  economy: 15,
};

export const TIER_LABEL: Record<PerformanceTier, string> = {
  full: "Full",
  balanced: "Balanced",
  reduced: "Reduced",
  economy: "Economy",
};

export const TIER_DESCRIPTION: Record<PerformanceTier, string> = {
  full: "Every frame the display offers.",
  balanced: "45 fps. A quarter less work, still smooth to the eye.",
  reduced: "30 fps. Halves the cost of every meter and animation at once.",
  economy: "15 fps. For old or heavily loaded machines.",
};

export interface PerformanceSettings {
  /** What the user picked. Auto may run BELOW this, never above it. */
  tier: PerformanceTier;
  /** Let the app drop a tier by itself when the machine is struggling. */
  auto: boolean;
}

export const DEFAULT_PERFORMANCE: PerformanceSettings = {
  tier: "full",
  auto: true,
};

const STORAGE_KEY = "resostage.performance";

export function readPerformanceSettings(): PerformanceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PERFORMANCE;
    const parsed = JSON.parse(raw) as Partial<PerformanceSettings>;
    const tier =
      parsed.tier && parsed.tier in TIER_FPS
        ? (parsed.tier as PerformanceTier)
        : DEFAULT_PERFORMANCE.tier;
    return { tier, auto: parsed.auto ?? DEFAULT_PERFORMANCE.auto };
  } catch {
    return DEFAULT_PERFORMANCE; // private mode / corrupt value
  }
}

export function writePerformanceSettings(s: PerformanceSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* best-effort */
  }
}

// ── Auto: noticing that the machine is struggling ────────────────────────
//
// Frame timing is the symptom every cause shows up in, so it is what the
// decision is made on -- a busy CPU, a thermally throttled SSD and a browser
// choking on GC all look the same from here, which is the point: the fix is
// the same too. The health telemetry is a second, slower input for the cases
// where the UI thread is *not* the thing suffering (see noteHealthPressure).

/** Frame times above this are a machine that cannot keep up, uncapped. */
const SLOW_FRAME_MS = 34; // ~2 missed frames at 60Hz

/**
 * How much worse than the CURRENT cap's own frame interval counts as slow.
 *
 * Measuring against a fixed 34ms only works while the driver is uncapped. Once
 * auto has dropped a tier the driver deliberately runs slower -- 33ms at
 * `reduced`, 67ms at `economy` -- so a perfectly healthy machine kept
 * reporting frames "above 34ms" and the ladder could only ever go down. That
 * is the bug where one spike during a project load left the whole session at
 * 15fps forever: there was no measurement that could have earned it back.
 *
 * Judged against the cap instead, a tier that is comfortably keeping its own
 * pace reads as healthy, and the streak that climbs back can actually run.
 */
const SLOW_FRAME_FACTOR = 1.5;

/** What counts as a slow frame while `tier` is in force. */
export function slowFrameThresholdMs(tier: PerformanceTier): number {
  const fps = TIER_FPS[tier];
  // Uncapped: judge against a 60Hz display, the floor of what we ask for.
  const expectedMs = fps > 0 ? 1000 / fps : 1000 / 60;
  return Math.max(SLOW_FRAME_MS, expectedMs * SLOW_FRAME_FACTOR);
}
/** Consecutive slow seconds before dropping a tier. Long enough to ignore a
 *  project load, a song change, or one GC pause. */
const DEGRADE_AFTER_SLOW_SECONDS = 4;
/** Clean seconds before climbing back. Deliberately much longer than the drop,
 *  so a machine sitting near its limit settles instead of oscillating. */
const RECOVER_AFTER_GOOD_SECONDS = 20;

const TIER_ORDER: PerformanceTier[] = [
  "full",
  "balanced",
  "reduced",
  "economy",
];

/** One step down from `tier`, or null if already at the bottom. */
export function nextLowerTier(tier: PerformanceTier): PerformanceTier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

/** One step up from `tier`, capped at `ceiling` (what the user chose). */
export function nextHigherTier(
  tier: PerformanceTier,
  ceiling: PerformanceTier,
): PerformanceTier | null {
  const i = TIER_ORDER.indexOf(tier);
  const max = TIER_ORDER.indexOf(ceiling);
  return i > 0 && i - 1 >= max ? TIER_ORDER[i - 1] : null;
}

export interface AutoState {
  /** The tier actually in force right now. */
  effective: PerformanceTier;
  slowSeconds: number;
  goodSeconds: number;
}

/**
 * One second of evidence. Pure, so the whole ladder is testable without a
 * browser clock -- see performance.test.ts.
 *
 * `p95FrameMs` is the frame time this second; `pressure` is true when the
 * backend's health numbers say the machine is in trouble even if our own
 * frames happen to look fine.
 */
export function stepAuto(
  state: AutoState,
  {
    ceiling,
    p95FrameMs,
    pressure,
  }: { ceiling: PerformanceTier; p95FrameMs: number; pressure: boolean },
): AutoState {
  // The user's choice is a ceiling, and lowering it must take effect at once
  // rather than waiting out a recovery streak.
  let effective = state.effective;
  if (TIER_ORDER.indexOf(effective) < TIER_ORDER.indexOf(ceiling))
    effective = ceiling;

  const struggling =
    p95FrameMs > slowFrameThresholdMs(effective) || pressure;
  const slowSeconds = struggling ? state.slowSeconds + 1 : 0;
  const goodSeconds = struggling ? 0 : state.goodSeconds + 1;

  if (slowSeconds >= DEGRADE_AFTER_SLOW_SECONDS) {
    const lower = nextLowerTier(effective);
    if (lower) return { effective: lower, slowSeconds: 0, goodSeconds: 0 };
  }
  if (goodSeconds >= RECOVER_AFTER_GOOD_SECONDS) {
    const higher = nextHigherTier(effective, ceiling);
    if (higher) return { effective: higher, slowSeconds: 0, goodSeconds: 0 };
  }
  return { effective, slowSeconds, goodSeconds };
}

/**
 * Is the backend telling us the machine is in trouble?
 *
 * Disk is in here because it is the one that does not show up as CPU: a
 * throttling or saturated SSD stalls stem streaming, the streams starve, and
 * the render callback ships silence -- with the CPU graph flat the whole time.
 * `streamStarveCount` moving at all is the unambiguous version of that, so it
 * counts on its own; sustained throughput is the earlier, softer warning.
 */
export function healthPressure(
  prev: HealthSample | null,
  next: HealthSample,
): boolean {
  if (!prev) return false;
  // Anything that actually broke, however briefly.
  if (next.streamStarveCount > prev.streamStarveCount) return true;
  if (next.silentBlockCount > prev.silentBlockCount) return true;
  if (next.underrunCount > prev.underrunCount) return true;
  // A core's worth of CPU in this app alone, on top of everything else.
  if (next.cpuPercent >= 90) return true;
  // Sustained heavy disk traffic. Well above what steady stem playback needs,
  // so ordinary streaming does not trip it.
  const diskBytesPerSec = next.diskReadBytesPerSec + next.diskWriteBytesPerSec;
  if (diskBytesPerSec > 120 * 1024 * 1024) return true;
  return false;
}

export interface HealthSample {
  cpuPercent: number;
  underrunCount: number;
  silentBlockCount: number;
  streamStarveCount: number;
  diskReadBytesPerSec: number;
  diskWriteBytesPerSec: number;
}

/**
 * Watch frame times on the shared driver and report the worst of each second.
 *
 * Uses p95 rather than the mean: a second containing one 200ms stall and 59
 * good frames averages out to "fine", and that stall is exactly the thing the
 * operator noticed.
 */
export function observeFrameTimes(
  onSecond: (p95FrameMs: number) => void,
): () => void {
  let samples: number[] = [];
  let windowStart = 0;
  return addRafTask((nowMs, dtSec) => {
    if (windowStart === 0) windowStart = nowMs;
    samples.push(dtSec * 1000);
    if (nowMs - windowStart < 1000) return;
    samples.sort((a, b) => a - b);
    onSecond(samples[Math.floor(samples.length * 0.95)] ?? 0);
    samples = [];
    windowStart = nowMs;
  });
}

/** Push a tier at the frame driver. */
export function applyTier(tier: PerformanceTier): void {
  setRafFrameRateCap(TIER_FPS[tier]);
}
