/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { memo, useEffect, useMemo, useState } from "react";
import { Plus, Power, Trash2 } from "lucide-react";
import { Button, Select, Tooltip } from "@/components/ui";
import { builder } from "@/lib/state/api";
import type { AutomationLaneRow, BusRow, PluginParameterList, TrackRow } from "@/lib/state/types";
import { getTrackAutomationTargets, matchesAutomationTarget } from "@/screens/editor/timeline/automation/logic/automationTargets";

/** Selecting a parameter previews it. Only + or an explicit draw creates a lane.
 * New lanes are empty: their baseline is the effective value, not a fake point.
 * All mutations use the shared Core history and expose reliable admission errors.
 */
export const AutomationTrackControls = memo(function AutomationTrackControls({
  songIndex, track, lanes, activeLaneId, onSelectLane, onRemoveLane, buses,
  parameters = {}, readOnly = false, compact = false,
}: {
  songIndex: number;
  track: TrackRow;
  lanes: AutomationLaneRow[];
  activeLaneId?: string;
  onSelectLane: (laneId: string) => void;
  onRemoveLane?: (laneId: string) => void;
  buses?: BusRow[];
  parameters?: Readonly<Record<string, PluginParameterList>>;
  readOnly?: boolean;
  compact?: boolean;
}) {
  const groups = useMemo(() => getTrackAutomationTargets(track, buses, lanes, parameters), [track, buses, lanes, parameters]);
  const targets = groups.flatMap((group) => group.targets);
  const selectedTarget = targets.find((option) => option.id === activeLaneId);
  const activeLane = lanes.find((lane) => lane.id === activeLaneId)
    ?? (selectedTarget
      ? lanes.find((lane) => matchesAutomationTarget(selectedTarget, lane.target))
      : lanes[0]);
  const target = activeLane
    ? targets.find((option) => matchesAutomationTarget(option, activeLane.target))
    : selectedTarget ?? targets[0];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [songIndex, track.id]);
  const run = async (command: () => Promise<void>) => {
    if (readOnly || pending) return;
    setPending(true); setError(null);
    try { await command(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setPending(false); }
  };
  const isTargetAutomated = Boolean(target && lanes.some((lane) => matchesAutomationTarget(target, lane.target)));
  const nextUnautomatedTarget = targets.find((t) => !t.disabledReason && !lanes.some((l) => matchesAutomationTarget(t, l.target)));
  const add = () => {
    const targetToAdd = isTargetAutomated ? nextUnautomatedTarget : target;
    if (!targetToAdd || targetToAdd.disabledReason) return;
    const existing = lanes.find((lane) => matchesAutomationTarget(targetToAdd, lane.target));
    if (existing) { onSelectLane(existing.id); return; }
    void run(async () => {
      await builder.automationLaneAdd({ songIndex, domain: targetToAdd.domain,
        entityId: targetToAdd.entityId, parameterId: targetToAdd.parameterId,
        valueType: targetToAdd.valueType, defaultValue: targetToAdd.defaultValue,
        minValue: targetToAdd.minValue, maxValue: targetToAdd.maxValue, scope: "track",
        writeMode: "read", points: [] });
      // The Core owns generated lane IDs. Keep a stable target selection until
      // the authoritative echo supplies the lane; activeLane resolves it by target.
      onSelectLane(targetToAdd.id);
    });
  };
  const disabled = readOnly || pending;
  const canAdd = !disabled && Boolean(
    (!isTargetAutomated && target && !target.disabledReason) ||
    (isTargetAutomated && nextUnautomatedTarget)
  );
  const addTooltip = isTargetAutomated
    ? (nextUnautomatedTarget ? `Add lane for ${nextUnautomatedTarget.label}` : "All track parameters are already automated")
    : (target?.disabledReason ?? `Add automation for ${target?.label ?? "selected parameter"}`);
  return (
    <div className={`flex min-w-0 items-center gap-1 text-xs ${compact ? "h-full px-1" : "h-7 px-1.5"}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}>
      <Tooltip content={activeLane?.muted ? "Enable automation" : "Mute automation"}><Button isIconOnly size="sm" variant={activeLane?.enabled && !activeLane.muted ? "accent-soft" : "ghost"}
        className={`${compact ? "h-4.5 min-w-4.5 w-4.5" : "h-5.5 min-w-5.5 w-5.5"} shrink-0`} aria-label="Enable automation"
        isDisabled={disabled || !activeLane}
        onPress={() => activeLane && void run(() => builder.automationLaneUpdate({ songIndex,
          laneId: activeLane.id, enabled: true, muted: !activeLane.muted }))}><Power size={compact ? 10 : 12} /></Button></Tooltip>
      <Select size="xs" variant="secondary" className="min-w-0 flex-1" aria-label="Automation parameter"
        title={error ?? target?.disabledReason ?? "Automation parameter"}
        value={target?.id} isDisabled={disabled}
        options={groups.flatMap((group) => group.targets.map((option) => {
          const isAutomated = lanes.some((lane) => matchesAutomationTarget(option, lane.target));
          return {
            id: option.id,
            label: isAutomated ? `${option.label} •` : option.label,
            textValue: isAutomated ? `${option.label} •` : option.label,
            section: group.categoryLabel,
            // Existing unbound data stays selectable and recoverable.
            isDisabled: Boolean(option.disabledReason) && !isAutomated,
          };
        }))}
        onChange={(id) => {
          const selected = targets.find((option) => option.id === id);
          if (!selected) return;
          if (!activeLane) {
            // Choosing a target before creating a lane only previews its
            // effective value. The explicit + action remains the creation step.
            onSelectLane(selected.id);
            return;
          }
          if (matchesAutomationTarget(selected, activeLane.target)) return;
          void run(() => builder.automationLaneUpdate({
            songIndex,
            laneId: activeLane.id,
            target: {
              domain: selected.domain,
              entityId: selected.entityId,
              parameterId: selected.parameterId,
              valueType: selected.valueType,
              defaultValue: selected.defaultValue,
              minValue: selected.minValue,
              maxValue: selected.maxValue,
            },
          }));
        }} />
      <Select size="xs" tone={activeLane?.writeMode === "touch" ? "warning-soft" : activeLane?.writeMode === "latch" ? "accent-soft" : activeLane?.writeMode === "write" ? "danger-soft" : undefined} className={`${compact ? "w-14" : "w-16"} shrink-0`} aria-label="Automation write mode"
        value={activeLane?.writeMode ?? "read"} isDisabled={disabled || !activeLane}
        options={["read", "touch", "latch", "write"].map((id) => ({
          id,
          label: id[0].toUpperCase() + id.slice(1),
          textValue: id[0].toUpperCase() + id.slice(1),
        }))}
        title={
          activeLane?.writeMode === "touch"
            ? "Touch: records automation while touched, return ramp on release"
            : activeLane?.writeMode === "latch"
              ? "Latch: records automation while touched, holds value until stop"
              : activeLane?.writeMode === "write"
                ? "Write: continuously overwrites automation during playback"
                : "Read: plays back existing automation curve"
        }
        onChange={(writeMode) => activeLane && void run(() => builder.automationLaneUpdate({ songIndex,
          laneId: activeLane.id, writeMode: writeMode as AutomationLaneRow["writeMode"] }))} />
      <Tooltip content={addTooltip}><Button isIconOnly size="sm" variant="ghost" className={`${compact ? "h-4.5 min-w-4.5 w-4.5" : "h-5.5 min-w-5.5 w-5.5"} shrink-0`}
        aria-label="Add automation"
        isDisabled={!canAdd} onPress={add}><Plus size={compact ? 10 : 12} /></Button></Tooltip>
      {activeLane && <Tooltip content="Remove automation lane"><Button isIconOnly size="sm" variant="ghost" className={`${compact ? "h-4.5 min-w-4.5 w-4.5" : "h-5.5 min-w-5.5 w-5.5"} shrink-0`}
        aria-label="Remove automation" isDisabled={disabled}
        onPress={() => onRemoveLane ? onRemoveLane(activeLane.id)
          : void run(() => builder.automationLaneRemove(songIndex, activeLane.id))}><Trash2 size={compact ? 10 : 11} /></Button></Tooltip>}
      {error && <span role="alert" className="text-danger shrink-0" title={error}>!</span>}
    </div>
  );
});
