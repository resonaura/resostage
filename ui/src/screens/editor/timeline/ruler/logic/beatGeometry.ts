/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { SignaturePointRow } from "@/lib/state/types";

export interface MusicalRulerMark {
  beat: number;
  major: boolean;
  mid: boolean;
  bar?: number;
}

interface SignatureSegment extends SignaturePointRow {}

/**
 * Creates bounded ruler marks on the Piano Roll's project-beat axis. Bar
 * numbering and meter changes come from Core's normalized signature map;
 * unlike a seconds ruler, tempo changes do not stretch musical bar spacing.
 */
export function getMusicalRulerMarks({
  startBeat,
  endBeat,
  pixelsPerBeat,
  defaultNumerator,
  defaultDenominator = 4,
  signaturePoints = [],
  maxMarks = 2000,
}: {
  startBeat: number;
  endBeat: number;
  pixelsPerBeat: number;
  defaultNumerator: number;
  defaultDenominator?: number;
  signaturePoints?: SignaturePointRow[];
  maxMarks?: number;
}): MusicalRulerMark[] {
  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat)
    || !Number.isFinite(pixelsPerBeat) || pixelsPerBeat <= 0 || endBeat < startBeat) return [];

  const fallbackNumerator = Number.isFinite(defaultNumerator) && defaultNumerator > 0
    ? Math.min(64, defaultNumerator) : 4;
  const fallbackDenominator = Number.isFinite(defaultDenominator) && defaultDenominator > 0
    ? Math.min(64, defaultDenominator) : 4;
  const points = (signaturePoints ?? [])
    .filter((point) => Number.isFinite(point.beat) && point.beat >= 0
      && Number.isFinite(point.numerator) && point.numerator > 0
      && Number.isFinite(point.denominator) && point.denominator > 0
      && Number.isFinite(point.bar) && point.bar >= 1)
    .map((point) => ({
      ...point,
      numerator: Math.min(64, Math.trunc(point.numerator)),
      denominator: Math.min(64, Math.trunc(point.denominator)),
      bar: Math.max(1, Math.trunc(point.bar)),
    }))
    .filter((point) => point.numerator > 0 && point.denominator > 0)
    .sort((a, b) => a.beat - b.beat);

  const segments: SignatureSegment[] = [];
  if (!points.length || points[0].beat > 0) {
    segments.push({
      beat: 0,
      numerator: fallbackNumerator,
      denominator: fallbackDenominator,
      bar: 1,
    });
  }
  for (const point of points) {
    if (segments.length > 0 && Math.abs(segments[segments.length - 1].beat - point.beat) < 1e-9) {
      segments[segments.length - 1] = point;
    } else {
      segments.push(point);
    }
  }

  const marks: MusicalRulerMark[] = [];
  for (let segmentIndex = 0; segmentIndex < segments.length && marks.length < maxMarks;
    segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const nextSegment = segments[segmentIndex + 1];
    const segmentEnd = Math.min(endBeat, nextSegment?.beat ?? endBeat);
    if (segmentEnd < startBeat || segment.beat > endBeat) continue;

    const barBeats = segment.numerator * 4 / segment.denominator;
    if (!Number.isFinite(barBeats) || barBeats <= 0) continue;
    let majorBarStep = 1;
    while (majorBarStep < 1_000_000
      && barBeats * majorBarStep * pixelsPerBeat < 70) majorBarStep *= 2;

    const noteBeat = 4 / segment.denominator;
    const candidates = [noteBeat / 4, noteBeat / 2, noteBeat, barBeats / 2, barBeats]
      .filter((step) => Number.isFinite(step) && step > 0 && step <= barBeats)
      .sort((a, b) => a - b);
    const minorBeat = candidates.find((step) => step * pixelsPerBeat >= 4) ?? barBeats;
    const midBeat = barBeats / 2;
    const firstBarIndex = Math.max(0, Math.floor((startBeat - segment.beat) / barBeats));
    const lastBarIndex = Math.max(firstBarIndex, Math.ceil((segmentEnd - segment.beat) / barBeats));

    for (let barIndex = firstBarIndex; barIndex <= lastBarIndex && marks.length < maxMarks;
      barIndex += 1) {
      const barStart = segment.beat + barIndex * barBeats;
      if (nextSegment && barStart >= nextSegment.beat - 1e-9) break;
      if (barStart > segmentEnd + 1e-9) break;
      const beatStepsPerBar = Math.max(1, Math.ceil(barBeats / minorBeat - 1e-9));
      for (let stepIndex = 0; stepIndex < beatStepsPerBar && marks.length < maxMarks;
        stepIndex += 1) {
        const beat = barStart + stepIndex * minorBeat;
        if (nextSegment && beat >= nextSegment.beat - 1e-9) continue;
        if (beat < startBeat - 1e-9 || beat > segmentEnd + 1e-9) continue;
        const isBar = stepIndex === 0;
        const isMajor = isBar && barIndex % majorBarStep === 0;
        const isMid = !isBar && Math.abs((beat - barStart) - midBeat) < 1e-7;
        marks.push({
          beat,
          major: isMajor,
          mid: isMid,
          bar: isMajor ? segment.bar + barIndex : undefined,
        });
      }
    }
  }
  return marks;
}
