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
  parameters = {}, readOnly = false,
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
}) {
  const groups = useMemo(() => getTrackAutomationTargets(track, buses, lanes, parameters), [track, buses, lanes, parameters]);
  const targets = groups.flatMap((group) => group.targets);
  const activeLane = lanes.find((lane) => lane.id === activeLaneId)
    ?? (targets.some((target) => target.id === activeLaneId) ? undefined : lanes[0]);
  const target = activeLane ? targets.find((option) => matchesAutomationTarget(option, activeLane.target))
    : targets.find((option) => option.id === activeLaneId) ?? targets[0];
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
  const add = () => {
    if (!target || target.disabledReason) return;
    const existing = lanes.find((lane) => matchesAutomationTarget(target, lane.target));
    if (existing) { onSelectLane(existing.id); return; }
    void run(() => builder.automationLaneAdd({ songIndex, domain: target.domain,
      entityId: target.entityId, parameterId: target.parameterId,
      valueType: target.valueType, defaultValue: target.defaultValue,
      minValue: target.minValue, maxValue: target.maxValue, scope: "track",
      writeMode: "read", points: [] }));
    onSelectLane(target.id);
  };
  const disabled = readOnly || pending;
  return (
    <div className="flex h-7 min-w-0 items-center gap-1 px-1.5 text-xs"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}>
      <Tooltip content={activeLane?.muted ? "Enable automation" : "Mute automation"}><Button isIconOnly size="sm" variant={activeLane?.enabled && !activeLane.muted ? "accent-soft" : "ghost"}
        className="h-5.5 min-w-5.5 w-5.5 shrink-0" aria-label="Enable automation"
        isDisabled={disabled || !activeLane}
        onPress={() => activeLane && void run(() => builder.automationLaneUpdate({ songIndex,
          laneId: activeLane.id, enabled: true, muted: !activeLane.muted }))}><Power size={12} /></Button></Tooltip>
      <Select size="xs" variant="secondary" className="min-w-0 flex-1" aria-label="Automation parameter"
        title={error ?? target?.disabledReason ?? "Automation parameter"}
        value={target?.id} isDisabled={disabled}
        options={groups.flatMap((group) => group.targets.map((option) => ({
          id: option.id, label: option.label, section: group.categoryLabel,
          // Existing unbound data stays selectable and recoverable.
          isDisabled: Boolean(option.disabledReason) && !lanes.some((lane) => matchesAutomationTarget(option, lane.target)),
        })))}
        onChange={(id) => {
          const selected = targets.find((option) => option.id === id);
          const existing = selected && lanes.find((lane) => matchesAutomationTarget(selected, lane.target));
          onSelectLane(existing?.id ?? id);
        }} />
      <Select size="xs" variant="secondary" className="w-16 shrink-0" aria-label="Automation write mode"
        value={activeLane?.writeMode ?? "read"} isDisabled={disabled || !activeLane}
        options={["read", "touch", "latch", "write"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1),
          isDisabled: id !== "read" }))}
        title="Read playback; live Touch/Latch/Write recording is not available yet"
        onChange={(writeMode) => activeLane && void run(() => builder.automationLaneUpdate({ songIndex,
          laneId: activeLane.id, writeMode: writeMode as AutomationLaneRow["writeMode"] }))} />
      <Tooltip content={target?.disabledReason ?? "Add automation for selected parameter"}><Button isIconOnly size="sm" variant="ghost" className="h-5.5 min-w-5.5 w-5.5 shrink-0"
        aria-label="Add automation"
        isDisabled={disabled || !target || Boolean(target.disabledReason) || Boolean(activeLane)} onPress={add}><Plus size={12} /></Button></Tooltip>
      {activeLane && <Tooltip content="Remove automation lane"><Button isIconOnly size="sm" variant="ghost" className="h-5.5 min-w-5.5 w-5.5 shrink-0"
        aria-label="Remove automation" isDisabled={disabled}
        onPress={() => onRemoveLane ? onRemoveLane(activeLane.id)
          : void run(() => builder.automationLaneRemove(songIndex, activeLane.id))}><Trash2 size={11} /></Button></Tooltip>}
      {error && <span role="alert" className="text-danger shrink-0" title={error}>!</span>}
    </div>
  );
});
