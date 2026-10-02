/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { SongRow } from "@/lib/state/types";

export interface SongTempoMap {
  beatsToSeconds(beat: number): number;
  secondsToBeats(seconds: number): number;
}

/** Build an immutable piecewise step/linear-ramp map matching Core TempoMap. */
export function createSongTempoMap(song: Pick<SongRow, "bpm" | "tempoPoints">): SongTempoMap {
  const fallbackBpm = Number.isFinite(song.bpm) && song.bpm > 0
    ? Math.min(1000, Math.max(1, song.bpm))
    : 120;
  const points = (song.tempoPoints ?? [])
    .filter((point) => Number.isFinite(point.beat) && Number.isFinite(point.bpm))
    .map((point) => ({
      ...point,
      bpm: Math.min(1000, Math.max(1, point.bpm)),
      curve: Number.isFinite(point.curve) ? point.curve : 0,
      timeSeconds: 0,
    }))
    .sort((a, b) => a.beat - b.beat);

  if (points.length === 0 || points[0].beat > 0) {
    points.unshift({ beat: 0, bpm: fallbackBpm, curve: 0, timeSeconds: 0 });
  }

  for (let index = 0; index + 1 < points.length; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const spanBeats = Math.max(0, next.beat - current.beat);
    if (spanBeats <= 1e-9) {
      next.timeSeconds = current.timeSeconds;
      continue;
    }

    const deltaBpm = next.bpm - current.bpm;
    if (Math.abs(current.curve) < 1e-9 || Math.abs(deltaBpm) < 1e-9) {
      next.timeSeconds = current.timeSeconds + spanBeats * 60 / current.bpm;
      continue;
    }

    const rate = deltaBpm / spanBeats;
    const ratio = next.bpm / current.bpm;
    next.timeSeconds = ratio > 1e-9
      ? current.timeSeconds + 60 / rate * Math.log(ratio)
      : current.timeSeconds + spanBeats * 60 / current.bpm;
  }

  const findPointForBeat = (beat: number) => {
    let low = 0;
    let high = points.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (points[mid].beat <= beat) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, low - 1);
  };
  const findPointForSeconds = (seconds: number) => {
    let low = 0;
    let high = points.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (points[mid].timeSeconds <= seconds) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, low - 1);
  };

  const beatsToSeconds = (beat: number) => {
    if (!Number.isFinite(beat)) return 0;
    const index = findPointForBeat(beat);
    const current = points[index];
    const deltaBeats = beat - current.beat;
    const next = points[index + 1];
    if (!next || Math.abs(current.curve) < 1e-9)
      return current.timeSeconds + deltaBeats * 60 / current.bpm;

    const spanBeats = next.beat - current.beat;
    const deltaBpm = next.bpm - current.bpm;
    if (spanBeats <= 1e-9 || Math.abs(deltaBpm) < 1e-9)
      return current.timeSeconds + deltaBeats * 60 / current.bpm;

    const rate = deltaBpm / spanBeats;
    const ratio = 1 + rate * deltaBeats / current.bpm;
    if (ratio <= 1e-9 || !Number.isFinite(ratio)) return current.timeSeconds;
    const logarithm = Math.log(ratio);
    return Number.isFinite(logarithm)
      ? current.timeSeconds + 60 / rate * logarithm
      : current.timeSeconds + deltaBeats * 60 / current.bpm;
  };

  const secondsToBeats = (seconds: number) => {
    if (!Number.isFinite(seconds)) return 0;
    const index = findPointForSeconds(seconds);
    const current = points[index];
    const deltaSeconds = seconds - current.timeSeconds;
    const next = points[index + 1];
    if (!next || Math.abs(current.curve) < 1e-9)
      return current.beat + deltaSeconds * current.bpm / 60;

    const spanBeats = next.beat - current.beat;
    const deltaBpm = next.bpm - current.bpm;
    if (spanBeats <= 1e-9 || Math.abs(deltaBpm) < 1e-9)
      return current.beat + deltaSeconds * current.bpm / 60;

    const rate = deltaBpm / spanBeats;
    const exponent = Math.min(80, Math.max(-80, rate * deltaSeconds / 60));
    const deltaBeats = current.bpm / rate * (Math.exp(exponent) - 1);
    return Number.isFinite(deltaBeats)
      ? current.beat + deltaBeats
      : current.beat + deltaSeconds * current.bpm / 60;
  };

  return { beatsToSeconds, secondsToBeats };
}

/** Convert song-local musical beats to seconds using its current tempo map. */
export function songSecondsAtBeat(song: Pick<SongRow, "bpm" | "tempoPoints">, beat: number): number {
  return createSongTempoMap(song).beatsToSeconds(beat);
}

/** Convert song-local seconds to beats using its current tempo map. */
export function songBeatsAtSeconds(song: Pick<SongRow, "bpm" | "tempoPoints">, seconds: number): number {
  return createSongTempoMap(song).secondsToBeats(seconds);
}
