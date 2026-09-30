import { SHOW_TRANSPORT_LABEL } from "../../../lib/state/devFlags";
import type { TransportKind } from "../../../lib/state/useLiveState";

export function ConnectionBadge({
  status,
  transport,
  telemetryHz,
}: {
  status: "connecting" | "live" | "reconnecting";
  transport: TransportKind;
  telemetryHz: number;
}) {
  const color =
    status === "live"
      ? "bg-success"
      : status === "connecting"
        ? "bg-warning"
        : "bg-danger";
  const label =
    SHOW_TRANSPORT_LABEL && transport !== "none"
      ? transport === "udp"
        ? `UDP: ${telemetryHz > 0 ? telemetryHz : "--"} Hz`
        : `WS: ${telemetryHz > 0 ? telemetryHz : "--"} Hz`
      : null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-foreground/60">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label != null && (
        <span className="font-mono text-[10px] uppercase tracking-wide text-foreground/40">
          {label}
        </span>
      )}
    </div>
  );
}
