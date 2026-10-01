/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/shell/dialogs/components/ConfirmDialog";

it("dispatches confirmation/cancellation once and uses shared modal dismissal", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const onThird = vi.fn();
  try {
    await act(async () => root.render(<ConfirmDialog open title="Confirm action" message="Details"
      onConfirm={onConfirm} onCancel={onCancel} thirdLabel="Third action" onThird={onThird} />));
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === text);
    await act(async () => button("Confirm")?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => button("Cancel")?.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    await act(async () => button("Third action")?.click());
    expect(onThird).toHaveBeenCalledTimes(1);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click());
    expect(onCancel).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
