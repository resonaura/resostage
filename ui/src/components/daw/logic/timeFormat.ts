/**
 * Transport clock formatting.
 *
 * Two formats existed side by side (GlobalTransportBar's `m:ss.f` and
 * PlayerScreen's `mm:ss.sss`) as separate private `formatTime` functions that
 * looked like duplicates but were not — they answer different questions. Both
 * live here now, named for what they are, so picking one is a choice rather
 * than an accident of which file you happened to be in.
 *
 * Separate from TimeDisplay.tsx so the component file exports only a
 * component (Fast Refresh) and so these stay unit-testable without a DOM.
 */

/** `m:ss.f` — the compact header chip. One decimal is enough to see motion. */
export function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const tenths = Math.floor((sec % 1) * 10);
  return `${m}:${s < 10 ? "0" : ""}${s}.${tenths}`;
}

/**
 * `mm:ss.sss` — the Player's big readout. Millisecond precision because that
 * screen is what you look at to check you are on the beat, and fixed-width
 * minutes so the readout never reflows as it counts.
 */
export function formatClockPrecise(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

/**
 * `bar | beat`, 1-based as musicians count. Returns an em dash when there is
 * no usable tempo — a bar number computed from bpm 0 would be a lie, not a
 * zero.
 */
export function formatBarBeat(
  seconds: number,
  bpm: number,
  tsNum: number,
): string {
  if (bpm <= 0 || seconds < 0) return "—";
  const beatsPerBar = Math.max(1, tsNum);
  const totalBeats = seconds / (60 / bpm);
  const bar = Math.floor(totalBeats / beatsPerBar) + 1;
  const beat = (Math.floor(totalBeats) % beatsPerBar) + 1;
  return `${bar} | ${beat}`;
}
