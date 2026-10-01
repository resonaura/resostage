// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { Gauge, Lightbulb, Music4, Settings2, Sliders } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { Tabs } from "@/components/ui";
import type { AllPeaksResponse, PeaksResponse, WebUiState } from "@/lib/state/types";
import { EditorScreen } from "@/screens/editor/EditorScreen";
import { LightScreen } from "@/screens/light/LightScreen";
import { MixerScreen } from "@/screens/mixer";
import { PlayerScreen } from "@/screens/player/PlayerScreen";
import { SettingsScreen } from "@/screens/settings/SettingsScreen";
import type { usePerformanceMode } from "@/performance/hooks/usePerformanceMode";
import type { useTheme } from "@/shell/hooks/useTheme";
import type { RenderDialogIntent } from "@/transfer/render/components/RenderAudioDialog";

export function AppNavigation({
  tab,
  onTabChange,
  sendView,
  state,
  cpuHistory,
  ramHistory,
  peaks,
  allPeaks,
  pxPerSec,
  setPxPerSec,
  onRender,
  performance,
  theme,
}: {
  tab: string;
  onTabChange: (tab: string) => void;
  sendView: (tab: string) => void;
  state: WebUiState;
  cpuHistory: number[];
  ramHistory: number[];
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  pxPerSec: number;
  setPxPerSec: Dispatch<SetStateAction<number>>;
  onRender: (intent: RenderDialogIntent) => void;
  performance: ReturnType<typeof usePerformanceMode>;
  theme: ReturnType<typeof useTheme>;
}) {
  return (
    <Tabs
      variant="nav"
      selectedKey={tab}
      onSelectionChange={(key) => {
        const value = String(key);
        onTabChange(value);
        sendView(value);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <Tabs.ListContainer className="shrink-0 overflow-x-auto border-b border-default/30 px-1 sm:px-2 bg-transparent">
        <Tabs.List aria-label="Sections" className="bg-transparent">
          <Tabs.Tab id="player">
            <Music4 size={15} className="inline-block sm:mr-1.5" />
            <span className="hidden sm:inline">Player</span>
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="mixer">
            <Sliders size={15} className="inline-block sm:mr-1.5" />
            <span className="hidden sm:inline">Mixer</span>
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="editor">
            <Gauge size={15} className="inline-block sm:mr-1.5" />
            <span className="hidden sm:inline">Editor</span>
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="light">
            <Lightbulb size={15} className="inline-block sm:mr-1.5" />
            <span className="hidden sm:inline">Light</span>
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="settings">
            <Settings2 size={15} className="inline-block sm:mr-1.5" />
            <span className="hidden sm:inline">Settings</span>
            <Tabs.Indicator />
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>

      <Tabs.Panel
        id="player"
        className="flex min-h-0 flex-1 flex-col overflow-hidden p-1.5 sm:p-3"
      >
        <PlayerScreen
          state={state}
          cpuHistory={cpuHistory}
          ramHistory={ramHistory}
          peaks={peaks}
          allPeaks={allPeaks}
          pxPerSec={pxPerSec}
          setPxPerSec={setPxPerSec}
        />
      </Tabs.Panel>
      <Tabs.Panel
        id="mixer"
        className="flex min-h-0 flex-1 flex-col overflow-hidden p-1.5 sm:p-3"
      >
        <MixerScreen state={state} active={tab === "mixer"} onRender={onRender} />
      </Tabs.Panel>
      <Tabs.Panel
        id="editor"
        className="flex min-h-0 flex-1 flex-col overflow-hidden p-1.5 sm:p-3"
      >
        <EditorScreen
          state={state}
          peaks={peaks}
          allPeaks={allPeaks}
          pxPerSec={pxPerSec}
          setPxPerSec={setPxPerSec}
        />
      </Tabs.Panel>
      <Tabs.Panel id="light" className="flex-1 overflow-auto p-1.5 sm:p-3">
        <LightScreen state={state} />
      </Tabs.Panel>
      <Tabs.Panel id="settings" className="flex-1 overflow-auto p-1.5 sm:p-3">
        <SettingsScreen state={state} performance={performance} theme={theme} />
      </Tabs.Panel>
    </Tabs>
  );
}
