// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

export function barBeat(seconds: number, bpm: number, tsNum: number): string {
  if (bpm <= 0 || seconds < 0) return "—";
  const beatsPerBar = Math.max(1, tsNum);
  const secondsPerBeat = 60 / bpm;
  const totalBeats = seconds / secondsPerBeat;
  const bar = Math.floor(totalBeats / beatsPerBar) + 1;
  const beat = (Math.floor(totalBeats) % beatsPerBar) + 1;
  return `${bar} | ${beat}`;
}

// Cumulative whole-project bar|beat from an already-accumulated beat count
// (see AudioEngine::globalBeatsElapsed).
export function globalBarBeat(beatsElapsed: number, tsNum: number): string {
  if (!Number.isFinite(beatsElapsed) || beatsElapsed < 0 || tsNum <= 0)
    return "—";
  const beatsPerBar = Math.max(1, tsNum);
  const bar = Math.floor(beatsElapsed / beatsPerBar) + 1;
  const beat = (Math.floor(beatsElapsed) % beatsPerBar) + 1;
  return `${bar} | ${beat}`;
}
