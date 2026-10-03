/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  automationGestureRecoveryLimits,
  loadAutomationGestureDrafts,
  persistAutomationGestureDrafts,
  removeAutomationGestureDraft,
  type AutomationGestureRecoveryDraft,
} from "../automationGestureRecovery";

const payload = {
  laneId: "lane-a",
  writeMode: "touch" as const,
  punchInBeats: 1,
  releaseBeats: 2,
  releaseValue: 0.5,
  returnRampBeats: 0,
  underlyingValue: 0,
  points: [{ timeBeats: 1, value: 0.5 }],
  pointsCompacted: false,
  gestureId: "gesture-a",
  shouldRevertWriteMode: false,
};

function draft(id: string, overrides: Partial<AutomationGestureRecoveryDraft> = {}): AutomationGestureRecoveryDraft {
  return {
    id,
    projectIdentity: "core-session:2",
    songIndex: 0,
    createdAt: 123,
    outcome: "unknown",
    error: "The command outcome is unknown",
    payload: { ...payload, gestureId: id },
    persisted: false,
    ...overrides,
  };
}

describe("automation gesture recovery storage", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips bounded gesture data and marks it as durable", () => {
    const drafts = [draft("gesture-one"), draft("gesture-two", { outcome: "rejected" })];

    expect(persistAutomationGestureDrafts(drafts)).toBe(true);
    expect(loadAutomationGestureDrafts()).toEqual(drafts.map((entry) => ({
      ...entry,
      persisted: true,
    })));
  });

  it("rejects malformed or oversized stored records instead of trusting them", () => {
    sessionStorage.setItem("resostage:automation-gesture-recovery:v1", JSON.stringify([
      { ...draft("broken"), payload: { ...payload, points: [{ timeBeats: 0, value: null }] } },
      draft("valid"),
    ]));

    expect(loadAutomationGestureDrafts().map((entry) => entry.id)).toEqual(["valid"]);
    expect(persistAutomationGestureDrafts([draft("too-large", { error: "x".repeat(
      automationGestureRecoveryLimits.storedBytes,
    ) })])).toBe(false);
  });

  it("enforces the draft count and removes only the explicitly dismissed record", () => {
    const drafts = Array.from({ length: automationGestureRecoveryLimits.drafts + 1 }, (_, index) =>
      draft(`gesture-${index}`));

    expect(persistAutomationGestureDrafts(drafts)).toBe(false);
    expect(removeAutomationGestureDraft(drafts, "gesture-1").map((entry) => entry.id))
      .toEqual(["gesture-0", "gesture-2", "gesture-3", "gesture-4"]);
  });
});
