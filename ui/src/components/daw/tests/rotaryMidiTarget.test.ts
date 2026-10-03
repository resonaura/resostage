/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { rotaryMidiTarget } from "@/components/daw/logic/rotaryMidiTarget";

describe("rotary MIDI targets", () => {
  it("uses stable project entity IDs for continuous pan and send controls", () => {
    expect(rotaryMidiTarget.trackPan("audio::track:1")).toBe("track_pan:audio::track:1");
    expect(rotaryMidiTarget.busPan("audio::send:2")).toBe("bus_pan:audio::send:2");
    expect(rotaryMidiTarget.trackSend("audio::track:1", "audio::send:2"))
      .toBe("track_send:audio::track:1|audio::send:2");
    expect(rotaryMidiTarget.clickSend("audio::send:2")).toBe("click_send:audio::send:2");
  });

  it("provides only the fixed continuous singleton actions", () => {
    expect(rotaryMidiTarget.masterPan()).toBe("master_pan");
    expect(rotaryMidiTarget.clickPan()).toBe("click_pan");
  });

  it("rejects ambiguous or missing identities", () => {
    expect(() => rotaryMidiTarget.trackPan("")).toThrow();
    expect(() => rotaryMidiTarget.trackSend("audio::track:1|x", "audio::send:1")).toThrow();
  });
});
