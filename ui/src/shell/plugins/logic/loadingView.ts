/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { PluginLoadingState } from "@/lib/state/types";

/** Keep presentation separate from Core's authoritative transport gate. */
export function pluginLoadingView(loading: PluginLoadingState, connected: boolean) {
  const pending = loading.phase === "loading";
  return {
    pending,
    canContinue: connected && !pending,
    canRetry: connected && !pending,
    title: pending ? "Loading project plug-ins" : "Some plug-ins are unavailable",
    description: !connected
      ? "Connection to Core was lost. Playback remains protected by Core; waiting for reconnection."
      : pending
        ? "The project is open. Playback will be available after its plug-in chains are ready."
        : "Playback is held to avoid an incomplete mix. Retry, keep the project stopped, or continue with the available plug-ins.",
    completed: Math.min(Math.max(0, loading.completed), Math.max(0, loading.total)),
    total: Math.max(1, loading.total),
  };
}
