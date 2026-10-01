/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  getVerticalDragValue,
  type VerticalValueDragOptions,
} from "@/screens/mixer/strips/logic/verticalValueDrag";

const trimOptions: VerticalValueDragOptions = {
  min: -24,
  max: 24,
  sensitivity: 0.15,
  step: 0.1,
  fineSensitivity: 0.02,
  fineStep: 0.05,
  precision: 2,
};

const panOptions: VerticalValueDragOptions = {
  min: -1,
  max: 1,
  sensitivity: 0.01,
  step: 0.05,
  fineSensitivity: 0.01,
  fineStep: 0.01,
};

describe("vertical mixer value drag", () => {
  it("uses the configured sensitivity and step for input trim", () => {
    expect(getVerticalDragValue(0, 20, false, trimOptions)).toBe(3);
    expect(getVerticalDragValue(0, 20, true, trimOptions)).toBe(0.4);
  });

  it("uses coarse and fine pan steps and clamps to the pan range", () => {
    expect(getVerticalDragValue(0, 18, false, panOptions)).toBe(0.2);
    expect(getVerticalDragValue(0, 18, true, panOptions)).toBe(0.18);
    expect(getVerticalDragValue(0.95, 30, false, panOptions)).toBe(1);
    expect(getVerticalDragValue(-0.95, -30, false, panOptions)).toBe(-1);
  });

  it("keeps trim within its configured dB range", () => {
    expect(getVerticalDragValue(23, 100, false, trimOptions)).toBe(24);
    expect(getVerticalDragValue(-23, -100, false, trimOptions)).toBe(-24);
  });
});
