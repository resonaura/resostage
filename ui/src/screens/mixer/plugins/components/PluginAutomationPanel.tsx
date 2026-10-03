/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { builder, pluginChains } from "@/lib/state/api";
import { createEditGesture } from "@/lib/interaction/editGesture";
import type { PluginSlotRow, SongRow } from "@/lib/state/types";
import { Button } from "@/components/ui";
import { AutomationMiniGraph } from "@/screens/mixer/plugins/components/AutomationMiniGraph";
import { PluginParameterValueReadout } from "@/screens/mixer/plugins/components/PluginParameterValueReadout";

interface PluginParameter {
  index: number;
  name: string;
  label: string;
  defaultValue: number;
  steps: number;
  automatable: boolean;
}

type PluginParameterCatalog = {
  identity: string;
  state: "idle" | "loading" | "loaded" | "missing" | "failed";
  parameters: PluginParameter[];
};

/**
 * Parameter discovery and automation lane editing for one plug-in chain.
 * Keep this component mounted while switching the adjacent catalog view so the
 * selected plug-in, parameter, and parameter request lifetime stay unchanged.
 */
export function PluginAutomationPanel({
  visible,
  slots,
  song,
  songIndex,
  valueIdentity,
}: {
  visible: boolean;
  slots: PluginSlotRow[];
  song?: SongRow;
  songIndex: number;
  valueIdentity: string;
}) {
  const [automationSlotId, setAutomationSlotId] = useState("");
  const [parameterCatalog, setParameterCatalog] = useState<PluginParameterCatalog>({
    identity: "",
    state: "idle",
    parameters: [],
  });
  const [automationParameterIndex, setAutomationParameterIndex] = useState<number | null>(null);
  const [automationSearch, setAutomationSearch] = useState("");
  const [automationError, setAutomationError] = useState("");
  const editGesture = useRef(createEditGesture()).current;
  const automationSlot = slots.find((slot) => slot.id === automationSlotId) ?? null;
  const automationSlotIdentity = JSON.stringify([
    valueIdentity,
    automationSlot?.id ?? "",
    automationSlot?.pluginId ?? "",
    automationSlot?.loadState ?? "",
  ]);
  const automationSlotLoadState = automationSlot?.loadState ?? "";
  const currentParameterCatalog = parameterCatalog.identity === automationSlotIdentity
    ? parameterCatalog
    : { identity: automationSlotIdentity, state: "loading" as const, parameters: [] };
  const automationParameters = currentParameterCatalog.parameters;

  useEffect(() => {
    if (!slots.some((slot) => slot.id === automationSlotId))
      setAutomationSlotId(slots.find((slot) => slot.loadState === "loaded")?.id ?? slots[0]?.id ?? "");
  }, [automationSlotId, slots]);

  useEffect(() => {
    if (!visible) return;
    if (!automationSlotId || automationSlotLoadState !== "loaded") {
      setParameterCatalog({
        identity: automationSlotIdentity,
        state: "idle",
        parameters: [],
      });
      setAutomationParameterIndex(null);
      return;
    }
    let disposed = false;
    setAutomationError("");
    setParameterCatalog({
      identity: automationSlotIdentity,
      state: "loading",
      parameters: [],
    });
    setAutomationParameterIndex(null);
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    async function loadParameters() {
      try {
        const response = await pluginChains.parameters(automationSlotId);
        if (disposed) return;
        if (response.slotId !== automationSlotId) {
          setParameterCatalog({
            identity: automationSlotIdentity,
            state: "failed",
            parameters: [],
          });
          setAutomationError("Plug-in identity changed while reading parameters.");
          return;
        }
        if (response.loadState === "loading") {
          setParameterCatalog({
            identity: automationSlotIdentity,
            state: "loading",
            parameters: [],
          });
          setAutomationError(response.loadError);
          if (visible)
            retryTimer = setTimeout(() => void loadParameters(), 250);
          return;
        }
        if (response.loadState !== "loaded") {
          setParameterCatalog({
            identity: automationSlotIdentity,
            state: response.loadState,
            parameters: [],
          });
          setAutomationError(response.loadError);
          return;
        }
        const automatableParameters = response.parameters.filter(
          (parameter) => parameter.automatable === true,
        );
        setParameterCatalog({
          identity: automationSlotIdentity,
          state: "loaded",
          parameters: automatableParameters,
        });
        setAutomationParameterIndex(automatableParameters[0]?.index ?? null);
      } catch (reason: unknown) {
        if (!disposed) {
          setParameterCatalog({
            identity: automationSlotIdentity,
            state: "failed",
            parameters: [],
          });
          setAutomationError(reason instanceof Error ? reason.message : "Could not read plug-in parameters");
        }
      }
    }
    void loadParameters();
    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [automationSlotId, automationSlotIdentity, automationSlotLoadState, visible]);

  const filteredAutomationParameters = automationParameters.filter((parameter) =>
    `${parameter.name} ${parameter.label}`.toLocaleLowerCase().includes(automationSearch.trim().toLocaleLowerCase()),
  );
  const selectedParameter = automationParameters.find(
    (parameter) => parameter.index === automationParameterIndex,
  ) ?? null;
  const automationLanes = (song?.automationLanes ?? []).filter(
    (lane) => lane.target.domain === "plugin" && slots.some((slot) => slot.id === lane.target.entityId),
  );
  const selectedAutomationLane = automationSlot && selectedParameter
    ? automationLanes.find((lane) => lane.target.entityId === automationSlot.id
      && lane.target.parameterId === `param:${selectedParameter.index}`)
    : undefined;

  const addAutomationLane = async () => {
    if (!automationSlot || !selectedParameter || !song) return;
    try {
      setAutomationError("");
      await builder.automationLaneAdd({
        songIndex,
        domain: "plugin",
        entityId: automationSlot.id,
        parameterId: `param:${selectedParameter.index}`,
        valueType: "floatNormalized",
        defaultValue: selectedParameter.defaultValue,
        minValue: 0,
        maxValue: 1,
        scope: "track",
        writeMode: "read",
        initialTimeBeats: 0,
        initialValue: selectedParameter.defaultValue,
        gestureId: editGesture.id(),
      });
    } catch (reason) {
      setAutomationError(reason instanceof Error ? reason.message : "Could not add automation lane");
    }
  };

  return (
    <div className={visible ? "mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" : "hidden"}>
      {!song ? (
        <p className="text-xs text-foreground/45">Automation is available from the Editor.</p>
      ) : slots.length === 0 ? (
        <p className="text-xs text-foreground/45">Add a plug-in to this chain first.</p>
      ) : <>
        <label className="grid gap-1 text-[10px] font-semibold uppercase tracking-wide text-foreground/45">
          Plug-in
          <select value={automationSlotId} onChange={(event) => setAutomationSlotId(event.target.value)}
            className="h-9 rounded-lg border border-default/35 bg-surface px-2 text-xs font-normal normal-case text-foreground outline-none focus:border-accent">
            {slots.map((slot) => <option key={slot.id} value={slot.id}>{slot.name || "Unknown plug-in"}</option>)}
          </select>
        </label>
        <input value={automationSearch} onChange={(event) => setAutomationSearch(event.target.value)}
          placeholder="Find a parameter…" aria-label="Search plug-in parameters"
          className="h-9 rounded-lg border border-default/35 bg-surface px-3 text-xs outline-none focus:border-accent" />
        {automationSlot?.loadState !== "loaded" ? (
          <p className="text-xs text-foreground/45">Waiting for the isolated plug-in host to finish loading this plug-in…</p>
        ) : currentParameterCatalog.state === "loading" ? (
          <p className="text-xs text-foreground/45">Loading plug-in parameters…</p>
        ) : currentParameterCatalog.state === "failed" || currentParameterCatalog.state === "missing" ? (
          <p className="text-xs text-foreground/45">{automationError || "Could not read plug-in parameters."}</p>
        ) : automationParameters.length === 0 ? (
          <p className="text-xs text-foreground/45">This plug-in exposes no automatable parameters.</p>
        ) : (
          <div className="min-h-0 max-h-40 overflow-y-auto rounded-lg border border-default/25 bg-surface">
            {filteredAutomationParameters.map((parameter) => (
              <button type="button" key={parameter.index}
                onClick={() => setAutomationParameterIndex(parameter.index)}
                className={`flex w-full items-center justify-between gap-2 border-b border-default/15 px-2.5 py-2 text-left last:border-b-0 ${automationParameterIndex === parameter.index ? "bg-accent/10 text-accent" : "hover:bg-default/10"}`}>
                <span className="min-w-0 truncate text-xs">{parameter.name}</span>
                <span className="shrink-0 text-[10px] text-foreground/40">{parameter.label || `#${parameter.index + 1}`}</span>
              </button>
            ))}
          </div>
        )}
        {selectedParameter && (
          <div className="rounded-lg border border-default/25 bg-surface p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold">{selectedParameter.name}</div>
                <div className="text-[10px] text-foreground/40">Normalized plug-in parameter</div>
              </div>
              <PluginParameterValueReadout
                enabled={visible}
                slot={automationSlot}
                parameter={selectedParameter}
                valueIdentity={valueIdentity}
              />
              {selectedAutomationLane ? (
                <Button size="sm" variant="danger-soft" onPress={() => void builder.automationLaneRemove(songIndex, selectedAutomationLane.id, editGesture.id())}>
                  <Trash2 size={12} /> Remove
                </Button>
              ) : (
                <Button size="sm" variant="accent-soft" onPress={() => void addAutomationLane()}>
                  <Plus size={12} /> Add lane
                </Button>
              )}
            </div>
            {selectedAutomationLane && (
              <AutomationMiniGraph lane={selectedAutomationLane} song={song!} songIndex={songIndex} parameterSteps={selectedParameter.steps} />
            )}
          </div>
        )}
        {automationError && <p className="text-[10px] text-danger">{automationError}</p>}
        <p className="text-[10px] leading-relaxed text-foreground/40">
          Click the curve to add a point, drag to edit it, or Option-click to remove. Parameter names come from the isolated host; plug-in failures remain contained there.
        </p>
      </>}
    </div>
  );
}
