// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { Alert } from "@/components/ui";
import type { WebUiState } from "@/lib/state/types";
import {
  SettingsSection,
  SettingsStat,
} from "@/screens/settings/components/SettingsPrimitives";
import { formatBytes } from "@/screens/settings/logic/formatBytes";

export function HealthSettingsTab({ state }: { state: WebUiState }) {
  const health = state.health;

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title="System Health">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <SettingsStat
            label="CPU (app · 100%=1 core)"
            value={`${Math.max(0, health.cpuPercent ?? 0).toFixed(1)}%`}
          />
          <SettingsStat
            label="RAM (Memory / footprint)"
            value={formatBytes(health.rssBytes)}
          />
          <SettingsStat
            label="Free system RAM"
            value={formatBytes(health.freeBytes)}
          />
          <SettingsStat
            label="Underruns"
            value={String(health.underrunCount)}
          />
          <SettingsStat
            label="Silent blocks"
            value={String(health.silentBlockCount ?? 0)}
          />
          <SettingsStat
            label="Stream starves"
            value={String(health.streamStarveCount ?? 0)}
          />
          <SettingsStat
            label="Audio callbacks"
            value={String(health.audioCallbackCount)}
          />
          <SettingsStat
            label="Web clients"
            value={String(health.webClientCount)}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Render callback"
        description="How close each block came to its deadline, and -- when one ran long -- whether it was doing too much work or waiting for a core. Those need opposite fixes and look identical in every other number here. Reset whenever the device changes, so it always describes the current setup."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SettingsStat
            label="Worst block (of deadline)"
            value={`${((health.callbackWorstRatio ?? 0) * 100).toFixed(0)}%`}
          />
          <SettingsStat
            label="Worst block"
            value={`${(health.callbackWorstMs ?? 0).toFixed(2)} ms`}
          />
          <SettingsStat
            label="…spent running"
            value={`${((health.callbackWorstCpuShare ?? 0) * 100).toFixed(0)}%`}
          />
          <SettingsStat
            label="Missed deadline"
            value={String(health.callbackOverruns ?? 0)}
          />
          <SettingsStat
            label="Slow: too much work"
            value={String(health.callbackComputeStalls ?? 0)}
          />
          <SettingsStat
            label="Slow: waiting for a core"
            value={String(health.callbackPreemptedStalls ?? 0)}
          />
          <SettingsStat
            label="Output latency"
            value={`${(health.outputLatencyMs ?? 0).toFixed(1)} ms`}
          />
          <SettingsStat
            label="Clock skew"
            value={`${(health.hostTimeSkewMs ?? 0).toFixed(2)} ms`}
          />
        </div>
        {(health.thermalState ?? "nominal") !== "nominal" && (
          <Alert>
            <Alert.Content>
              <Alert.Description>
                The system reports thermal pressure ({health.thermalState}). A
                throttled machine reduces its clocks and moves work to
                efficiency cores, so audio can break up while CPU, RAM and disk
                all read healthy. Cooling the machine is the fix; a larger
                buffer buys time.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        {(health.callbackPreemptedStalls ?? 0) > 0 && (
          <Alert>
            <Alert.Content>
              <Alert.Description>
                Some blocks ran long without using the CPU — they were waiting,
                not working. That points at the machine (another app, disk,
                power settings), not at the size of this show.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        {(health.processes?.length ?? 0) > 0 && (
          <div className="rounded-lg bg-default/30 p-3">
            <div className="mb-2 text-xs font-medium uppercase text-default-500">
              Per-process (incl. WebKit helpers)
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-default-500">
                  <th className="pb-1 pr-3">Process</th>
                  <th className="pb-1 pr-3 text-right">PID</th>
                  <th className="pb-1 pr-3 text-right">RSS</th>
                  <th className="pb-1 text-right">CPU</th>
                </tr>
              </thead>
              <tbody>
                {(health.processes ?? []).map((process) => (
                  <tr key={process.pid} className="border-t border-default/20">
                    <td className="py-1 pr-3 font-mono text-xs">
                      {process.name || "—"}
                    </td>
                    <td className="py-1 pr-3 text-right font-mono text-xs">
                      {process.pid}
                    </td>
                    <td className="py-1 pr-3 text-right">
                      {formatBytes(process.rssBytes)}
                    </td>
                    <td className="py-1 text-right">
                      {process.cpuPercent.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
