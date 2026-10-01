// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useEffect, useState } from "react";

export interface CoreExitInfo {
  code: number | null;
  signal: string | null;
  logPath: string;
  occurredAt: string;
}

/** Captures the Electron-reported Core exit without treating renderer state as authoritative. */
export function useCoreExit() {
  const [coreExit, setCoreExit] = useState<CoreExitInfo | null>(null);

  useEffect(() => {
    const onCoreExit = (event: Event) => {
      const detail = (event as CustomEvent<CoreExitInfo>).detail;
      if (detail) setCoreExit(detail);
    };
    window.addEventListener("resostage-core-process-exit", onCoreExit);
    return () => window.removeEventListener("resostage-core-process-exit", onCoreExit);
  }, []);

  return coreExit;
}
