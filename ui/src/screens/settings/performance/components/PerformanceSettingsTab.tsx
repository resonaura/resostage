/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Alert, Switch, ToggleButton } from "@/components/ui";
import type { WebUiState } from "@/lib/state/types";
import {
  TIER_DESCRIPTION,
  TIER_FPS,
  TIER_LABEL,
  type PerformanceTier,
} from "@/performance/logic/performance";
import {
  SettingsSection,
  SettingsStat,
} from "@/screens/settings/components/SettingsPrimitives";
import { formatBytes } from "@/screens/settings/logic/formatBytes";
import type { PerformanceControls } from "@/screens/settings/types";

function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function PerformanceSettingsTab({
  state,
  performance,
}: {
  state: WebUiState;
  performance: PerformanceControls;
}) {
  const { settings, setSettings, effectiveTier, degraded } = performance;
  const health = state.health;
  const disk =
    (health.diskReadBytesPerSec ?? 0) + (health.diskWriteBytesPerSec ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        title="Frame rate"
        description="How often the interface redraws. Meters, waveforms and the playhead all share one frame budget, so lowering this lightens every one of them at once. It never affects the audio engine, which runs on its own real-time thread."
      >
        <div className="flex flex-col gap-2">
          {(Object.keys(TIER_FPS) as PerformanceTier[]).map((tier) => (
            <ToggleButton
              key={tier}
              size="sm"
              tone="accent-soft"
              isSelected={settings.tier === tier}
              onChange={() => setSettings({ ...settings, tier })}
              className="w-full justify-start gap-2 px-3"
            >
              <span className="font-semibold">{TIER_LABEL[tier]}</span>
              <span className="text-xs opacity-70">
                {TIER_DESCRIPTION[tier]}
              </span>
            </ToggleButton>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Automatic"
        description="Watches how long frames actually take, plus the engine's own health, and steps down a level when the machine stops keeping up. It only ever goes below the level above, never past it, and climbs back after a long clean stretch."
      >
        <div className="flex items-center justify-between gap-3">
          <Switch
            isSelected={settings.auto}
            onChange={(auto) => setSettings({ ...settings, auto })}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <span className="text-sm">
                Lower the frame rate automatically
              </span>
            </Switch.Content>
          </Switch>
        </div>
        {degraded && (
          <Alert status="warning">
            <Alert.Content>
              <Alert.Title className="text-xs font-semibold">
                Running at {TIER_LABEL[effectiveTier]}
              </Alert.Title>
              <Alert.Description className="text-xs">
                The machine was not keeping up at {TIER_LABEL[settings.tier]}.
                It will go back up on its own once it can.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </SettingsSection>

      <SettingsSection
        title="What it is watching"
        description="Disk is here because it is the one that hides: a throttling SSD stalls stem streaming and the audio breaks up with the CPU graph flat."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SettingsStat
            label="CPU (app)"
            value={`${Math.max(0, health.cpuPercent ?? 0).toFixed(1)}%`}
          />
          <SettingsStat label="Disk I/O" value={formatRate(disk)} />
          <SettingsStat
            label="Stream starves"
            value={String(health.streamStarveCount ?? 0)}
          />
          <SettingsStat
            label="Silent blocks"
            value={String(health.silentBlockCount ?? 0)}
          />
        </div>
      </SettingsSection>
    </div>
  );
}
