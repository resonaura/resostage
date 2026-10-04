/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { midiSecondsAtBeat } from "@/lib/midi/standardMidiFile";
import type { MidiMeterEvent } from "@/lib/midi/standardMidiFile";

export interface ImportedTempoPoint {
  beat: number;
  bpm: number;
  timeSeconds: number;
  curve: 0;
}

export interface ImportedSignaturePoint extends MidiMeterEvent {
  bar: number;
}

export interface ImportedSongTiming {
  bpm: number;
  tempoPoints: ImportedTempoPoint[];
  signaturePoints: ImportedSignaturePoint[];
}

/** Build independent song-start timing from the selected MIDI sequence maps. */
export function buildImportedSongTiming(
  sourceTempoEvents: ReadonlyArray<{ beat: number; bpm: number }>,
  sourceMeterEvents: ReadonlyArray<MidiMeterEvent>,
): ImportedSongTiming {
  const tempoByBeat = new Map<number, { beat: number; bpm: number }>();
  tempoByBeat.set(0, { beat: 0, bpm: 120 });
  for (const point of sourceTempoEvents) {
    if (Number.isFinite(point.beat) && point.beat >= 0) tempoByBeat.set(point.beat, point);
  }
  const tempos = [...tempoByBeat.values()].sort((a, b) => a.beat - b.beat);
  const tempoPoints = tempos.map((point) => ({
    ...point,
    timeSeconds: midiSecondsAtBeat(sourceTempoEvents, point.beat),
    curve: 0 as const,
  }));

  const meterByBeat = new Map<number, MidiMeterEvent>();
  meterByBeat.set(0, { beat: 0, numerator: 4, denominator: 4 });
  for (const point of sourceMeterEvents) {
    if (Number.isFinite(point.beat) && point.beat >= 0) meterByBeat.set(point.beat, point);
  }
  const meters = [...meterByBeat.values()].sort((a, b) => a.beat - b.beat);
  let bar = 1;
  let previousBeat = 0;
  let previousNumerator = 4;
  let previousDenominator = 4;
  const signaturePoints = meters.map((point) => {
    const beatsPerBar = previousNumerator * 4 / previousDenominator;
    bar += Math.floor(Math.max(0, point.beat - previousBeat) / beatsPerBar + 1e-9);
    const signature = { ...point, bar };
    previousBeat = point.beat;
    previousNumerator = point.numerator;
    previousDenominator = point.denominator;
    return signature;
  });

  return { bpm: tempoPoints[0]?.bpm ?? 120, tempoPoints, signaturePoints };
}
