/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useState } from "react";
import { pluginChains } from "@/lib/state/api";
import type { PluginParameterList, PluginParameterValues, TrackRow } from "@/lib/state/types";

const kMaximumCachedPluginSlots = 128;
const kPluginRequestConcurrency = 4;
const kParameterValueRefreshMs = 1000;
const kPluginLoadRefreshMs = 250;

type PluginSlotIdentity = [slotId: string, pluginId: string, loadState: string];

// Parameter names, stable IDs and ranges are immutable for this loaded slot
// generation. Keep a small process-local cache across Timeline remounts; live
// values are refreshed separately from the much larger descriptor table.
const parameterMetadataCache = new Map<string, PluginParameterList>();

function cacheMetadata(key: string, metadata: PluginParameterList): void {
  parameterMetadataCache.delete(key);
  parameterMetadataCache.set(key, metadata);
  while (parameterMetadataCache.size > kMaximumCachedPluginSlots) {
    const oldest = parameterMetadataCache.keys().next().value;
    if (oldest === undefined) break;
    parameterMetadataCache.delete(oldest);
  }
}

function mergeParameterValues(
  metadata: PluginParameterList,
  values: PluginParameterValues,
): PluginParameterList {
  const currentByIndex = new Map(values.values.map(({ index, value }) => [index, value]));
  let changed = false;
  const parameters = metadata.parameters.map((parameter) => {
    const currentValue = currentByIndex.get(parameter.index) ?? parameter.currentValue;
    if (Object.is(currentValue, parameter.currentValue)) return parameter;
    changed = true;
    return { ...parameter, currentValue };
  });
  if (!changed) return metadata;
  return {
    ...metadata,
    parameters,
  };
}

/** Bounded non-RT automation discovery shared by headers and arrangement lanes.
 * Immutable descriptors are fetched once per Core/project/slot generation;
 * only compact latest parameter values are polled. Project/slot identity
 * changes invalidate outstanding responses. Four parallel requests avoid a
 * large project overwhelming Core's control thread. Activity is limited to
 * the visible automation surface, and values come from helper atomics rather
 * than synchronous vendor calls on the audio callback.
 */
export function useAutomationParameters(tracks: TrackRow[], enabled: boolean, projectKey: string) {
  const slotKey = JSON.stringify(tracks.flatMap((track) => (track.plugins ?? [])
    .map((slot) => [slot.id, slot.pluginId, slot.loadState ?? "loading"] as PluginSlotIdentity)));
  const key = `${projectKey}:${slotKey}`;
  const [snapshot, setSnapshot] = useState<{ key: string; values: Record<string, PluginParameterList> }>({ key: "", values: {} });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const slots = JSON.parse(slotKey) as PluginSlotIdentity[];
    async function refresh() {
      const values: Record<string, PluginParameterList> = {};
      let retryLoading = false;
      let retryRequest = false;
      const metadataById = new Map<string, { cacheKey: string; metadata: PluginParameterList }>();
      const missing: Array<{ id: string; cacheKey: string }> = [];
      for (const [id, pluginId, loadState] of slots) {
        const cacheKey = `${projectKey}:${id}:${pluginId}:${loadState}`;
        const cached = parameterMetadataCache.get(cacheKey);
        if (cached) {
          metadataById.set(id, { cacheKey, metadata: cached });
        } else {
          missing.push({ id, cacheKey });
        }
      }

      for (let start = 0; start < missing.length && !cancelled;
        start += kPluginRequestConcurrency) {
        await Promise.all(missing.slice(start, start + kPluginRequestConcurrency).map(async ({ id, cacheKey }) => {
          try {
            const metadata = await pluginChains.parameters(id);
            if (metadata.loadState === "loading") {
              retryLoading = true;
            } else {
              cacheMetadata(cacheKey, metadata);
              metadataById.set(id, { cacheKey, metadata });
            }
          } catch {
            retryRequest = true;
          }
        }));
      }

      const loaded = [...metadataById.entries()].filter(([, value]) =>
        value.metadata.loadState === "loaded" && value.metadata.parameters.length > 0);
      for (let start = 0; start < loaded.length && !cancelled;
        start += kPluginRequestConcurrency) {
        await Promise.all(loaded.slice(start, start + kPluginRequestConcurrency).map(async ([id, entry]) => {
          try {
            const latest = await pluginChains.parameterValues(id);
            if (latest.loadState === "loaded") {
              const refreshed = mergeParameterValues(entry.metadata, latest);
              if (refreshed !== entry.metadata) {
                cacheMetadata(entry.cacheKey, refreshed);
                metadataById.set(id, { cacheKey: entry.cacheKey, metadata: refreshed });
              }
            } else if (latest.loadState === "loading") {
              parameterMetadataCache.delete(entry.cacheKey);
              retryLoading = true;
            } else {
              const failed = { ...entry.metadata, loadState: latest.loadState,
                loadError: latest.loadError };
              cacheMetadata(entry.cacheKey, failed);
              metadataById.set(id, { cacheKey: entry.cacheKey, metadata: failed });
            }
          } catch {
            retryRequest = true;
          }
        }));
      }

      for (const [id, entry] of metadataById) values[id] = entry.metadata;
      if (cancelled) return;
      setSnapshot((previous) => {
        if (previous.key === key) {
          const previousIds = Object.keys(previous.values);
          const valueIds = Object.keys(values);
          if (previousIds.length === valueIds.length
            && valueIds.every((id) => previous.values[id] === values[id])) {
            return previous;
          }
        }
        return { key, values };
      });
      if (retryLoading || retryRequest || loaded.length > 0) {
        timer = setTimeout(refresh, retryLoading ? kPluginLoadRefreshMs : kParameterValueRefreshMs);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, key, projectKey, slotKey]);
  return snapshot.key === key ? snapshot.values : {};
}
