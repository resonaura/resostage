/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { AutomationLaneRow, AutomationPointRow } from "@/lib/state/types";
import {
  evaluateAutomationAt,
  splitAutomationLanes,
  splitAutomationPoints,
} from "../automationBoundary";

describe("automationBoundary", () => {
  describe("evaluateAutomationAt", () => {
    it("returns boundary values when before first or after last point", () => {
      const points: AutomationPointRow[] = [
        { timeBeats: 2, value: 0.2, curve: 0 },
        { timeBeats: 6, value: 0.8, curve: 0 },
      ];
      expect(evaluateAutomationAt(points, 0)).toBe(0.2);
      expect(evaluateAutomationAt(points, 2)).toBe(0.2);
      expect(evaluateAutomationAt(points, 10)).toBe(0.8);
    });

    it("evaluates intermediate values accurately", () => {
      const points: AutomationPointRow[] = [
        { timeBeats: 0, value: 0, curve: 0 },
        { timeBeats: 4, value: 1, curve: 0 },
      ];
      expect(evaluateAutomationAt(points, 2)).toBeCloseTo(0.5, 4);
    });
  });

  describe("splitAutomationPoints", () => {
    it("splits linear automation without deforming boundary values", () => {
      const points: AutomationPointRow[] = [
        { timeBeats: 0, value: 0.0, curve: 0 },
        { timeBeats: 4, value: 1.0, curve: 0 },
      ];

      const { leftPoints, rightPoints } = splitAutomationPoints(points, 2.0);

      // Left half: [0, 2] with value [0, 0.5]
      expect(leftPoints.length).toBe(2);
      expect(leftPoints[0]).toEqual({ timeBeats: 0, value: 0.0, curve: 0 });
      expect(leftPoints[1].timeBeats).toBe(2.0);
      expect(leftPoints[1].value).toBeCloseTo(0.5, 4);

      // Right half: re-anchored to [0, 2] with value [0.5, 1.0]
      expect(rightPoints.length).toBe(2);
      expect(rightPoints[0].timeBeats).toBe(0.0);
      expect(rightPoints[0].value).toBeCloseTo(0.5, 4);
      expect(rightPoints[1]).toEqual({ timeBeats: 2.0, value: 1.0, curve: 0 });
    });

    it("handles split directly on an existing point", () => {
      const points: AutomationPointRow[] = [
        { timeBeats: 0, value: 0.2, curve: 0 },
        { timeBeats: 3, value: 0.7, curve: 0 },
        { timeBeats: 6, value: 0.4, curve: 0 },
      ];

      const { leftPoints, rightPoints } = splitAutomationPoints(points, 3.0);
      expect(leftPoints.length).toBe(2);
      expect(leftPoints[1]).toEqual({ timeBeats: 3, value: 0.7, curve: 0 });

      expect(rightPoints.length).toBe(2);
      expect(rightPoints[0]).toEqual({ timeBeats: 0, value: 0.7, curve: 0 });
      expect(rightPoints[1]).toEqual({ timeBeats: 3, value: 0.4, curve: 0 });
    });

    it("handles empty point stream", () => {
      const { leftPoints, rightPoints } = splitAutomationPoints([], 2.0);
      expect(leftPoints).toEqual([]);
      expect(rightPoints).toEqual([]);
    });
  });

  describe("splitAutomationLanes", () => {
    it("splits lanes preserving target config and updating IDs", () => {
      const lane: AutomationLaneRow = {
        id: "lane-original",
        target: {
          domain: "strip",
          entityId: "track-1",
          parameterId: "pan",
          valueType: "floatNormalized",
          defaultValue: 0,
          minValue: -1,
          maxValue: 1,
        },
        scope: "region",
        writeMode: "read",
        enabled: true,
        muted: false,
        points: [
          { timeBeats: 0, value: -1, curve: 0 },
          { timeBeats: 8, value: 1, curve: 0 },
        ],
      };

      const { leftLanes, rightLanes } = splitAutomationLanes([lane], 4);
      expect(leftLanes.length).toBe(1);
      expect(rightLanes.length).toBe(1);

      expect(leftLanes[0].id).toBe("lane-original");
      expect(leftLanes[0].points[1].value).toBeCloseTo(0, 4);

      expect(rightLanes[0].id).not.toBe("lane-original");
      expect(rightLanes[0].points[0].value).toBeCloseTo(0, 4);
      expect(rightLanes[0].points[1].timeBeats).toBe(4);
    });
  });
});
