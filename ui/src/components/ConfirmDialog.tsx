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
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl border border-default/40 bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm text-foreground/75">{message}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onPress={onCancel}>
            {cancelLabel}
          </Button>
          {thirdLabel && onThird && (
            <Button size="sm" variant="outline" onPress={onThird}>
              {thirdLabel}
            </Button>
          )}
          <Button
            size="sm"
            className={danger ? "bg-danger text-white" : undefined}
            onPress={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
