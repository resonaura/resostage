/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui";
import { dismissHistoryError, getHistoryNavigationState, subscribeHistoryNavigation } from "@/lib/state/historyNavigation";

/** History failures must not disappear in fire-and-forget toolbar handlers. */
export function HistoryStatusBanner() {
  const { pending, error } = useSyncExternalStore(subscribeHistoryNavigation, getHistoryNavigationState);
  if (!pending && !error) return null;
  return (
    <div role={error ? "alert" : "status"} className={`flex shrink-0 items-center gap-3 border-b border-default/20 px-4 py-2 text-xs ${error ? "text-danger" : "text-muted"}`}>
      <span className="flex-1">{error || "Applying history…"}</span>
      {error && <Button size="sm" variant="ghost" onPress={dismissHistoryError}>Dismiss</Button>}
    </div>
  );
}
