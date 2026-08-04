export interface Toast {
  id: number;
  message: string;
}

export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-default/40 bg-surface/95 backdrop-blur-md px-4 py-2.5 text-sm font-medium text-foreground shadow-2xl"
          style={{ animation: "fadeInUp 0.2s ease-out" }}
          onClick={() => onDismiss(t.id)}
        >
          <span className="h-2 w-2 rounded-full bg-warning shrink-0" />
          {t.message}
        </div>
      ))}
    </div>
  );
}
