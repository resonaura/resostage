/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Modal } from "@/components/ui/Modal";

it("keeps the shared close trigger outside Header and delegates controlled dismissal", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpenChange = vi.fn();
  try {
    await act(async () => root.render(
      <Modal isOpen onOpenChange={onOpenChange}>
        <Modal.Backdrop><Modal.Container><Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header><Modal.Heading>A long dialog heading</Modal.Heading></Modal.Header>
          <Modal.Body>Content</Modal.Body>
        </Modal.Dialog></Modal.Container></Modal.Backdrop>
      </Modal>,
    ));
    const dialog = document.querySelector('[role="dialog"]');
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(dialog?.classList.contains("rs-modal-surface")).toBe(true);
    expect(close?.parentElement).toBe(dialog);
    expect(close?.classList.contains("rs-modal-close-trigger")).toBe(true);
    await act(async () => close?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
