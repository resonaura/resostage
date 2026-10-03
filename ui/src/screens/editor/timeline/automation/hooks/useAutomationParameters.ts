/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useState } from "react";
import { pluginChains } from "@/lib/state/api";
import type { PluginParameterList, PluginParameterValues, TrackRow } from "@/lib/state/types";
import {
  pluginParameterKey,
  type AutomationPluginParameterCatalog,
} from "@/screens/editor/timeline/automation/logic/pluginParameterIdentity";

const kMaximumCachedPluginSlots = 128;
const kPluginRequestConcurrency = 4;
const kParameterValueRefreshMs = 1000;
const kPluginLoadRefreshMs = 250;

type PluginSlotIdentity = [stripId: string, slotId: string, pluginId: string, loadState: string];

interface PluginMetadataEntry {
  stripId: string;
  slotId: string;
  cacheKey: string;
  metadata: PluginParameterList;
}

function hasExpectedIdentity(
  response: { stripId?: string; slotId: string },
  stripId: string,
  slotId: string,
  slotIdIsUnique: boolean,
): boolean {
  if (response.slotId !== slotId) return false;
  // An older Core can omit stripId. Accept that response only if this project
  // contains one such slot ID, so it cannot be mistaken for another chain.
  return response.stripId === stripId || (response.stripId == null && slotIdIsUnique);
}

function mismatchedMetadata(stripId: string, slotId: string, actualStripId?: string): PluginParameterList {
  const actual = actualStripId ? `“${actualStripId}”` : "an unscoped chain";
  return {
    stripId,
    slotId,
    loadState: "failed",
    loadError: `Core returned plug-in parameters for ${actual}; expected strip “${stripId}”.`,
    truncated: false,
    parameters: [],
  };
}

function sameParameterCatalog(
  left: AutomationPluginParameterCatalog[string],
  right: AutomationPluginParameterCatalog[string],
): boolean {
  return left.stripId === right.stripId
    && left.slotId === right.slotId
    && left.loadState === right.loadState
    && left.loadError === right.loadError
    && left.truncated === right.truncated
    && left.scopeAmbiguous === right.scopeAmbiguous
    && left.parameters === right.parameters;
}

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
    .map((slot) => [track.stripId ?? track.id, slot.id, slot.pluginId, slot.loadState ?? "loading"] as PluginSlotIdentity)));
  const key = `${projectKey}:${slotKey}`;
  const [snapshot, setSnapshot] = useState<{ key: string; values: AutomationPluginParameterCatalog }>({ key: "", values: {} });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const slots = JSON.parse(slotKey) as PluginSlotIdentity[];
    const slotIdCounts = new Map<string, number>();
    for (const [, slotId] of slots) slotIdCounts.set(slotId, (slotIdCounts.get(slotId) ?? 0) + 1);
    async function refresh() {
      const values: Record<string, AutomationPluginParameterCatalog[string]> = {};
      let retryLoading = false;
      let retryRequest = false;
      const metadataByIdentity = new Map<string, PluginMetadataEntry>();
      const missing: Array<{ stripId: string; slotId: string; identity: string; cacheKey: string }> = [];
      for (const [stripId, slotId, pluginId, loadState] of slots) {
        const identity = pluginParameterKey(stripId, slotId);
        const uniqueness = slotIdCounts.get(slotId) === 1 ? "unique" : "ambiguous";
        const cacheKey = `${projectKey}:${identity}:${pluginId}:${loadState}:${uniqueness}`;
        const cached = parameterMetadataCache.get(cacheKey);
        if (cached) {
          metadataByIdentity.set(identity, { stripId, slotId, cacheKey, metadata: cached });
        } else {
          missing.push({ stripId, slotId, identity, cacheKey });
        }
      }

      for (let start = 0; start < missing.length && !cancelled;
        start += kPluginRequestConcurrency) {
        await Promise.all(missing.slice(start, start + kPluginRequestConcurrency).map(async ({ stripId, slotId, identity, cacheKey }) => {
          try {
            const metadata = await pluginChains.parameters(stripId, slotId);
            if (!hasExpectedIdentity(metadata, stripId, slotId, slotIdCounts.get(slotId) === 1)) {
              const failed = mismatchedMetadata(stripId, slotId, metadata.stripId);
              metadataByIdentity.set(identity, { stripId, slotId, cacheKey, metadata: failed });
              retryRequest = true;
              return;
            }
            if (metadata.loadState === "loading") {
              retryLoading = true;
            } else {
              cacheMetadata(cacheKey, metadata);
              metadataByIdentity.set(identity, { stripId, slotId, cacheKey, metadata });
            }
          } catch {
            retryRequest = true;
          }
        }));
      }

      const loaded = [...metadataByIdentity.entries()].filter(([, value]) =>
        value.metadata.loadState === "loaded" && value.metadata.parameters.length > 0);
      for (let start = 0; start < loaded.length && !cancelled;
        start += kPluginRequestConcurrency) {
        await Promise.all(loaded.slice(start, start + kPluginRequestConcurrency).map(async ([identity, entry]) => {
          try {
            const latest = await pluginChains.parameterValues(entry.stripId, entry.slotId);
            if (!hasExpectedIdentity(latest, entry.stripId, entry.slotId,
              slotIdCounts.get(entry.slotId) === 1)) {
              retryRequest = true;
              return;
            }
            if (latest.loadState === "loaded") {
              const refreshed = mergeParameterValues(entry.metadata, latest);
              if (refreshed !== entry.metadata) {
                cacheMetadata(entry.cacheKey, refreshed);
                metadataByIdentity.set(identity, { ...entry, metadata: refreshed });
              }
            } else if (latest.loadState === "loading") {
              parameterMetadataCache.delete(entry.cacheKey);
              retryLoading = true;
            } else {
              const failed = { ...entry.metadata, loadState: latest.loadState,
                loadError: latest.loadError };
              cacheMetadata(entry.cacheKey, failed);
              metadataByIdentity.set(identity, { ...entry, metadata: failed });
            }
          } catch {
            retryRequest = true;
          }
        }));
      }

      for (const [identity, entry] of metadataByIdentity) {
        values[identity] = {
          ...entry.metadata,
          scopeAmbiguous: slotIdCounts.get(entry.slotId) !== 1,
        };
      }
      if (cancelled) return;
      setSnapshot((previous) => {
        if (previous.key === key) {
          const previousIds = Object.keys(previous.values);
          const valueIds = Object.keys(values);
          if (previousIds.length === valueIds.length
            && valueIds.every((id) => sameParameterCatalog(previous.values[id], values[id]))) {
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
