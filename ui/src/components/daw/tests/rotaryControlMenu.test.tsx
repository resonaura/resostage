/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RotaryControlMenu } from "@/components/daw/RotaryControlMenu";
import { settings } from "@/lib/state/api";
import { rotaryMidiTarget } from "@/components/daw/logic/rotaryMidiTarget";

describe("RotaryControlMenu", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onClose = vi.fn();
  const onReset = vi.fn();

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onClose.mockClear();
    onReset.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.querySelectorAll('[data-has-checkable="0"]').forEach((node) => node.remove());
  });

  function render(midiTarget?: ReturnType<typeof rotaryMidiTarget.trackPan>) {
    act(() => root.render(createElement(RotaryControlMenu, {
      x: 24,
      y: 24,
      onClose,
      onReset,
      midiTarget,
    })));
  }

  it("resets the declared default from the shared right-click menu", () => {
    render();
    const reset = [...document.body.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent?.includes("Reset to Default")) as HTMLButtonElement;
    expect(reset).toBeDefined();
    act(() => reset.click());
    expect(onReset).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("MIDI Learn…");
  });

  it("arms and clears only the eligible continuous target", () => {
    const learn = vi.spyOn(settings, "midiLearn").mockResolvedValue(undefined);
    const clear = vi.spyOn(settings, "midiClear").mockResolvedValue(undefined);
    const target = rotaryMidiTarget.trackPan("audio::track:1");
    render(target);

    const items = [...document.body.querySelectorAll('[role="menuitem"]')];
    const learnItem = items.find((item) => item.textContent?.includes("MIDI CC Learn")) as HTMLButtonElement;
    const clearItem = items.find((item) => item.textContent?.includes("Clear MIDI Binding")) as HTMLButtonElement;
    act(() => learnItem.click());
    act(() => clearItem.click());

    expect(learn).toHaveBeenCalledWith(target);
    expect(clear).toHaveBeenCalledWith(target);
    expect(onClose).toHaveBeenCalledTimes(2);
    learn.mockRestore();
    clear.mockRestore();
  });
});
