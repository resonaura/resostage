/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SongRow, WebUiState } from "@/lib/state/types";
import { patchClickFields } from "@/screens/mixer/logic/mixerUtils";
import { SongTempoControl } from "@/transport/components/SongTempoControl";

vi.mock("@/screens/mixer/logic/mixerUtils", () => ({
  patchClickFields: vi.fn(),
}));

const song = {
  name: "Writetest",
  bpm: 120,
  tsNum: 4,
  tsDen: 4,
} as SongRow;
const state = {
  songIndex: 3,
  songs: [null, null, null, song],
} as unknown as WebUiState;

function setNativeValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const prototype = element instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("SongTempoControl", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("opens from the transport header and edits only the active song", async () => {
    await act(async () => root.render(
      <SongTempoControl
        state={state}
        song={song}
        songTitle="Writetest"
        bpm={120}
        tsNum={4}
        tsDen={4}
      />,
    ));

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit song tempo and time signature"]',
    );
    expect(trigger?.disabled).toBe(false);
    await act(async () => trigger?.click());

    const fields = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    );
    expect(fields).toHaveLength(2);
    expect(document.querySelector('select')?.value).toBe("4");

    await act(async () => {
      setNativeValue(fields[0]!, "132.5");
      setNativeValue(fields[1]!, "7");
      const denominator = document.querySelector<HTMLSelectElement>("select")!;
      setNativeValue(denominator, "8");
    });

    const apply = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Apply",
    );
    await act(async () => apply?.click());
    expect(patchClickFields).toHaveBeenCalledWith(state, {
      bpm: 132.5,
      tsNum: 7,
      tsDen: 8,
    });
  });
});
