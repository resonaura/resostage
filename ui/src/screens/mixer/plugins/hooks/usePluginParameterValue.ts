/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useState } from "react";
import { pluginChains } from "@/lib/state/api";
import type { PluginSlotRow } from "@/lib/state/types";

const kRefreshMs = 500;
const kRetryMs = 1000;

export type PluginParameterValueState =
  | "idle"
  | "loading"
  | "loaded"
  | "missing"
  | "failed"
  | "unbound";

export interface PluginParameterValueSnapshot {
  state: PluginParameterValueState;
  value: number | null;
  error: string;
}

interface CachedSnapshot extends PluginParameterValueSnapshot {
  identity: string;
}

const emptySnapshot: PluginParameterValueSnapshot = {
  state: "idle",
  value: null,
  error: "",
};

/**
 * Observe one selected vendor parameter while its panel is visible. Requests
 * are sequential (never overlap), bounded to one parameter consumer per panel,
 * and fenced by the complete slot/parameter identity so a late response from a
 * replaced plug-in cannot paint into the new selection. This is UI telemetry,
 * not a control value or an audio-thread polling path.
 */
export function usePluginParameterValue({
  enabled,
  slot,
  parameterIndex,
  valueIdentity,
}: {
  enabled: boolean;
  slot: Pick<PluginSlotRow, "id" | "pluginId" | "loadState"> | null;
  parameterIndex: number | null;
  /** Core session/project/plugin-load generation supplied by the modal owner. */
  valueIdentity: string;
}): PluginParameterValueSnapshot {
  const slotId = slot?.id ?? "";
  const identity = JSON.stringify([
    valueIdentity,
    slotId,
    slot?.pluginId ?? "",
    slot?.loadState ?? "",
    parameterIndex,
  ]);
  const shouldPoll = Boolean(
    enabled
      && slot?.id
      && slot.loadState === "loaded"
      && parameterIndex !== null
      && Number.isInteger(parameterIndex)
      && parameterIndex >= 0,
  );
  const [cached, setCached] = useState<CachedSnapshot>({
    identity: "",
    ...emptySnapshot,
  });

  useEffect(() => {
    if (!shouldPoll || !slotId || parameterIndex === null) return;

    const currentSlotId = slotId;
    const currentParameterIndex = parameterIndex;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = (snapshot: PluginParameterValueSnapshot) => {
      if (disposed) return;
      setCached((previous) => {
        if (previous.identity === identity
            && previous.state === snapshot.state
            && Object.is(previous.value, snapshot.value)
            && previous.error === snapshot.error)
          return previous;
        return { identity, ...snapshot };
      });
    };

    async function poll() {
      if (disposed) return;
      try {
        const response = await pluginChains.parameterValues(currentSlotId);
        if (disposed) return;
        if (response.slotId !== currentSlotId) {
          publish({ state: "failed", value: null, error: "Plug-in identity changed" });
          timer = setTimeout(poll, kRetryMs);
          return;
        }
        if (response.loadState === "loading") {
          publish({ state: "loading", value: null, error: "" });
          timer = setTimeout(poll, kRefreshMs);
          return;
        }
        if (response.loadState === "missing" || response.loadState === "failed") {
          publish({ state: response.loadState, value: null, error: response.loadError });
          return;
        }

        const row = response.values.find((candidate) => candidate.index === currentParameterIndex);
        if (!row || !Number.isFinite(row.value) || row.value < 0 || row.value > 1) {
          publish({ state: "unbound", value: null, error: "Parameter is no longer available" });
          return;
        }
        publish({ state: "loaded", value: row.value, error: "" });
        timer = setTimeout(poll, kRefreshMs);
      } catch (cause) {
        if (disposed) return;
        publish({
          state: "failed",
          value: null,
          error: cause instanceof Error ? cause.message : "Could not read plug-in parameter value",
        });
        timer = setTimeout(poll, kRetryMs);
      }
    }

    publish({ state: "loading", value: null, error: "" });
    void poll();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [identity, parameterIndex, shouldPoll, slotId]);

  if (!shouldPoll) return emptySnapshot;
  return cached.identity === identity
    ? cached
    : { state: "loading", value: null, error: "" };
}
