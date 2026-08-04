/** Dynamic ruler / beat-grid tick configuration for a given zoom + tempo. */
export function getTickConfig(pxPerSec: number, bpm: number, tsNum: number) {
  // Majors: labels stay readable (~70px). Minors: denser grid as long as
  // strokes are ≥ ~4px apart — never collapse to majors-only until zoom-out
  // is extreme enough that even major/4 is too tight.
  const minPxPerLabel = 70;
  const minPxPerMinor = 4;

  /** Densest candidate ≤ major that still clears minPxPerMinor. */
  const pickMinor = (major: number, candidates: number[]) => {
    const sorted = [...candidates]
      .filter((s) => s > 0 && s <= major + 1e-12)
      .sort((a, b) => a - b);
    for (const c of sorted) {
      if (c * pxPerSec >= minPxPerMinor) return c;
    }
    return major;
  };

  if (bpm > 1) {
    const beatSec = 60 / bpm;
    const barSec = beatSec * Math.max(1, tsNum);
    let majorBarStep = 1;
    while (
      majorBarStep < 1_000_000 &&
      majorBarStep * barSec * pxPerSec < minPxPerLabel
    ) {
      majorBarStep *= 2;
    }
    const majorStepSec = majorBarStep * barSec;
    // Intermediate levels: beats, bars, 1/8…1/2 of major (always have mid lines).
    const minorStepSec = pickMinor(majorStepSec, [
      beatSec,
      barSec,
      majorStepSec / 8,
      majorStepSec / 4,
      majorStepSec / 2,
      majorStepSec,
    ]);
    return { majorStepSec, minorStepSec, isBeatGrid: true, barSec, beatSec };
  }

  const secList = [
    0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
    7200, 14400,
  ];
  let majorStepSec =
    secList.find((s) => s * pxPerSec >= minPxPerLabel) ??
    (() => {
      let s = 14400;
      while (s * pxPerSec < minPxPerLabel && s < 1e9) s *= 2;
      return s;
    })();
  const minorStepSec = pickMinor(majorStepSec, [
    majorStepSec / 10,
    majorStepSec / 8,
    majorStepSec / 6,
    majorStepSec / 5,
    majorStepSec / 4,
    majorStepSec / 2,
    majorStepSec,
  ]);
  return {
    majorStepSec,
    minorStepSec,
    isBeatGrid: false,
    barSec: 0,
    beatSec: 0,
  };
}

export function getSnapInterval(
  pxPerSec: number,
  bpm: number,
  tsNum: number,
): number {
  if (bpm <= 0) return 1.0;
  const tc = getTickConfig(pxPerSec, bpm, tsNum);
  return tc.minorStepSec > 0 ? tc.minorStepSec : 60 / bpm;
}

export function snapToGridSec(
  sec: number,
  pxPerSec: number,
  bpm: number,
  tsNum: number,
  snapEnabled: boolean,
): number {
  if (!snapEnabled || bpm <= 0) return sec;
  const interval = getSnapInterval(pxPerSec, bpm, tsNum);
  return Math.round(sec / interval) * interval;
}

export function formatTimeShort(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}
