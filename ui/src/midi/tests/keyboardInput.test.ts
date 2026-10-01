/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendLiveMidi } from "@/lib/state/api";
import { useVirtualKeyboardInput } from "@/midi/hooks/useVirtualKeyboardInput";

vi.mock("../../lib/state/api", () => ({
  sendLiveMidi: vi.fn(),
}));

function Harness({ trackIndex }: { trackIndex: number }) {
  const [octave, setOctave] = useState(4);
  const [velocity] = useState(100);
  const input = useVirtualKeyboardInput({
    activeTrackIndex: trackIndex,
    isOpen: true,
    standalone: false,
    onClose: () => {},
    octave,
    setOctave,
    velocity,
  });

  return createElement(
    "div",
    {
      "data-active-notes": [...input.activeNotes].join(","),
      "data-sustain-down": String(input.isSustainDown),
    },
    createElement("button", {
      type: "button",
      "aria-label": "Release all notes",
      onClick: input.releaseAllNotes,
    }),
  );
}

describe("virtual MIDI keyboard input", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(Harness, { trackIndex: 2 })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("sends note on/off to the focused track and clears its visual state", () => {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyZ",
          key: "z",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(sendLiveMidi).toHaveBeenLastCalledWith(0x90, 60, 100, 2);
    expect(container.firstElementChild?.getAttribute("data-active-notes")).toBe("60");

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keyup", {
          code: "KeyZ",
          key: "z",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(sendLiveMidi).toHaveBeenLastCalledWith(0x80, 60, 0, 2);
    expect(container.firstElementChild?.getAttribute("data-active-notes")).toBe("");
  });

  it("releases a held note to its original track when focus changes", () => {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyZ",
          key: "z",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    act(() => root.render(createElement(Harness, { trackIndex: 4 })));

    expect(sendLiveMidi).toHaveBeenLastCalledWith(0x80, 60, 0, 2);
    expect(container.firstElementChild?.getAttribute("data-active-notes")).toBe("");
  });

  it("sends sustain pedal down/up and clears it when all notes are released", () => {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "Tab",
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(sendLiveMidi).toHaveBeenLastCalledWith(0xb0, 64, 127, 2);
    expect(container.firstElementChild?.getAttribute("data-sustain-down")).toBe("true");

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keyup", {
          code: "Tab",
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(sendLiveMidi).toHaveBeenLastCalledWith(0xb0, 64, 0, 2);
    expect(container.firstElementChild?.getAttribute("data-sustain-down")).toBe("false");
  });
});
