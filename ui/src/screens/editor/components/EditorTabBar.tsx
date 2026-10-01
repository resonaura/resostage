/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import {
  Button,
  ToggleButton,
  ToggleButtonGroup,
} from "@/components/ui";
import { Gauge, ListMusic, Music, Sliders } from "lucide-react";

export type EditorTab = "timeline" | "pianoroll" | "songs";

export function EditorTabBar({
  compact,
  activeTab,
  onSelectTab,
  showInspector,
  onToggleInspector,
}: {
  compact: boolean;
  activeTab: EditorTab;
  onSelectTab: (tab: EditorTab) => void;
  showInspector: boolean;
  onToggleInspector: () => void;
}) {
  // On a phone the arrangement view is not offered at all -- see the Timeline
  // block below for why -- so Songs is the only tab, and it is what the editor
  // opens on regardless of what was last selected on a bigger screen.
  const tabs: { id: EditorTab; label: string }[] = compact
    ? [{ id: "songs", label: "Songs" }]
    : [
        { id: "timeline", label: "Timeline" },
        { id: "pianoroll", label: "Piano Roll" },
        { id: "songs", label: "Songs" },
      ];

  return (
    <div className="flex shrink-0 items-center justify-between gap-1.5">
      {/* Tab Bar — one exclusive choice, so a single-selection toggle group
          rather than N buttons each re-deriving "am I the active one?" from a
          comparison. Same control the timeline toolbar uses for its own
          Audio/Light view mode. */}
      <ToggleButtonGroup
        aria-label="Editor view"
        size="sm"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[activeTab]}
        onSelectionChange={(keys) => {
          const next = Array.from(keys)[0] as EditorTab | undefined;
          if (next) onSelectTab(next);
        }}
      >
        {tabs.flatMap((tab, index) => [
          ...(index > 0
            ? [<ToggleButtonGroup.Separator key={`${tab.id}-sep`} />]
            : []),
          <ToggleButton key={tab.id} id={tab.id}>
            {tab.id === "timeline" ? (
              <Gauge size={13} />
            ) : tab.id === "pianoroll" ? (
              <Music size={13} />
            ) : (
              <ListMusic size={13} />
            )}
            {tab.label}
          </ToggleButton>,
        ])}
      </ToggleButtonGroup>

      {activeTab === "timeline" && (
        <Button
          size="sm"
          variant={showInspector ? "secondary" : "outline"}
          onPress={onToggleInspector}
          className={`gap-1.5 px-2.5 text-xs font-medium transition-all ${
            showInspector
              ? "border-accent/40 bg-accent/15 text-accent shadow-sm"
              : ""
          }`}
          aria-label="Toggle Inspector (I)"
        >
          <Sliders size={13} />
          <span>Inspector</span>
          <kbd className="ml-0.5 rounded bg-default/20 px-1 py-0.2 font-mono text-[9px] text-foreground/50">
            I
          </kbd>
        </Button>
      )}
    </div>
  );
}
