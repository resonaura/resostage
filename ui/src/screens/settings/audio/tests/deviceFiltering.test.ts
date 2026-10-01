/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  filterAudioDevices,
  isLikelyInputOnlyDevice,
  isLikelyOutputOnlyDevice,
} from "../logic/filterAudioDevices";

describe("deviceFiltering", () => {
  it("identifies likely input-only and output-only device names", () => {
    expect(isLikelyInputOnlyDevice("MacBook Pro Microphone")).toBe(true);
    expect(isLikelyInputOnlyDevice("External USB Mic")).toBe(true);
    expect(isLikelyInputOnlyDevice("iPhone Microphone")).toBe(true);
    expect(isLikelyInputOnlyDevice("MacBook Pro Speakers")).toBe(false);
    expect(isLikelyInputOnlyDevice("Scarlett 2i2")).toBe(false);

    expect(isLikelyOutputOnlyDevice("MacBook Pro Speakers")).toBe(true);
    expect(isLikelyOutputOnlyDevice("External Headphones")).toBe(true);
    expect(isLikelyOutputOnlyDevice("Line Out (1/2)")).toBe(true);
    expect(isLikelyOutputOnlyDevice("MacBook Pro Microphone")).toBe(false);
    expect(isLikelyOutputOnlyDevice("Scarlett 2i2")).toBe(false);
  });

  it("filters out input-only devices from output options", () => {
    const result = filterAudioDevices({
      outputDevices: ["MacBook Pro Microphone", "MacBook Pro Speakers", "External Headphones"],
      inputDevices: ["MacBook Pro Microphone"],
      currentOutputDevice: "MacBook Pro Microphone",
      currentInputDevice: "MacBook Pro Microphone",
    });

    expect(result.outputDevices).toEqual(["MacBook Pro Speakers", "External Headphones"]);
    expect(result.currentOutputDevice).toBe("MacBook Pro Speakers");
    expect(result.deviceOptions.map((o) => o.id)).toEqual([
      "MacBook Pro Speakers",
      "External Headphones",
    ]);

    expect(result.inputDevices).toEqual(["MacBook Pro Microphone"]);
    expect(result.currentInputDevice).toBe("MacBook Pro Microphone");
  });

  it("filters out output-only devices from input options", () => {
    const result = filterAudioDevices({
      outputDevices: ["MacBook Pro Speakers"],
      inputDevices: ["MacBook Pro Speakers", "MacBook Pro Microphone"],
      currentOutputDevice: "MacBook Pro Speakers",
      currentInputDevice: "MacBook Pro Speakers",
    });

    expect(result.inputDevices).toEqual(["MacBook Pro Microphone"]);
    expect(result.currentInputDevice).toBe("");
    expect(result.inputDeviceOptions.map((o) => o.id)).toEqual([
      "",
      "MacBook Pro Microphone",
    ]);
  });

  it("preserves duplex devices in both output and input lists", () => {
    const result = filterAudioDevices({
      outputDevices: ["Universal Audio Apollo", "MacBook Pro Speakers"],
      inputDevices: ["Universal Audio Apollo", "MacBook Pro Microphone"],
      currentOutputDevice: "Universal Audio Apollo",
      currentInputDevice: "Universal Audio Apollo",
    });

    expect(result.outputDevices).toEqual(["Universal Audio Apollo", "MacBook Pro Speakers"]);
    expect(result.inputDevices).toEqual(["Universal Audio Apollo", "MacBook Pro Microphone"]);
    expect(result.currentOutputDevice).toBe("Universal Audio Apollo");
    expect(result.currentInputDevice).toBe("Universal Audio Apollo");
  });

  it("handles missing or empty device arrays gracefully", () => {
    const result = filterAudioDevices({
      outputDevices: [],
      inputDevices: [],
      currentOutputDevice: "",
      currentInputDevice: "",
    });

    expect(result.outputDevices).toEqual([]);
    expect(result.inputDevices).toEqual([]);
    expect(result.currentOutputDevice).toBe("");
    expect(result.currentInputDevice).toBe("");
  });
});
