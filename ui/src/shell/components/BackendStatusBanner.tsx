/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { AlertTriangle } from "lucide-react";
import type { CoreExitInfo } from "@/shell/hooks/useCoreExit";

export function BackendStatusBanner({
  coreExit,
  hasLiveSnapshot,
  status,
}: {
  coreExit: CoreExitInfo | null;
  hasLiveSnapshot: boolean;
  status: "connecting" | "live" | "reconnecting";
}) {
  if (!coreExit && (!hasLiveSnapshot || status === "live")) return null;

  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-3 border-b border-danger/35 bg-danger/10 px-4 py-2.5 text-xs text-foreground"
    >
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0">
        <p className="font-semibold text-danger">
          {coreExit
            ? "ResoStage Core stopped unexpectedly"
            : "Backend connection lost — reconnecting…"}
        </p>
        <p className="mt-0.5 text-foreground/70">
          {coreExit
            ? `Exit code ${coreExit.code ?? "unknown"}${coreExit.signal ? ` · ${coreExit.signal}` : ""}. The interface is still open; project/audio state may be unavailable.`
            : "The interface is still running, but live control and playback state are unavailable until the backend returns."}
        </p>
        {coreExit?.logPath && (
          <p className="mt-0.5 break-all font-mono text-[10px] text-foreground/50">
            Core log: {coreExit.logPath}
          </p>
        )}
      </div>
    </div>
  );
}
