/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "@/components/ui/Button";
import { ToggleButton } from "@/components/ui/ToggleButton";
import { TrackStateButtons } from "@/components/daw/TrackStateButtons";
import type { TrackRow } from "@/lib/state/types";

describe("DAW Focus Isolation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("Button defaults to tabIndex -1 and prevents focus stealing on mousedown", () => {
    act(() => {
      root.render(createElement(Button, {}, "Mute"));
    });

    const button = container.querySelector("button")!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("tabindex")).toBe("-1");

    const mousedownEvent = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(mousedownEvent);
    expect(mousedownEvent.defaultPrevented).toBe(true);
  });

  it("ToggleButton defaults to tabIndex -1 and prevents focus stealing on mousedown", () => {
    act(() => {
      root.render(createElement(ToggleButton, { id: "toggle" }, "Solo"));
    });

    const button = container.querySelector("button")!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("tabindex")).toBe("-1");

    const mousedownEvent = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(mousedownEvent);
    expect(mousedownEvent.defaultPrevented).toBe(true);
  });

  it("honors explicitly provided tabIndex if specified", () => {
    act(() => {
      root.render(createElement(Button, { tabIndex: 0 }, "Accessible Button"));
    });

    const button = container.querySelector("button")!;
    expect(button.getAttribute("tabindex")).toBe("0");

    const mousedownEvent = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(mousedownEvent);
    // When explicitly focusable, default is not prevented
    expect(mousedownEvent.defaultPrevented).toBe(false);
  });

  it("TrackStateButtons have tabIndex -1 and prevent focus stealing on mousedown", () => {
    const dummyTrack = {
      id: "trk-1",
      name: "Lead Synth",
      kind: "instrument",
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      soloSafe: false,
      recordArmed: false,
      inputMonitoring: false,
      peakL: 0,
      peakR: 0,
    } as unknown as TrackRow;

    act(() => {
      root.render(createElement(TrackStateButtons, { track: dummyTrack, index: 0 }));
    });

    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(4);

    for (const btn of buttons) {
      expect(btn.getAttribute("tabindex")).toBe("-1");

      const mousedownEvent = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      btn.dispatchEvent(mousedownEvent);
      expect(mousedownEvent.defaultPrevented).toBe(true);
    }
  });
});
