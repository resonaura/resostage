import { describe, expect, it } from "vitest";
import {
  sameDeviceSelection,
  toggleDeviceSelection,
  toggleMidiInputSelection,
} from "../logic/deviceSelection";

describe("MIDI device selections", () => {
  it("toggles individual endpoints without dropping other selections", () => {
    expect(toggleDeviceSelection(["Keyboard", "Pad"], "Footswitch")).toEqual([
      "Keyboard",
      "Pad",
      "Footswitch",
    ]);
    expect(toggleDeviceSelection(["Keyboard", "Pad"], "Keyboard")).toEqual([
      "Pad",
    ]);
  });

  it("keeps All Inputs exclusive from individually selected inputs", () => {
    expect(toggleMidiInputSelection(["Keyboard"], "All Inputs")).toEqual([
      "All Inputs",
    ]);
    expect(toggleMidiInputSelection(["All Inputs"], "Keyboard")).toEqual([
      "Keyboard",
    ]);
    expect(toggleMidiInputSelection(["All Inputs"], "All Inputs")).toEqual(
      [],
    );
  });

  it("compares persisted selections in their ordered form", () => {
    expect(sameDeviceSelection(["Keyboard", "Pad"], ["Keyboard", "Pad"])).toBe(
      true,
    );
    expect(sameDeviceSelection(["Keyboard", "Pad"], ["Pad", "Keyboard"])).toBe(
      false,
    );
  });
});
