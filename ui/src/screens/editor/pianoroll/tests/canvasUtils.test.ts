import { describe, expect, it } from "vitest";
import {
  controllerValueFromY,
  controllerYFromValue,
  isControllerLane,
  noteTextColor,
} from "@/screens/editor/pianoroll/logic/canvasUtils";

describe("piano roll canvas utilities", () => {
  it("chooses readable text against the velocity-tinted note color", () => {
    expect(noteTextColor("#ffffff", "#111111", 1)).toBe("#111");
    expect(noteTextColor("#102030", "#111111", 1)).toBe("#fff");
    expect(noteTextColor("invalid", "#111111", 1)).toBe("#fff");
  });

  it("maps controller coordinates to bounded MIDI values and back", () => {
    const gridBottom = 200;
    const height = 320;
    expect(controllerValueFromY(218, gridBottom, height, false)).toBe(127);
    expect(controllerValueFromY(314, gridBottom, height, false)).toBe(0);
    expect(controllerYFromValue(127, gridBottom, height, false)).toBe(218);
    expect(controllerYFromValue(0, gridBottom, height, false)).toBe(314);
    expect(controllerValueFromY(-100, gridBottom, height, true)).toBe(8191);
    expect(controllerValueFromY(1000, gridBottom, height, true)).toBe(-8192);
  });

  it("matches both canonical and legacy controller lane ids", () => {
    const makeLane = (parameterId: string) =>
      ({ target: { parameterId } }) as Parameters<typeof isControllerLane>[0];
    expect(isControllerLane(makeLane("cc:1"), "cc1")).toBe(true);
    expect(isControllerLane(makeLane("1"), "cc1")).toBe(true);
    expect(isControllerLane(makeLane("pitchBend"), "pitchBend")).toBe(true);
    expect(isControllerLane(makeLane("cc:1"), "pitchBend")).toBe(false);
  });
});
