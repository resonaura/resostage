import { AlertTriangle } from "lucide-react";
import type { HardwareAlarmToast } from "../hooks/useHardwareAlarmToasts";

export function HardwareAlarmToasts({
  notifications,
  onDismiss,
}: {
  notifications: HardwareAlarmToast[];
  onDismiss: (id: string) => void;
}) {
  if (notifications.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-300 flex max-w-sm flex-col gap-2.5 pointer-events-none">
      {notifications.map((toast) => (
        <div
          key={toast.id}
          onClick={() => onDismiss(toast.id)}
          className="pointer-events-auto flex items-start gap-3 rounded-xl border border-danger/40 bg-surface/95 p-3.5 text-foreground shadow-2xl backdrop-blur-md transition-all cursor-pointer hover:border-danger"
          style={{ animation: "fadeInUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)" }}
        >
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger/20 text-danger">
            <AlertTriangle size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-danger uppercase tracking-wider">
              {toast.title}
            </p>
            <p className="text-xs text-foreground/90 font-medium leading-relaxed mt-0.5">
              {toast.message}
            </p>
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss(toast.id);
            }}
            className="text-foreground/40 hover:text-foreground text-xs font-bold"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
