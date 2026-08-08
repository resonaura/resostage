import { describe, expect, it } from "vitest";

import { gateKnobMove, knobValueAt } from "./knobDrag";

describe("gateKnobMove", () => {
  const held = { pointerId: 1, buttons: 1 };

  it("ignores everything when no drag is armed", () => {
    // The bug this guards: a knob left armed by a missed pointerup used to
    // turn on plain hover, so the knob that moved was not the one touched.
    expect(gateKnobMove(null, held)).toBe("ignore");
  });

  it("ignores a pointer that does not own the drag", () => {
    // Two-pointer isolation: a second finger/stylus must not drive a knob
    // another pointer is already holding.
    expect(gateKnobMove(1, { pointerId: 2, buttons: 1 })).toBe("ignore");
  });

  it("applies moves from the owning pointer", () => {
    expect(gateKnobMove(1, held)).toBe("apply");
  });

  it("aborts when the owning pointer reports no buttons held", () => {
    // A pointerup that never arrived (released outside the window, eaten by a
    // context menu, Electron blur).
    expect(gateKnobMove(1, { pointerId: 1, buttons: 0 })).toBe("abort");
  });

  it("still ignores a foreign pointer that has no buttons held", () => {
    // Order matters: ownership is checked before the buttons self-heal, so a
    // stray hover from another pointer cannot abort someone else's drag.
    expect(gateKnobMove(1, { pointerId: 2, buttons: 0 })).toBe("ignore");
  });
});

describe("knobValueAt", () => {
  const base = {
    startValue: 0,
    startY: 100,
    min: -1,
    max: 1,
    sensitivityPx: 120,
  };

  it("does not move the value without vertical travel", () => {
    expect(knobValueAt({ ...base, clientY: 100 })).toBe(0);
  });

  it("increases as the pointer moves up", () => {
    // 60px up over a 2.0 range at 120px full sweep = +1.0.
    expect(knobValueAt({ ...base, clientY: 40 })).toBeCloseTo(1, 6);
  });

  it("decreases as the pointer moves down", () => {
    expect(knobValueAt({ ...base, clientY: 130 })).toBeCloseTo(-0.5, 6);
  });

  it("clamps to the range however far the drag runs", () => {
    expect(knobValueAt({ ...base, clientY: -10000 })).toBe(1);
    expect(knobValueAt({ ...base, clientY: 10000 })).toBe(-1);
  });

  it("is measured from the value the drag started at, not from zero", () => {
    // Sensitivity must not depend on where in the range you grabbed it.
    const from = knobValueAt({ ...base, startValue: -1, clientY: 40 });
    expect(from).toBeCloseTo(0, 6);
  });

  it("honours an asymmetric range like the send knob's -60..0 dB", () => {
    const db = {
      startValue: -60,
      startY: 200,
      min: -60,
      max: 0,
      sensitivityPx: 120,
    };
    expect(knobValueAt({ ...db, clientY: 200 })).toBe(-60);
    expect(knobValueAt({ ...db, clientY: 140 })).toBeCloseTo(-30, 6);
    expect(knobValueAt({ ...db, clientY: 80 })).toBe(0);
  });
});
