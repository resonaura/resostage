/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MidiUmpEventRow } from "@/lib/state/types";
import { PianoRollUmpControllerEditor } from "@/screens/editor/pianoroll/components/PianoRollUmpControllerEditor";

describe("Piano Roll MIDI 2.0 controller editor", () => {
  let root: Root;
  let container: HTMLDivElement;
  let save: ReturnType<typeof vi.fn<(events: MidiUmpEventRow[]) => void>>;

  function Harness({ events }: { events: MidiUmpEventRow[] }) {
    const [isOpen, setIsOpen] = useState(false);
    return createElement("div", null,
      createElement("button", { "aria-label": "Open controller editor", onClick: () => setIsOpen(true) }),
      createElement(PianoRollUmpControllerEditor, {
        events,
        defaultBeat: 4,
        onSave: save,
        isOpen,
        onOpenChange: setIsOpen,
      }),
    );
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    save = vi.fn<(events: MidiUmpEventRow[]) => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (events: MidiUmpEventRow[] = []) => act(() => root.render(
    createElement(Harness, { events }),
  ));

  it("adds a typed MIDI 2.0 CC packet in the project-themed modal", async () => {
    render();
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open controller editor"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    const addCc = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Add CC"));
    expect(addCc).toBeDefined();
    await act(async () => addCc?.click());
    const saveButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Save MIDI 2.0 events"));
    await act(async () => saveButton?.click());

    expect(save).toHaveBeenCalledWith([{
      beat: 4,
      wordCount: 2,
      words: [0x40b00100, 0],
    }]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not overwrite a region changed while the dialog is open", async () => {
    const initial = [{ beat: 1, wordCount: 2, words: [0x40b04a00, 123] }];
    render(initial);
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open controller editor"]');
    await act(async () => trigger?.click());

    render([{ beat: 1, wordCount: 2, words: [0x40b04a00, 456] }]);
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain("region changed");
    const saveButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Save MIDI 2.0 events"));
    expect(saveButton?.disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});
