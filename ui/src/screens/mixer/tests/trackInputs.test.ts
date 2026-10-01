// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { describe, expect, it } from "vitest";
import {
  getTrackInputOptions,
  getTrackInputState,
} from "@/screens/mixer/logic/trackInputs";

describe("track input state", () => {
  it.each(["instrument", "midi", "externalMidi"] as const)(
    "allows record and monitor for %s tracks",
    (kind) => {
      expect(
        getTrackInputState({ kind, channels: 2, inputSource: "none" }),
      ).toMatchObject({
        canRecord: true,
        canMonitorInput: true,
      });
    },
  );

  it("disables input record and monitor for audio tracks routed to no input", () => {
    expect(
      getTrackInputState({ kind: "audio", channels: 2, inputSource: "none" }),
    ).toMatchObject({ canRecord: false, canMonitorInput: false });
  });

  it("keeps legacy audio rows with no kind recordable when an input is available", () => {
    expect(
      getTrackInputState({ channels: 2, inputSource: undefined }),
    ).toMatchObject({ canRecord: true, canMonitorInput: true });
  });

  it("uses channel count and current input to choose the default source", () => {
    expect(
      getTrackInputState({ kind: "audio", channels: 1, inputSource: "" }),
    ).toMatchObject({ isMono: true, currentInput: "in:1" });
    expect(
      getTrackInputState({ kind: "audio", channels: 2, inputSource: undefined }),
    ).toMatchObject({ isMono: false, currentInput: "in:1+2" });
    expect(
      getTrackInputState({ kind: "audio", channels: 2, inputSource: "in:3" }),
    ).toMatchObject({ currentInput: "in:3" });
  });
});

describe("track input options", () => {
  it("lists all named hardware inputs for mono tracks with a fallback", () => {
    expect(
      getTrackInputOptions({
        isMono: true,
        inputChannelNames: ["Vocal Mic", "", "Room"],
        allBusses: [],
      }),
    ).toEqual([
      { id: "in:1", label: "Vocal Mic" },
      { id: "in:2", label: "In 2" },
      { id: "in:3", label: "Room" },
      { id: "none", label: "No In" },
    ]);
    expect(
      getTrackInputOptions({
        isMono: true,
        inputChannelNames: [],
        allBusses: [],
      }).map(({ id }) => id),
    ).toEqual(["in:1", "in:2", "none"]);
  });

  it("offers stereo pairs and spread inputs, adding a second pair for 4+ channels", () => {
    const options = getTrackInputOptions({
      isMono: false,
      inputChannelNames: ["A", "B", "C", "D"],
      allBusses: [],
    });

    expect(options).toEqual([
      { id: "in:1+2", label: "In 1+2" },
      { id: "in:3+4", label: "In 3+4" },
      { id: "in:1", label: "In 1 (Spread)" },
      { id: "in:2", label: "In 2 (Spread)" },
      { id: "none", label: "No In" },
    ]);
  });

  it("appends bus routes and the no-input option", () => {
    expect(
      getTrackInputOptions({
        isMono: false,
        allBusses: [
          { id: "main", name: "" },
          { id: "send-1", name: "Reverb" },
        ],
      }).slice(-3),
    ).toEqual([
      { id: "bus:main", label: "Bus 1: main" },
      { id: "bus:send-1", label: "Bus 2: Reverb" },
      { id: "none", label: "No In" },
    ]);
  });
});
