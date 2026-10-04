/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { EasedReadout } from "@/components/daw/EasedReadout";
import type { PluginSlotRow } from "@/lib/state/types";
import { usePluginParameterValue } from "@/screens/mixer/plugins/hooks/usePluginParameterValue";

function formatNormalizedPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Isolates the low-rate live value refresh from the large parameter list. */
export function PluginParameterValueReadout({
  enabled,
  stripId,
  slot,
  parameter,
  valueIdentity,
}: {
  enabled: boolean;
  stripId: string;
  slot: Pick<PluginSlotRow, "id" | "pluginId" | "loadState"> | null;
  parameter: { index: number; name: string; parameterId?: string };
  valueIdentity: string;
}) {
  const snapshot = usePluginParameterValue({
    enabled,
    stripId,
    slot,
    parameterIndex: parameter.index,
    valueIdentity,
  });
  const parameterIdentity = parameter.parameterId ?? `param:${parameter.index}`;
  const motionKey = `${valueIdentity}:${stripId}:${slot?.id ?? ""}:${slot?.pluginId ?? ""}:${parameterIdentity}`;

  return (
    <div className="shrink-0 text-right" title="Latest normalized value sampled from the Core plug-in host">
      <div className="text-[9px] uppercase tracking-wide text-foreground/40">Current</div>
      <output
        data-testid="plugin-automation-current-value"
        aria-label={`${parameter.name} current normalized value`}
        className="font-mono text-xs tabular-nums text-foreground/75"
      >
        {snapshot.state === "loaded" && snapshot.value !== null ? (
          <EasedReadout
            value={snapshot.value}
            format={formatNormalizedPercent}
            motionKey={motionKey}
            durationMs={180}
          />
        ) : snapshot.state === "unbound" ? (
          "Unbound"
        ) : snapshot.state === "failed" || snapshot.state === "missing" ? (
          "Unavailable"
        ) : (
          "—"
        )}
      </output>
    </div>
  );
}
