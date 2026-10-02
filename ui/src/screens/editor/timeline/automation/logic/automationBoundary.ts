/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { AutomationLaneRow, AutomationPointRow } from "@/lib/state/types";
import { interpolateAutomationValue } from "./automationCoordinates";

/**
 * Evaluates the value of an automation point stream at an arbitrary beat position.
 */
export function evaluateAutomationAt(
  points: AutomationPointRow[],
  timeBeats: number,
  defaultValue = 0,
): number {
  if (!points || points.length === 0) return defaultValue;
  const sorted = points.slice().sort((a, b) => a.timeBeats - b.timeBeats);
  if (timeBeats <= sorted[0].timeBeats) return sorted[0].value;
  if (timeBeats >= sorted[sorted.length - 1].timeBeats) {
    return sorted[sorted.length - 1].value;
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const p1 = sorted[i];
    const p2 = sorted[i + 1];
    if (timeBeats >= p1.timeBeats && timeBeats <= p2.timeBeats) {
      return interpolateAutomationValue(p1, p2, timeBeats);
    }
  }

  return defaultValue;
}

/**
 * Splits an array of automation points at splitBeats into left and right halves.
 * Evaluates exact boundary values without deforming adjacent curves.
 * The right half points are re-anchored so that splitBeats becomes 0.
 */
export function splitAutomationPoints(
  points: AutomationPointRow[],
  splitBeats: number,
  defaultValue = 0,
): { leftPoints: AutomationPointRow[]; rightPoints: AutomationPointRow[] } {
  if (!points || points.length === 0) {
    return {
      leftPoints: [],
      rightPoints: [],
    };
  }

  const safeSplit = Math.max(0, splitBeats);
  const sorted = points.slice().sort((a, b) => a.timeBeats - b.timeBeats);
  const boundaryVal = evaluateAutomationAt(sorted, safeSplit, defaultValue);

  // Left half: points < safeSplit plus boundary anchor at safeSplit
  const leftPoints: AutomationPointRow[] = [];
  let leftHasExactSplit = false;

  for (const pt of sorted) {
    if (pt.timeBeats < safeSplit - 1e-4) {
      leftPoints.push({ ...pt });
    } else if (Math.abs(pt.timeBeats - safeSplit) <= 1e-4) {
      leftPoints.push({ ...pt, timeBeats: safeSplit });
      leftHasExactSplit = true;
      break;
    } else {
      break;
    }
  }

  if (!leftHasExactSplit) {
    leftPoints.push({
      timeBeats: safeSplit,
      value: boundaryVal,
      curve: 0,
    });
  }

  // Right half: boundary anchor at 0 plus points > safeSplit re-anchored
  const rightPoints: AutomationPointRow[] = [
    {
      timeBeats: 0,
      value: boundaryVal,
      curve: 0,
    },
  ];

  for (const pt of sorted) {
    if (pt.timeBeats > safeSplit + 1e-4) {
      rightPoints.push({
        timeBeats: pt.timeBeats - safeSplit,
        value: pt.value,
        curve: pt.curve,
      });
    }
  }

  return { leftPoints, rightPoints };
}

/**
 * Splits a list of automation lanes at splitBeats into left and right lane sets.
 */
export function splitAutomationLanes(
  lanes: AutomationLaneRow[],
  splitBeats: number,
): { leftLanes: AutomationLaneRow[]; rightLanes: AutomationLaneRow[] } {
  if (!lanes || lanes.length === 0) {
    return { leftLanes: [], rightLanes: [] };
  }

  const leftLanes: AutomationLaneRow[] = [];
  const rightLanes: AutomationLaneRow[] = [];

  for (const lane of lanes) {
    const { leftPoints, rightPoints } = splitAutomationPoints(
      lane.points,
      splitBeats,
      lane.target.defaultValue,
    );

    leftLanes.push({
      ...lane,
      points: leftPoints,
    });

    rightLanes.push({
      ...lane,
      id: crypto.randomUUID(),
      points: rightPoints,
    });
  }

  return { leftLanes, rightLanes };
}
