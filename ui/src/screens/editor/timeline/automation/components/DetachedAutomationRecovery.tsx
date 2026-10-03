/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, Link2, Trash2 } from "lucide-react";
import { Button, Select } from "@/components/ui";
import { builder } from "@/lib/state/api";
import type { AutomationLaneRow, BusRow, PluginParameterList, SongRow, TrackRow } from "@/lib/state/types";
import {
  getDetachedPluginAutomationLanes,
  getTrackAutomationTargets,
} from "@/screens/editor/timeline/automation/logic/automationTargets";
import { getPluginParameterList } from "@/screens/editor/timeline/automation/logic/pluginParameterIdentity";
import type { AutomationTargetOption } from "@/screens/editor/timeline/automation/logic/types";

type RebindTarget = AutomationTargetOption & { section: string };

export function DetachedAutomationRecovery({
  songIndex,
  song,
  tracks,
  buses,
  parameters,
  readOnly,
  onRevealAutomation,
}: {
  songIndex: number;
  song?: SongRow;
  tracks: TrackRow[];
  buses?: BusRow[];
  parameters: Readonly<Record<string, PluginParameterList>>;
  readOnly: boolean;
  onRevealAutomation: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedTargets, setSelectedTargets] = useState<Record<string, string>>({});
  const [pendingLaneId, setPendingLaneId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detached = useMemo(() => getDetachedPluginAutomationLanes(tracks, song, parameters),
    [tracks, song, parameters]);
  const pluginLanes = useMemo(() => [
    ...(song?.automationLanes ?? []),
    ...(song?.regions ?? []).flatMap((region) => region.automationLanes ?? []),
    ...(song?.midiRegions ?? []).flatMap((region) => region.automationLanes ?? []),
  ].filter((lane) => lane.target.domain === "plugin"), [song]);
  const checkingBindings = expanded && pluginLanes.some((lane) => {
    const matches = tracks.flatMap((track) => (track.plugins ?? [])
      .filter((candidate) => candidate.id === lane.target.entityId)
      .map((slot) => ({ track, slot })));
    if (matches.length !== 1) return false;
    const { track, slot } = matches[0];
    const metadata = getPluginParameterList(parameters, track.stripId ?? track.id, slot.id);
    return !metadata || metadata.loadState === "loading";
  });
  const targets = useMemo<RebindTarget[]>(() => tracks.flatMap((track) =>
    getTrackAutomationTargets(track, buses, [], parameters)
      .flatMap((group) => group.targets)
      .filter((target) => target.category === "plugin" && !target.disabledReason)
      .map((target) => ({
        ...target,
        label: `${track.name} · ${target.label}`,
        section: track.name,
      }))), [tracks, buses, parameters]);
  const targetsById = useMemo(() => new Map(targets.map((target) => [target.id, target])), [targets]);
  const options = useMemo(() => targets.map((target) => ({
    id: target.id,
    label: target.label,
    textValue: target.label,
    section: target.section,
  })), [targets]);

  if (pluginLanes.length === 0) return null;

  const rebind = async (lane: AutomationLaneRow) => {
    const target = targetsById.get(selectedTargets[lane.id] ?? "");
    if (!target || readOnly || pendingLaneId) return;
    setPendingLaneId(lane.id);
    setError(null);
    try {
      await builder.automationLaneUpdate({
        songIndex,
        laneId: lane.id,
        target: {
          domain: "plugin",
          entityId: target.entityId,
          parameterId: target.parameterId,
          valueType: target.valueType,
          defaultValue: target.defaultValue,
          minValue: target.minValue,
          maxValue: target.maxValue,
        },
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPendingLaneId(null);
    }
  };

  const remove = async (lane: AutomationLaneRow) => {
    if (readOnly || pendingLaneId) return;
    setPendingLaneId(lane.id);
    setError(null);
    try {
      await builder.automationLaneRemove(songIndex, lane.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPendingLaneId(null);
    }
  };
  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) onRevealAutomation();
  };

  return (
    <section
      className="shrink-0 border-b border-warning/25 bg-warning/5 px-3 py-1.5 text-xs"
      aria-label="Detached automation recovery"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AlertTriangle size={13} className="shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-foreground">
          {detached.length > 0
            ? `${detached.length} plug-in automation ${detached.length === 1 ? "lane is" : "lanes are"} detached`
            : checkingBindings ? "Checking plug-in automation bindings…"
              : "Review plug-in automation bindings"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          onPress={toggleExpanded}
        >
          {expanded ? "Hide" : "Review and recover"}
        </Button>
      </div>
      {expanded && (
        <div className="mt-2 grid gap-1.5">
          <p className="text-muted">
            {detached.length > 0
              ? "Curves are preserved. Rebind a lane to an available plug-in parameter or remove it."
              : checkingBindings
                ? "Waiting for plug-in parameter descriptors before checking existing lanes."
                : "All plug-in automation lanes are bound to available parameters."}
          </p>
          {detached.map(({ lane, location, reason }) => {
            const selectedTargetId = selectedTargets[lane.id] ?? "";
            const canRebind = Boolean(targetsById.get(selectedTargetId));
            const pending = pendingLaneId === lane.id;
            return (
              <div key={`${location}:${lane.id}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(12rem,2fr)_auto_auto] items-center gap-2 rounded-md border border-default/30 bg-surface/80 p-2">
                <div className="min-w-0">
                  <div className="truncate text-foreground" title={`${location} · ${lane.target.parameterId}`}>
                    {location} · {lane.target.parameterId}
                  </div>
                  <div className="text-muted">
                    {reason === "slot-missing" ? "Plug-in slot is no longer in this project"
                      : reason === "slot-ambiguous" ? "Plug-in slot ID is duplicated; this lane cannot identify its original strip"
                        : reason === "plugin-unavailable" ? "Plug-in is missing or failed to load"
                          : "Parameter is no longer exposed as automatable"}
                    {` · ${lane.points.length} points preserved`}
                  </div>
                </div>
                <Select
                  size="sm"
                  variant="secondary"
                  aria-label={`Rebind ${lane.target.parameterId}`}
                  placeholder={targets.length === 0 ? "No loaded parameters" : "Choose destination"}
                  value={selectedTargetId}
                  options={options}
                  isDisabled={readOnly || pending || targets.length === 0}
                  onChange={(targetId) => setSelectedTargets((current) => ({ ...current, [lane.id]: targetId }))}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={readOnly || pending || !canRebind}
                  onPress={() => void rebind(lane)}
                >
                  <Link2 size={13} />
                  Rebind
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="danger-soft"
                  aria-label={`Remove detached lane ${lane.target.parameterId}`}
                  isDisabled={readOnly || pending}
                  onPress={() => void remove(lane)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            );
          })}
          {targets.length === 0 && (
            <p className="text-muted">Load a plug-in with automatable parameters to recover these lanes.</p>
          )}
          {error && <p role="alert" className="text-danger">{error}</p>}
        </div>
      )}
    </section>
  );
}
