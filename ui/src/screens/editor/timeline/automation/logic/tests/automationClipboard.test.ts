/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAutomationClipboard,
  getAutomationClipboard,
  hasAutomationClipboard,
  setAutomationClipboard,
} from "@/screens/editor/timeline/automation/logic/automationClipboard";
import {
  copySelectedAutomationPoints,
  duplicateAutomationSelection,
  pasteAutomationClipboard,
} from "@/screens/editor/timeline/automation/logic/automationEditing";
import type { AutomationPointViewModel } from "@/screens/editor/timeline/automation/logic/types";

const point = (timeBeats: number, value: number, curve = 0): AutomationPointViewModel => ({
  timeBeats,
  value,
  curve,
});

describe("automationClipboard storage", () => {
  beforeEach(() => {
    clearAutomationClipboard();
  });

  it("manages global clipboard state and predicate correctly", () => {
    expect(hasAutomationClipboard()).toBe(false);
    expect(getAutomationClipboard()).toBeNull();

    setAutomationClipboard({
      spanBeats: 4,
      points: [
        { offsetBeats: 0, value: 0.2, curve: 0 },
        { offsetBeats: 4, value: 0.8, curve: 0.5 },
      ],
      sourceDomain: "strip",
      sourceParameterId: "faderGainDb",
    });

    expect(hasAutomationClipboard()).toBe(true);
    const clip = getAutomationClipboard();
    expect(clip).not.toBeNull();
    expect(clip?.spanBeats).toBe(4);
    expect(clip?.points).toHaveLength(2);
    expect(clip?.sourceDomain).toBe("strip");
    expect(clip?.sourceParameterId).toBe("faderGainDb");

    clearAutomationClipboard();
    expect(hasAutomationClipboard()).toBe(false);
    expect(getAutomationClipboard()).toBeNull();
  });
});

describe("copySelectedAutomationPoints", () => {
  it("returns null when selection is empty", () => {
    const points = [point(0, 0.1), point(2, 0.5)];
    expect(copySelectedAutomationPoints(points, new Set())).toBeNull();
    expect(copySelectedAutomationPoints(points, new Set([99]))).toBeNull();
  });

  it("normalizes point offsets relative to the earliest selected beat", () => {
    const points = [
      point(0, 0.1),
      point(4, 0.2, 0.3),
      point(6, 0.8, -0.4),
      point(8, 0.5),
      point(10, 0.9),
    ];
    // Select indices 1, 2, 3 (beats 4, 6, 8)
    const clip = copySelectedAutomationPoints(points, new Set([1, 2, 3]), {
      domain: "send",
      parameterId: "sendGainDb",
    });

    expect(clip).not.toBeNull();
    expect(clip?.spanBeats).toBe(4); // 8 - 4
    expect(clip?.points).toEqual([
      { offsetBeats: 0, value: 0.2, curve: 0.3 },
      { offsetBeats: 2, value: 0.8, curve: -0.4 },
      { offsetBeats: 4, value: 0.5, curve: 0 },
    ]);
    expect(clip?.sourceDomain).toBe("send");
    expect(clip?.sourceParameterId).toBe("sendGainDb");
  });

  it("handles single-point selection with 0 span", () => {
    const points = [point(5, 0.75, 0.2)];
    const clip = copySelectedAutomationPoints(points, new Set([0]));
    expect(clip).not.toBeNull();
    expect(clip?.spanBeats).toBe(0);
    expect(clip?.points).toEqual([{ offsetBeats: 0, value: 0.75, curve: 0.2 }]);
  });
});

describe("pasteAutomationClipboard", () => {
  it("pastes clipboard at target beat offset and replaces underlying points within span", () => {
    const existing = [
      point(0, 0.1),
      point(2, 0.3),
      point(4, 0.4),
      point(6, 0.6),
      point(10, 0.9),
    ];
    const clip = {
      spanBeats: 3,
      points: [
        { offsetBeats: 0, value: 0.7, curve: 0.1 },
        { offsetBeats: 3, value: 0.2, curve: -0.1 },
      ],
    };

    // Paste at beat 3: range [3, 6] should replace point at beat 4 and point at beat 6
    const result = pasteAutomationClipboard(existing, clip, 3, 0, 1);
    expect(result.points).toEqual([
      point(0, 0.1),
      point(2, 0.3),
      point(3, 0.7, 0.1),
      point(6, 0.2, -0.1),
      point(10, 0.9),
    ]);
    expect(result.newIndices.has(2)).toBe(true); // beat 3
    expect(result.newIndices.has(3)).toBe(true); // beat 6
  });

  it("clamps values and curves within specified bounds", () => {
    const existing = [point(0, 0)];
    const clip = {
      spanBeats: 2,
      points: [
        { offsetBeats: 0, value: 1.5, curve: 3 },
        { offsetBeats: 2, value: -0.5, curve: -5 },
      ],
    };
    const result = pasteAutomationClipboard(existing, clip, 4, 0, 1);
    expect(result.points[1]).toEqual(point(4, 1, 1));
    expect(result.points[2]).toEqual(point(6, 0, -1));
  });

  it("returns unchanged points and empty selection for empty clipboard", () => {
    const existing = [point(1, 0.5)];
    const clip = { spanBeats: 0, points: [] };
    const result = pasteAutomationClipboard(existing, clip, 2);
    expect(result.points).toBe(existing);
    expect(result.newIndices.size).toBe(0);
  });
});

describe("duplicateAutomationSelection", () => {
  it("duplicates selection shifted by grid-aligned span", () => {
    const existing = [
      point(0, 0.1),
      point(1, 0.3),
      point(3, 0.8),
      point(8, 0.2),
    ];
    // Select indices 1 and 2 (beats 1 to 3, span 2). Grid step = 1
    const result = duplicateAutomationSelection(existing, new Set([1, 2]), 1);
    expect(result).not.toBeNull();
    // Shift is ceil(2 / 1) * 1 = 2 beats. Target is 1 + 2 = 3 beats.
    // Pasting at 3 to 5: replaces existing beat 3.
    expect(result?.points).toEqual([
      point(0, 0.1),
      point(1, 0.3),
      point(3, 0.3),
      point(5, 0.8),
      point(8, 0.2),
    ]);
    // The newly pasted points (at beat 3 and 5) are selected
    expect(result?.newIndices.size).toBe(2);
  });

  it("duplicates a single point by shifting by one grid step", () => {
    const existing = [point(2, 0.5)];
    const result = duplicateAutomationSelection(existing, new Set([0]), 2);
    expect(result).not.toBeNull();
    // Span is 0 -> shift is gridStepBeats = 2. Destination = 4.
    expect(result?.points).toEqual([point(2, 0.5), point(4, 0.5)]);
    expect(result?.newIndices.size).toBe(1);
  });

  it("returns null if selection is empty", () => {
    const existing = [point(0, 0)];
    expect(duplicateAutomationSelection(existing, new Set())).toBeNull();
  });
});
