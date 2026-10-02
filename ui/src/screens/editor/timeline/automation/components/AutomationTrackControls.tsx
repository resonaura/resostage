/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { memo, useMemo } from "react";
import { Plus, Power, Trash2 } from "lucide-react";
import { builder } from "@/lib/state/api";
import type {
  AutomationLaneRow,
  AutomationWriteMode,
  BusRow,
  TrackRow,
} from "@/lib/state/types";
import { getTrackAutomationTargets } from "../logic/automationTargets";
import type { AutomationTargetOption } from "../logic/types";

const WRITE_MODE_STYLES: Record<AutomationWriteMode, { label: string; badgeClass: string }> = {
  read: {
    label: "Read",
    badgeClass: "text-emerald-400 bg-emerald-500/15 border-emerald-500/30",
  },
  touch: {
    label: "Touch",
    badgeClass: "text-amber-400 bg-amber-500/15 border-amber-500/30",
  },
  latch: {
    label: "Latch",
    badgeClass: "text-orange-400 bg-orange-500/15 border-orange-500/30",
  },
  write: {
    label: "Write",
    badgeClass: "text-rose-400 bg-rose-500/15 border-rose-500/30",
  },
};

const NEXT_WRITE_MODE: Record<AutomationWriteMode, AutomationWriteMode> = {
  read: "touch",
  touch: "latch",
  latch: "write",
  write: "read",
};

export const AutomationTrackControls = memo(function AutomationTrackControls({
  songIndex,
  track,
  lanes,
  activeLaneId,
  onSelectLane,
  onAddSublane,
  onRemoveLane,
  buses,
  readOnly = false,
}: {
  songIndex: number;
  track: TrackRow;
  lanes: AutomationLaneRow[];
  activeLaneId?: string;
  onSelectLane: (laneId: string) => void;
  onAddSublane?: () => void;
  onRemoveLane?: (laneId: string) => void;
  buses?: BusRow[];
  readOnly?: boolean;
}) {
  const targetGroups = useMemo(
    () => getTrackAutomationTargets(track, buses),
    [track, buses],
  );

  const activeLane = lanes.find((l) => l.id === activeLaneId) ?? lanes[0];

  const handleTargetChange = async (targetId: string) => {
    if (readOnly) return;
    // Find target in groups
    let foundTarget: AutomationTargetOption | undefined;
    for (const group of targetGroups) {
      const match = group.targets.find((t) => t.id === targetId);
      if (match) {
        foundTarget = match;
        break;
      }
    }
    if (!foundTarget) return;

    // Check if lane already exists for target
    const existing = lanes.find(
      (l) =>
        l.target.domain === foundTarget!.domain &&
        l.target.entityId === foundTarget!.entityId &&
        l.target.parameterId === foundTarget!.parameterId,
    );

    if (existing) {
      onSelectLane(existing.id);
      return;
    }

    // Create new lane for target
    try {
      await builder.automationLaneAdd({
        songIndex,
        domain: foundTarget.domain,
        entityId: foundTarget.entityId,
        parameterId: foundTarget.parameterId,
        valueType: foundTarget.valueType,
        defaultValue: foundTarget.defaultValue,
        minValue: foundTarget.minValue,
        maxValue: foundTarget.maxValue,
        scope: "track",
        writeMode: "read",
        initialTimeBeats: 0,
        initialValue: foundTarget.defaultValue,
      });
    } catch {
      // Ignore if cannot add
    }
  };

  const handleCycleWriteMode = async () => {
    if (readOnly || !activeLane) return;
    const nextMode = NEXT_WRITE_MODE[activeLane.writeMode ?? "read"];
    try {
      await builder.automationLaneUpdate({
        songIndex,
        laneId: activeLane.id,
        writeMode: nextMode,
      });
    } catch {
      // Ignore update error
    }
  };

  const handleToggleMute = async () => {
    if (readOnly || !activeLane) return;
    try {
      await builder.automationLaneUpdate({
        songIndex,
        laneId: activeLane.id,
        muted: !activeLane.muted,
      });
    } catch {
      // Ignore
    }
  };

  const currentTargetId = activeLane
    ? targetGroups
        .flatMap((g) => g.targets)
        .find(
          (t) =>
            t.domain === activeLane.target.domain &&
            t.entityId === activeLane.target.entityId &&
            t.parameterId === activeLane.target.parameterId,
        )?.id ?? targetGroups[0]?.targets[0]?.id
    : targetGroups[0]?.targets[0]?.id;

  const modeInfo = WRITE_MODE_STYLES[activeLane?.writeMode ?? "read"];

  return (
    <div className="flex h-7 items-center gap-1.5 px-2 py-0.5 border-t border-default/15 bg-background-tertiary/70 text-xs">
      {/* Automation Enabled / Active indicator */}
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        disabled={readOnly}
        onClick={handleToggleMute}
        title={activeLane?.muted ? "Automation Muted (Click to Unmute)" : "Automation Active (Click to Mute)"}
        className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
          activeLane?.muted
            ? "border-default/30 text-foreground/30 hover:text-foreground/60"
            : "border-accent/40 text-accent bg-accent/10"
        }`}
      >
        <Power size={11} />
      </button>

      {/* Target Selector Dropdown */}
      <select
        tabIndex={-1}
        value={currentTargetId}
        disabled={readOnly}
        onChange={(e) => void handleTargetChange(e.target.value)}
        className="h-5 flex-1 min-w-0 rounded border border-default/20 bg-surface/80 px-1 text-[11px] text-foreground outline-none focus:border-accent"
      >
        {targetGroups.map((group) => (
          <optgroup key={group.category} label={group.categoryLabel}>
            {group.targets.map((target) => (
              <option
                key={target.id}
                value={target.id}
                disabled={Boolean(target.disabledReason)}
              >
                {target.label} {target.disabledReason ? `(${target.disabledReason})` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {/* Write Mode Badge / Toggle */}
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        disabled={readOnly}
        onClick={() => void handleCycleWriteMode()}
        title="Cycle Automation Write Mode (Read / Touch / Latch / Write)"
        className={`h-5 px-1.5 rounded border text-[10px] font-semibold uppercase tracking-wider transition-colors ${modeInfo.badgeClass}`}
      >
        {modeInfo.label}
      </button>

      {/* Add Sublane Button */}
      {onAddSublane && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          disabled={readOnly}
          onClick={onAddSublane}
          title="Add Automation Sublane"
          className="flex h-5 w-5 items-center justify-center rounded border border-default/20 text-foreground/50 hover:bg-default/10 hover:text-foreground"
        >
          <Plus size={11} />
        </button>
      )}

      {/* Remove Lane Button */}
      {onRemoveLane && activeLane && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          disabled={readOnly}
          onClick={() => onRemoveLane(activeLane.id)}
          title="Remove Automation Lane"
          className="flex h-5 w-5 items-center justify-center rounded border border-default/20 text-foreground/40 hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
});
