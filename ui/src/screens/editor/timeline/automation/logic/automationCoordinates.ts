/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type {
  AutomationHitResult,
  AutomationPointViewModel,
} from "@/screens/editor/timeline/automation/logic/types";

export function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.max(lower, Math.min(upper, val));
}

export function clamp01(val: number): number {
  return clamp(val, 0, 1);
}

/**
 * Converts musical beat offset into pixel position given song tempo and timeline scale.
 */
export function beatToPixel(
  beat: number,
  bpm: number,
  pxPerSec: number,
): number {
  if (!Number.isFinite(beat) || beat <= 0) return 0;
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const safeScale = Number.isFinite(pxPerSec) && pxPerSec > 0 ? pxPerSec : 100;
  const seconds = (beat * 60) / safeBpm;
  return seconds * safeScale;
}

/**
 * Converts timeline pixel position into musical beat offset.
 */
export function pixelToBeat(
  px: number,
  bpm: number,
  pxPerSec: number,
): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const safeScale = Number.isFinite(pxPerSec) && pxPerSec > 0 ? pxPerSec : 100;
  const seconds = px / safeScale;
  return (seconds * safeBpm) / 60;
}

/** Signed displacement for dragging; absolute timeline positions clamp at zero. */
export function pixelDeltaToBeats(px: number, bpm: number, pxPerSec: number): number {
  if (!Number.isFinite(px)) return 0;
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const safeScale = Number.isFinite(pxPerSec) && pxPerSec > 0 ? pxPerSec : 100;
  return px * safeBpm / (60 * safeScale);
}

/**
 * Converts an automation parameter value to pixel Y (top = max, bottom = min).
 */
export function valueToPixel(
  value: number,
  height: number,
  minValue = 0,
  maxValue = 1,
): number {
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 60);
  const range = maxValue - minValue;
  const norm =
    Math.abs(range) < 1e-9
      ? 0.5
      : clamp01((value - minValue) / range);
  return (1 - norm) * safeHeight;
}

/**
 * Converts pixel Y coordinate back into typed parameter value.
 */
export function pixelToValue(
  py: number,
  height: number,
  minValue = 0,
  maxValue = 1,
): number {
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 60);
  const norm = clamp01(1 - py / safeHeight);
  return minValue + norm * (maxValue - minValue);
}

/**
 * Deterministic curve shaping matching ResoStage C++ AutomationCurve:
 * w = u^(2^(-curve * 2))
 * curve in [-1, +1]: -1 = exponential/concave, 0 = linear, +1 = logarithmic/convex.
 */
export function evaluateCurve(u: number, curve: number): number {
  const safeU = clamp01(u);
  if (safeU <= 0) return 0;
  if (safeU >= 1) return 1;
  const safeCurve = clamp(Number.isFinite(curve) ? curve : 0, -1, 1);
  if (Math.abs(safeCurve) < 1e-6) return safeU;
  const exponent = Math.pow(2.0, -safeCurve * 2.0);
  return Math.pow(safeU, exponent);
}

/**
 * Evaluates automation value at a specific musical beat time between two points.
 */
export function interpolateAutomationValue(
  p1: AutomationPointViewModel,
  p2: AutomationPointViewModel,
  timeBeats: number,
): number {
  if (timeBeats <= p1.timeBeats) return p1.value;
  if (timeBeats >= p2.timeBeats) return p2.value;
  const dt = p2.timeBeats - p1.timeBeats;
  if (dt < 1e-6) return p1.value;
  const u = (timeBeats - p1.timeBeats) / dt;
  const shaped = evaluateCurve(u, p1.curve);
  return p1.value + shaped * (p2.value - p1.value);
}

/**
 * Calculates the screen position of a curve handle midpoint between two points.
 */
export function getCurveHandlePosition(
  p1: AutomationPointViewModel,
  p2: AutomationPointViewModel,
  bpm: number,
  pxPerSec: number,
  height: number,
  minValue = 0,
  maxValue = 1,
): { x: number; y: number; u: number; timeBeats: number; value: number } {
  const midBeats = p1.timeBeats + 0.5 * (p2.timeBeats - p1.timeBeats);
  const midVal = interpolateAutomationValue(p1, p2, midBeats);
  const x = beatToPixel(midBeats, bpm, pxPerSec);
  const y = valueToPixel(midVal, height, minValue, maxValue);
  return { x, y, u: 0.5, timeBeats: midBeats, value: midVal };
}

/**
 * Builds SVG path definition ('d' attribute) for an automation curve line and fill.
 */
export function buildAutomationSvgPaths(
  points: AutomationPointViewModel[],
  bpm: number,
  pxPerSec: number,
  height: number,
  totalWidthPx: number,
  minValue = 0,
  maxValue = 1,
  samplesPerCurve = 16,
): { strokePath: string; fillPath: string } {
  if (points.length === 0) {
    const defaultY = valueToPixel(
      minValue + 0.5 * (maxValue - minValue),
      height,
      minValue,
      maxValue,
    );
    const stroke = `M 0 ${defaultY.toFixed(1)} L ${totalWidthPx.toFixed(1)} ${defaultY.toFixed(1)}`;
    const fill = `${stroke} L ${totalWidthPx.toFixed(1)} ${height} L 0 ${height} Z`;
    return { strokePath: stroke, fillPath: fill };
  }

  const sorted = points.slice().sort((a, b) => a.timeBeats - b.timeBeats);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const firstX = beatToPixel(first.timeBeats, bpm, pxPerSec);
  const firstY = valueToPixel(first.value, height, minValue, maxValue);

  let path = "";
  // If first point is after 0, extend flat line from left edge
  if (firstX > 0) {
    path += `M 0 ${firstY.toFixed(1)} L ${firstX.toFixed(1)} ${firstY.toFixed(1)}`;
  } else {
    path += `M ${firstX.toFixed(1)} ${firstY.toFixed(1)}`;
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const p1 = sorted[i];
    const p2 = sorted[i + 1];
    const x2 = beatToPixel(p2.timeBeats, bpm, pxPerSec);

    if (Math.abs(p1.curve) < 1e-4 || samplesPerCurve <= 1) {
      // Linear segment
      const y2 = valueToPixel(p2.value, height, minValue, maxValue);
      path += ` L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    } else {
      // Curved segment: sample intermediate points
      const samples = Math.max(4, samplesPerCurve);
      for (let s = 1; s <= samples; s++) {
        const u = s / samples;
        const curBeats = p1.timeBeats + u * (p2.timeBeats - p1.timeBeats);
        const curVal = interpolateAutomationValue(p1, p2, curBeats);
        const sx = beatToPixel(curBeats, bpm, pxPerSec);
        const sy = valueToPixel(curVal, height, minValue, maxValue);
        path += ` L ${sx.toFixed(1)} ${sy.toFixed(1)}`;
      }
    }
  }

  // Extend flat line to right boundary
  const lastX = beatToPixel(last.timeBeats, bpm, pxPerSec);
  const lastY = valueToPixel(last.value, height, minValue, maxValue);
  if (lastX < totalWidthPx) {
    path += ` L ${totalWidthPx.toFixed(1)} ${lastY.toFixed(1)}`;
  }

  const fill = `${path} L ${totalWidthPx.toFixed(1)} ${height} L 0 ${height} Z`;
  return { strokePath: path, fillPath: fill };
}

/**
 * Hit-test against points, curve handles, and line segments.
 */
export function hitTestAutomation(
  points: AutomationPointViewModel[],
  bpm: number,
  pxPerSec: number,
  height: number,
  localX: number,
  localY: number,
  pointRadiusPx = 7,
  segmentTolerancePx = 6,
  minValue = 0,
  maxValue = 1,
): AutomationHitResult {
  if (points.length === 0) return { type: "none" };

  const sorted = points
    .map((point, index) => ({ point, index }))
    .sort((a, b) => a.point.timeBeats - b.point.timeBeats);

  // 1. Check points first (highest priority)
  let bestPointDist = pointRadiusPx;
  let bestPointHit: { index: number; point: AutomationPointViewModel } | null =
    null;

  for (const item of sorted) {
    const px = beatToPixel(item.point.timeBeats, bpm, pxPerSec);
    const py = valueToPixel(item.point.value, height, minValue, maxValue);
    const dist = Math.hypot(px - localX, py - localY);
    if (dist <= bestPointDist) {
      bestPointDist = dist;
      bestPointHit = item;
    }
  }

  if (bestPointHit) {
    return {
      type: "point",
      pointIndex: bestPointHit.index,
      point: bestPointHit.point,
    };
  }

  // 2. Check curve handles between adjacent points
  for (let i = 0; i < sorted.length - 1; i++) {
    const p1 = sorted[i];
    const p2 = sorted[i + 1];
    const handle = getCurveHandlePosition(
      p1.point,
      p2.point,
      bpm,
      pxPerSec,
      height,
      minValue,
      maxValue,
    );
    const handleDist = Math.hypot(handle.x - localX, handle.y - localY);
    if (handleDist <= pointRadiusPx) {
      return {
        type: "curveHandle",
        segmentIndexBefore: p1.index,
        segmentIndexAfter: p2.index,
        currentCurve: p1.point.curve,
        handleX: handle.x,
        handleY: handle.y,
      };
    }
  }

  // 3. Check segments
  for (let i = 0; i < sorted.length - 1; i++) {
    const p1 = sorted[i];
    const p2 = sorted[i + 1];
    const x1 = beatToPixel(p1.point.timeBeats, bpm, pxPerSec);
    const x2 = beatToPixel(p2.point.timeBeats, bpm, pxPerSec);

    if (localX >= Math.min(x1, x2) - 2 && localX <= Math.max(x1, x2) + 2) {
      const clickBeats = pixelToBeat(localX, bpm, pxPerSec);
      const interpVal = interpolateAutomationValue(
        p1.point,
        p2.point,
        clickBeats,
      );
      const expectedY = valueToPixel(interpVal, height, minValue, maxValue);
      if (Math.abs(expectedY - localY) <= segmentTolerancePx) {
        const dt = Math.max(1e-6, p2.point.timeBeats - p1.point.timeBeats);
        const u = clamp01((clickBeats - p1.point.timeBeats) / dt);
        return {
          type: "segment",
          segmentIndexBefore: p1.index,
          segmentIndexAfter: p2.index,
          u,
          timeBeats: clickBeats,
          interpolatedValue: interpVal,
        };
      }
    }
  }

  return { type: "none" };
}

/**
 * Viewport LOD decimation: filters out points far outside viewport bounds,
 * keeping bounding anchors and critical extrema.
 */
export function decimatePointsForViewport(
  points: AutomationPointViewModel[],
  bpm: number,
  pxPerSec: number,
  viewportStartPx: number,
  viewportEndPx: number,
  maxPoints = 400,
): AutomationPointViewModel[] {
  const limit = Math.max(2, Math.floor(maxPoints));
  if (points.length <= limit) return points;

  const sorted = points.slice().sort((a, b) => a.timeBeats - b.timeBeats);
  const startBeat = pixelToBeat(Math.max(0, viewportStartPx - 100), bpm, pxPerSec);
  const endBeat = pixelToBeat(viewportEndPx + 100, bpm, pxPerSec);

  // Keep all points within or adjacent to the visible viewport
  const visible: AutomationPointViewModel[] = [];
  let prevOutside: AutomationPointViewModel | null = null;
  let hasNextAnchor = false;

  for (const p of sorted) {
    if (p.timeBeats < startBeat) {
      prevOutside = p;
    } else if (p.timeBeats <= endBeat) {
      if (prevOutside) {
        visible.push(prevOutside);
        prevOutside = null;
      }
      visible.push(p);
    } else {
      if (!hasNextAnchor) {
        if (prevOutside) {
          visible.push(prevOutside);
          prevOutside = null;
        }
        visible.push(p);
        hasNextAnchor = true;
      }
      break;
    }
  }
  // An entirely off-screen lane still defines a constant value at the view.
  if (prevOutside) visible.push(prevOutside);

  if (visible.length <= limit) return visible;

  // One largest deviation per bucket retains salient shape while enforcing a
  // hard SVG node budget. Keeping every extremum could exceed it on noisy data.
  const result: AutomationPointViewModel[] = [visible[0]];
  const buckets = limit - 2;
  for (let bucket = 0; bucket < buckets; ++bucket) {
    const start = 1 + Math.floor(bucket * (visible.length - 2) / buckets);
    const end = 1 + Math.floor((bucket + 1) * (visible.length - 2) / buckets);
    const before = visible[start - 1];
    const after = visible[Math.min(end, visible.length - 1)];
    const span = Math.max(1e-9, after.timeBeats - before.timeBeats);
    let strongest = start;
    let deviation = -1;
    for (let index = start; index < end; ++index) {
      const point = visible[index];
      const fraction = (point.timeBeats - before.timeBeats) / span;
      const linear = before.value + fraction * (after.value - before.value);
      const distance = Math.abs(point.value - linear);
      if (distance > deviation) { strongest = index; deviation = distance; }
    }
    result.push(visible[strongest]);
  }

  result.push(visible[visible.length - 1]);
  return result;
}
