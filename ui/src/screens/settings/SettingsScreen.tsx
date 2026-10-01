/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useState } from "react";
import {
  Activity,
  Music3,
  Palette,
  Plug,
  Radio,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { ScrollShadow, Tabs } from "@/components/ui";
import type { WebUiState } from "@/lib/state/types";
import { AudioSettingsTab } from "@/screens/settings/audio/components/AudioSettingsTab";
import { HealthSettingsTab } from "@/screens/settings/health/components/HealthSettingsTab";
import { MidiSettingsTab } from "@/screens/settings/midi/components/MidiSettingsTab";
import { PerformanceSettingsTab } from "@/screens/settings/performance/components/PerformanceSettingsTab";
import { PluginsTab } from "@/screens/settings/plugins/components/PluginsTab";
import { RemoteSettingsSection } from "@/screens/settings/remote/components/RemoteSettingsSection";
import { AppearanceSettingsTab } from "@/screens/settings/appearance/components/AppearanceSettingsTab";
import type { PerformanceControls, ThemeControls } from "@/screens/settings/types";

type SettingsTab =
  | "audio"
  | "midi"
  | "appearance"
  | "performance"
  | "health"
  | "plugins"
  | "remote";

const SETTINGS_TABS: {
  id: SettingsTab;
  label: string;
  icon: typeof SlidersHorizontal;
}[] = [
  { id: "audio", label: "Audio", icon: SlidersHorizontal },
  // Keep the id stable so remembered tab selection continues to work.
  { id: "midi", label: "Keys & MIDI", icon: Music3 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "performance", label: "Performance", icon: Zap },
  { id: "health", label: "Health", icon: Activity },
  { id: "plugins", label: "Plug-ins", icon: Plug },
  { id: "remote", label: "Remote", icon: Radio },
];

export function SettingsScreen({
  state,
  performance,
  theme,
}: {
  state: WebUiState;
  performance: PerformanceControls;
  theme: ThemeControls;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("audio");

  return (
    <div className="flex h-full w-full flex-col">
      <Tabs
        variant="accent-soft"
        selectedKey={activeTab}
        onSelectionChange={(key) => setActiveTab(String(key) as SettingsTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.ListContainer className="shrink-0 border-b border-default/30">
          <Tabs.List aria-label="Settings sections">
            {SETTINGS_TABS.map((tab) => (
              <Tabs.Tab key={tab.id} id={tab.id}>
                <tab.icon size={15} className="mr-1.5 inline-block" />
                <span className="whitespace-nowrap">{tab.label}</span>
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>

        {SETTINGS_TABS.map((tab) => (
          <Tabs.Panel
            key={tab.id}
            id={tab.id}
            className="flex-1 min-h-0"
          >
            {tab.id === "plugins" ? (
              <div className="h-full p-4">
                <PluginsTab />
              </div>
            ) : (
              <ScrollShadow
                orientation="vertical"
                className="h-full w-full overflow-y-auto px-6 pt-4 pb-6"
              >
                {tab.id === "audio" && <AudioSettingsTab state={state} />}
                {tab.id === "midi" && <MidiSettingsTab state={state} />}
                {tab.id === "appearance" && <AppearanceSettingsTab theme={theme} />}
                {tab.id === "performance" && (
                  <PerformanceSettingsTab state={state} performance={performance} />
                )}
                {tab.id === "health" && <HealthSettingsTab state={state} />}
                {tab.id === "remote" && <RemoteSettingsSection />}
              </ScrollShadow>
            )}
          </Tabs.Panel>
        ))}
      </Tabs>
    </div>
  );
}
