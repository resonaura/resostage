/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import type { AutomationLaneRow } from "@/lib/state/types";
import {
  AutomationTouchController,
  type AutomationGestureTarget,
  findRecordableLane,
  matchesGestureTarget,
} from "../automationTouchController";

describe("automationTouchController", () => {
  const baseLanes: AutomationLaneRow[] = [
    {
      id: "lane-read",
      target: {
        domain: "strip",
        entityId: "track-1",
        parameterId: "faderGainDb",
        valueType: "decibels",
        defaultValue: 0,
        minValue: -60,
        maxValue: 12,
      },
      scope: "track",
      enabled: true,
      writeMode: "read",
      points: [
        { timeBeats: 0, value: 0, curve: 0 },
        { timeBeats: 8, value: -6, curve: 0 },
      ],
    },
    {
      id: "lane-touch",
      target: {
        domain: "strip",
        entityId: "track-2",
        parameterId: "faderGainDb",
        valueType: "decibels",
        defaultValue: 0,
        minValue: -60,
        maxValue: 12,
      },
      scope: "track",
      enabled: true,
      writeMode: "touch",
      points: [
        { timeBeats: 0, value: 0, curve: 0 },
        { timeBeats: 10, value: 0, curve: 0 },
      ],
    },
    {
      id: "lane-latch",
      target: {
        domain: "strip",
        entityId: "track-3",
        parameterId: "pan",
        valueType: "floatNormalized",
        defaultValue: 0,
        minValue: -1,
        maxValue: 1,
      },
      scope: "track",
      enabled: true,
      writeMode: "latch",
      points: [{ timeBeats: 0, value: 0, curve: 0 }],
    },
    {
      id: "lane-write",
      target: {
        domain: "plugin",
        entityId: "plugin-slot-1",
        parameterId: "cutoff",
        valueType: "frequencyHz",
        defaultValue: 1000,
        minValue: 20,
        maxValue: 20000,
      },
      scope: "track",
      enabled: true,
      writeMode: "write",
      points: [],
    },
  ];

  describe("target matching and lane lookup", () => {
    it("matches strip gain aliases faderGainDb and gain", () => {
      const lane = baseLanes[1];
      expect(
        matchesGestureTarget(lane, {
          domain: "strip",
          entityId: "track-2",
          parameterId: "faderGainDb",
        }),
      ).toBe(true);
      expect(
        matchesGestureTarget(lane, {
          domain: "strip",
          entityId: "track-2",
          parameterId: "gain",
        }),
      ).toBe(true);
    });

    it("matches strip prefix audio::track:1 to track:1", () => {
      const lane: AutomationLaneRow = {
        ...baseLanes[1],
        target: { ...baseLanes[1].target, entityId: "audio::track:1" },
      };
      expect(
        matchesGestureTarget(lane, {
          domain: "strip",
          entityId: "track:1",
          parameterId: "gain",
        }),
      ).toBe(true);
    });

    it("finds recordable lane only when writeMode !== read", () => {
      const readTarget: AutomationGestureTarget = {
        domain: "strip",
        entityId: "track-1",
        parameterId: "faderGainDb",
      };
      expect(findRecordableLane(baseLanes, readTarget)).toBeUndefined();

      const touchTarget: AutomationGestureTarget = {
        domain: "strip",
        entityId: "track-2",
        parameterId: "gain",
      };
      const found = findRecordableLane(baseLanes, touchTarget);
      expect(found?.id).toBe("lane-touch");
    });
  });

  describe("live recording workflows", () => {
    it("returns null when attempting to start a gesture in read mode", () => {
      const controller = new AutomationTouchController();
      const session = controller.startGesture(
        { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" },
        0,
        2.0,
        baseLanes,
      );
      expect(session).toBeNull();
      expect(controller.isLaneActive("lane-read")).toBe(false);
    });

    it("executes Touch mode gesture with return ramp on finish", () => {
      const controller = new AutomationTouchController();
      const target: AutomationGestureTarget = {
        domain: "strip",
        entityId: "track-2",
        parameterId: "faderGainDb",
      };

      const session = controller.startGesture(target, 0, 2.0, baseLanes);
      expect(session).not.toBeNull();
      expect(session?.state).toBe("recording");
      expect(controller.isLaneActive("lane-touch")).toBe(true);

      controller.recordValue(target, -3.0, 3.0);
      controller.recordValue(target, -6.0, 4.0);

      const payload = controller.finishGesture(target, -6.0, 4.0, 1.0);
      expect(payload).not.toBeNull();
      expect(payload?.laneId).toBe("lane-touch");
      expect(payload?.punchInBeats).toBe(2.0);
      expect(payload?.releaseBeats).toBe(4.0);
      expect(payload?.releaseValue).toBe(-6.0);
      expect(payload?.returnRampBeats).toBe(1.0);
      expect(payload?.underlyingValue).toBe(0); // Ramp back to baseline 0 at 4 + 1 = 5 beats
      expect(payload?.shouldRevertWriteMode).toBe(false);
      expect(payload?.points.length).toBeGreaterThanOrEqual(3);
      expect(controller.isLaneActive("lane-touch")).toBe(false);
    });

    it("executes Latch mode gesture, holds state, and commits on punch-out", () => {
      const controller = new AutomationTouchController();
      const target: AutomationGestureTarget = {
        domain: "strip",
        entityId: "track-3",
        parameterId: "pan",
      };

      controller.startGesture(target, 0, 1.0, baseLanes);
      controller.recordValue(target, 0.5, 2.0);
      controller.recordValue(target, 0.8, 3.0);

      // Releasing fader in Latch mode does NOT commit yet; it holds latch
      const releasePayload = controller.finishGesture(target, 0.8, 3.0);
      expect(releasePayload).toBeNull();
      expect(controller.isLaneActive("lane-latch")).toBe(true);
      expect(controller.hasHoldingLatch()).toBe(true);

      // Punch out at beat 6.0
      const punchPayload = controller.punchOut("lane-latch", 6.0, 0.5);
      expect(punchPayload).not.toBeNull();
      expect(punchPayload?.punchInBeats).toBe(1.0);
      expect(punchPayload?.releaseBeats).toBe(6.0);
      expect(punchPayload?.releaseValue).toBe(0.8);
      expect(punchPayload?.returnRampBeats).toBe(0.5);
      expect(controller.isLaneActive("lane-latch")).toBe(false);
      expect(controller.hasHoldingLatch()).toBe(false);
    });

    it("executes Write mode gesture and signals safety revert to Touch", () => {
      const controller = new AutomationTouchController();
      const target: AutomationGestureTarget = {
        domain: "plugin",
        entityId: "plugin-slot-1",
        parameterId: "cutoff",
      };

      controller.startGesture(target, 1000, 0.0, baseLanes);
      controller.recordValue(target, 2500, 2.0);
      controller.recordValue(target, 5000, 4.0);

      const payload = controller.finishGesture(target, 5000, 4.0, 0.0);
      expect(payload).not.toBeNull();
      expect(payload?.laneId).toBe("lane-write");
      expect(payload?.writeMode).toBe("write");
      expect(payload?.shouldRevertWriteMode).toBe(true);
    });

    it("commits active and held gestures on transport stop", () => {
      const controller = new AutomationTouchController();
      const targetLatch: AutomationGestureTarget = {
        domain: "strip",
        entityId: "track-3",
        parameterId: "pan",
      };
      const targetTouch: AutomationGestureTarget = {
        domain: "strip",
        entityId: "track-2",
        parameterId: "gain",
      };

      controller.startGesture(targetLatch, 0, 1.0, baseLanes);
      controller.recordValue(targetLatch, 0.7, 2.0);
      controller.finishGesture(targetLatch, 0.7, 2.0); // enters holding_latch

      controller.startGesture(targetTouch, 0, 2.0, baseLanes);
      controller.recordValue(targetTouch, -2.0, 3.0); // still actively recording

      // Transport stops at beat 5.0
      const stopPayloads = controller.stopAll(5.0);
      expect(stopPayloads.length).toBe(2);
      expect(controller.hasHoldingLatch()).toBe(false);
      expect(controller.isLaneActive("lane-latch")).toBe(false);
      expect(controller.isLaneActive("lane-touch")).toBe(false);
    });

    it("splits at cycle right and continues at cycle left during cycle wrap", () => {
      const controller = new AutomationTouchController();
      const target: AutomationGestureTarget = {
        domain: "strip",
        entityId: "track-3",
        parameterId: "pan",
      };

      controller.startGesture(target, 0, 4.0, baseLanes);
      controller.recordValue(target, 0.6, 6.0);
      controller.finishGesture(target, 0.6, 6.0); // holding latch

      // Loop wrapped from 8.0 back to 0.0
      const wrapPayloads = controller.handleCycleWrap(0.0, 8.0);
      expect(wrapPayloads.length).toBe(1);
      expect(wrapPayloads[0].releaseBeats).toBe(8.0);
      expect(wrapPayloads[0].releaseValue).toBe(0.6);

      // Lane remains active at cycle left (0.0) holding the same value (0.6)
      expect(controller.isLaneActive("lane-latch")).toBe(true);
      expect(controller.hasHoldingLatch()).toBe(true);

      // Punch out at beat 2.0 in the second pass
      const punchPayload = controller.punchOut("lane-latch", 2.0);
      expect(punchPayload?.punchInBeats).toBe(0.0);
      expect(punchPayload?.releaseBeats).toBe(2.0);
      expect(punchPayload?.releaseValue).toBe(0.6);
    });
  });
});
