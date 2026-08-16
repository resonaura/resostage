import { useEffect } from "react";
import { Button } from "./ui";

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
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const handleConfirm = (e?: any) => {
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    onConfirm();
  };

  const handleCancel = (e?: any) => {
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    onCancel();
  };

  const handleThird = (e?: any) => {
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    if (onThird) onThird();
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4 select-none"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      role="dialog"
      aria-modal="true"
      onClick={handleCancel}
    >
      <div
        className="w-full max-w-md rounded-xl border border-default/40 bg-surface p-5 shadow-2xl"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm text-foreground/75">{message}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onPress={handleCancel} onClick={handleCancel}>
            {cancelLabel}
          </Button>
          {thirdLabel && onThird && (
            <Button size="sm" variant="outline" onPress={handleThird} onClick={handleThird}>
              {thirdLabel}
            </Button>
          )}
          <Button
            size="sm"
            className={danger ? "bg-danger text-white" : undefined}
            onPress={handleConfirm}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
