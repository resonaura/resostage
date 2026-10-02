/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  beatToPixel,
  buildAutomationSvgPaths,
  decimatePointsForViewport,
  evaluateCurve,
  getCurveHandlePosition,
  hitTestAutomation,
  interpolateAutomationValue,
  pixelToBeat,
  pixelToValue,
  valueToPixel,
} from "../automationCoordinates";
import type { AutomationPointViewModel } from "../types";

describe("automationCoordinates", () => {
  describe("time <-> pixel conversions", () => {
    it("converts beat to pixel at 120 bpm, 100 px/sec", () => {
      // 120 bpm = 2 beats per second (0.5s per beat).
      // 2 beats = 1 second = 100 px.
      expect(beatToPixel(0, 120, 100)).toBe(0);
      expect(beatToPixel(2, 120, 100)).toBeCloseTo(100, 3);
      expect(beatToPixel(4, 120, 100)).toBeCloseTo(200, 3);
    });

    it("converts pixel to beat at 120 bpm, 100 px/sec", () => {
      expect(pixelToBeat(0, 120, 100)).toBe(0);
      expect(pixelToBeat(100, 120, 100)).toBeCloseTo(2, 3);
      expect(pixelToBeat(200, 120, 100)).toBeCloseTo(4, 3);
    });

    it("handles zero/negative/infinite edges safely", () => {
      expect(beatToPixel(-5, 120, 100)).toBe(0);
      expect(beatToPixel(NaN, 120, 100)).toBe(0);
      expect(pixelToBeat(-10, 120, 100)).toBe(0);
      expect(pixelToBeat(NaN, 120, 100)).toBe(0);
    });
  });

  describe("value <-> pixel conversions", () => {
    it("converts normalized values to Y coordinates (inverted Y)", () => {
      const height = 100;
      // Max value (1.0) is at top Y = 0
      expect(valueToPixel(1.0, height, 0, 1)).toBeCloseTo(0, 3);
      // Min value (0.0) is at bottom Y = 100
      expect(valueToPixel(0.0, height, 0, 1)).toBeCloseTo(100, 3);
      // Mid value (0.5) is at Y = 50
      expect(valueToPixel(0.5, height, 0, 1)).toBeCloseTo(50, 3);
    });

    it("converts pixel Y coordinates to values", () => {
      const height = 100;
      expect(pixelToValue(0, height, 0, 1)).toBeCloseTo(1.0, 3);
      expect(pixelToValue(100, height, 0, 1)).toBeCloseTo(0.0, 3);
      expect(pixelToValue(50, height, 0, 1)).toBeCloseTo(0.5, 3);
    });

    it("handles decibel ranges correctly", () => {
      const height = 100;
      const minDb = -60;
      const maxDb = 12;
      // maxDb at top (0 px)
      expect(valueToPixel(12, height, minDb, maxDb)).toBeCloseTo(0, 3);
      // minDb at bottom (100 px)
      expect(valueToPixel(-60, height, minDb, maxDb)).toBeCloseTo(100, 3);
    });
  });

  describe("curve evaluation (evaluateCurve)", () => {
    it("matches linear when curve is 0", () => {
      expect(evaluateCurve(0, 0)).toBe(0);
      expect(evaluateCurve(0.5, 0)).toBeCloseTo(0.5, 5);
      expect(evaluateCurve(1, 0)).toBe(1);
    });

    it("evaluates concave/exponential when curve < 0", () => {
      // curve = -1 => exp = 2^(-(-1)*2) = 2^2 = 4.
      // u = 0.5 => 0.5^4 = 0.0625
      expect(evaluateCurve(0.5, -1)).toBeCloseTo(0.0625, 4);
    });

    it("evaluates convex/logarithmic when curve > 0", () => {
      // curve = +1 => exp = 2^(-1*2) = 2^(-2) = 0.25.
      // u = 0.5 => 0.5^0.25 ≈ 0.840896
      expect(evaluateCurve(0.5, 1)).toBeCloseTo(Math.pow(0.5, 0.25), 4);
    });

    it("clamps u to [0, 1] and curve to [-1, 1]", () => {
      expect(evaluateCurve(-0.5, 0)).toBe(0);
      expect(evaluateCurve(1.5, 0)).toBe(1);
      expect(evaluateCurve(0.5, 5)).toBeCloseTo(evaluateCurve(0.5, 1), 5);
      expect(evaluateCurve(0.5, -5)).toBeCloseTo(evaluateCurve(0.5, -1), 5);
    });
  });

  describe("interpolateAutomationValue", () => {
    const p1: AutomationPointViewModel = { timeBeats: 0, value: 0, curve: 0 };
    const p2: AutomationPointViewModel = { timeBeats: 4, value: 1, curve: 0 };

    it("interpolates linearly when curve = 0", () => {
      expect(interpolateAutomationValue(p1, p2, 0)).toBe(0);
      expect(interpolateAutomationValue(p1, p2, 2)).toBeCloseTo(0.5, 4);
      expect(interpolateAutomationValue(p1, p2, 4)).toBe(1);
    });

    it("clamps outside bounds", () => {
      expect(interpolateAutomationValue(p1, p2, -2)).toBe(0);
      expect(interpolateAutomationValue(p1, p2, 10)).toBe(1);
    });

    it("respects curvature between points", () => {
      const pCurved: AutomationPointViewModel = { timeBeats: 0, value: 0, curve: -1 };
      // at mid-time (t = 2), u = 0.5, with curve = -1 value is 0.0625
      expect(interpolateAutomationValue(pCurved, p2, 2)).toBeCloseTo(0.0625, 4);
    });
  });

  describe("getCurveHandlePosition", () => {
    it("returns handle at midpoint of segment", () => {
      const p1: AutomationPointViewModel = { timeBeats: 0, value: 0, curve: 0 };
      const p2: AutomationPointViewModel = { timeBeats: 4, value: 1, curve: 0 };
      const handle = getCurveHandlePosition(p1, p2, 120, 100, 100);
      expect(handle.u).toBe(0.5);
      expect(handle.timeBeats).toBe(2);
      expect(handle.value).toBeCloseTo(0.5, 3);
      expect(handle.y).toBeCloseTo(50, 3);
    });
  });

  describe("buildAutomationSvgPaths", () => {
    it("generates stroke and closed fill paths", () => {
      const points: AutomationPointViewModel[] = [
        { timeBeats: 0, value: 0.2, curve: 0 },
        { timeBeats: 2, value: 0.8, curve: 0.5 },
        { timeBeats: 4, value: 0.5, curve: 0 },
      ];
      const { strokePath, fillPath } = buildAutomationSvgPaths(
        points,
        120,
        100,
        100,
        500,
      );
      expect(strokePath).toContain("M ");
      expect(strokePath).toContain("L ");
      expect(fillPath).toContain(" Z");
    });

    it("handles empty point list gracefully", () => {
      const { strokePath, fillPath } = buildAutomationSvgPaths(
        [],
        120,
        100,
        100,
        300,
      );
      expect(strokePath).toContain("M 0");
      expect(fillPath).toContain("Z");
    });
  });

  describe("hitTestAutomation", () => {
    const points: AutomationPointViewModel[] = [
      { timeBeats: 0, value: 0, curve: 0 },
      { timeBeats: 4, value: 1, curve: 0 },
    ];

    it("detects direct hit on a point", () => {
      // p1 is at beat 0, value 0 => x=0, y=100
      const hit = hitTestAutomation(points, 120, 100, 100, 2, 98, 10);
      expect(hit.type).toBe("point");
      if (hit.type === "point") {
        expect(hit.pointIndex).toBe(0);
      }
    });

    it("detects curve handle hit at midpoint", () => {
      // Midpoint: beat 2 (x=100), value 0.5 (y=50)
      const hit = hitTestAutomation(points, 120, 100, 100, 100, 50, 10);
      expect(hit.type).toBe("curveHandle");
    });

    it("skips curve handle in compact lanes (<= 32px)", () => {
      // In a 24px compact lane, curve handle should not be hit
      const hit = hitTestAutomation(points, 120, 100, 24, 100, 12, 10);
      expect(hit.type).not.toBe("curveHandle");
    });

    it("detects segment hit when clicking near line", () => {
      // At x=50 (beat 1, value 0.25 => y=75)
      const hit = hitTestAutomation(points, 120, 100, 100, 50, 74, 5, 8);
      expect(hit.type).toBe("segment");
    });

    it("returns none when clicking far away", () => {
      const hit = hitTestAutomation(points, 120, 100, 100, 50, 10, 5, 5);
      expect(hit.type).toBe("none");
    });
  });

  describe("decimatePointsForViewport", () => {
    it("preserves all points when below threshold", () => {
      const points: AutomationPointViewModel[] = [
        { timeBeats: 1, value: 0.1, curve: 0 },
        { timeBeats: 2, value: 0.9, curve: 0 },
      ];
      const decimated = decimatePointsForViewport(points, 120, 100, 0, 500, 100);
      expect(decimated.length).toBe(2);
    });

    it("decimates dense points while retaining extrema and boundaries", () => {
      const dense: AutomationPointViewModel[] = [];
      for (let i = 0; i < 200; i++) {
        dense.push({
          timeBeats: i * 0.1,
          value: Math.sin(i * 0.2) * 0.5 + 0.5,
          curve: 0,
        });
      }
      const decimated = decimatePointsForViewport(dense, 120, 100, 0, 1000, 50);
      expect(decimated.length).toBeLessThanOrEqual(75);
      expect(decimated.length).toBeGreaterThan(10);
    });
  });
});
