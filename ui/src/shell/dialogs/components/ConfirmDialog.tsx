/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect } from "react";
import { Button, Modal } from "@/components/ui";

/** In-app confirm dialog (replaces native window.confirm / AlertWindow for web). */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
  thirdLabel,
  onThird,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  thirdLabel?: string;
  onThird?: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // React Aria owns Escape and focused-button activation. Keep the
      // historical default Enter action without firing a button twice.
      if (e.key === "Enter" && !(e.target instanceof Element &&
        e.target.closest("button, input, textarea, [contenteditable='true']"))) {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onConfirm]);

  if (!open) return null;

  return (
    <Modal isOpen onOpenChange={(next) => !next && onCancel()}>
      <Modal.Backdrop>
        <Modal.Container size="md" placement="center">
          <Modal.Dialog aria-label={title}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <Modal.CloseTrigger />
            <Modal.Header><Modal.Heading className="text-base font-semibold">{title}</Modal.Heading></Modal.Header>
            <Modal.Body><p className="text-sm text-foreground/75">{message}</p></Modal.Body>
        <Modal.Footer className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onPress={onCancel}
          >
            {cancelLabel}
          </Button>
          {thirdLabel && onThird && (
            <Button
              size="sm"
              variant="outline"
              onPress={onThird}
            >
              {thirdLabel}
            </Button>
          )}
          <Button
            size="sm"
            className={danger ? "bg-danger text-white" : undefined}
            onPress={onConfirm}
            autoFocus
            tabIndex={0}
          >
            {confirmLabel}
          </Button>
        </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
