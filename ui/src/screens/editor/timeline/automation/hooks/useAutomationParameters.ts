/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useState } from "react";
import { pluginChains } from "@/lib/state/api";
import type { PluginParameterList, TrackRow } from "@/lib/state/types";

/** One bounded non-RT discovery loop shared by headers and arrangement lanes.
 * Project/slot identity changes invalidate outstanding responses. Four parallel
 * requests avoid a large project overwhelming Core's control thread. Polling is
 * active only while the automation surface is visible; values come from helper
 * atomics, never synchronous vendor calls on the audio callback.
 */
export function useAutomationParameters(tracks: TrackRow[], enabled: boolean, projectKey: string) {
  const slotKey = JSON.stringify(tracks.flatMap((track) => (track.plugins ?? [])
    .map((slot) => [slot.id, slot.pluginId, slot.loadState])));
  const key = `${projectKey}:${slotKey}`;
  const [snapshot, setSnapshot] = useState<{ key: string; values: Record<string, PluginParameterList> }>({ key: "", values: {} });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const ids = (JSON.parse(slotKey) as string[][]).map(([id]) => id);
    async function refresh() {
      const values: Record<string, PluginParameterList> = {};
      for (let start = 0; start < ids.length && !cancelled; start += 4) {
        await Promise.all(ids.slice(start, start + 4).map(async (id) => {
          try { values[id] = await pluginChains.parameters(id); }
          catch (error) { values[id] = { slotId: id, loadState: "failed", truncated: false,
            loadError: error instanceof Error ? error.message : String(error), parameters: [] }; }
        }));
      }
      if (cancelled) return;
      setSnapshot({ key, values });
      timer = setTimeout(refresh, Object.values(values).some((value) => value.loadState === "loading") ? 250 : 1000);
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, key, slotKey]);
  return snapshot.key === key ? snapshot.values : {};
}
