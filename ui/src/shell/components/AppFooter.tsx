// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import type { WebUiState } from "@/lib/state/types";

export function AppFooter({ state }: { state: WebUiState }) {
  return (
    <footer className="hidden shrink-0 border-t border-default/60 px-4 py-1.5 text-center text-xs text-foreground/40 sm:block">
      <span className="inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
        <span>{state.statusMessage || "ResoStage remote · mirrors desktop state"}</span>
        {(state.streamResidentTracks ?? 0) +
          (state.streamStreamingTracks ?? 0) >
          0 && (
          <span
            className={
              state.streamBufferUrgent ? "text-danger" : "text-foreground/50"
            }
            title="Stream buffer: min ring headroom · RAM-resident stems"
          >
            buf{" "}
            {state.streamBufferUrgent
              ? "LOW "
              : state.streamResidentTracks ===
                    (state.streamResidentTracks ?? 0) +
                      (state.streamStreamingTracks ?? 0) &&
                  (state.streamStreamingTracks ?? 0) === 0
                ? "RAM "
                : ""}
            {(state.streamBufferMinSec ?? 0) >= 100
              ? "∞"
              : `${(state.streamBufferMinSec ?? 0).toFixed(1)}s`}
            {" · "}
            {state.streamResidentTracks ?? 0}r/{state.streamStreamingTracks ?? 0}s
            {(state.streamResidentMiB ?? 0) > 0.05
              ? ` · ${(state.streamResidentMiB ?? 0).toFixed(0)} MiB`
              : ""}
          </span>
        )}
      </span>
    </footer>
  );
}
