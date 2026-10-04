/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useMemo, useState } from "react";
import { Button, Select, type SelectOption } from "@/components/ui";
import { pluginChains } from "@/lib/state/api";
import type {
  BusRow,
  PluginParameterList,
  PluginSidechainChannelMode,
  PluginSidechainRoute,
  PluginSlotRow,
  TrackRow,
} from "@/lib/state/types";
import { pluginSidechainSources } from "@/screens/mixer/plugins/logic/sidechainSources";

const CHANNEL_MODES: readonly SelectOption[] = [
  { id: "automatic", label: "Automatic" },
  { id: "mono-sum", label: "Mono sum" },
  { id: "left", label: "Left channel" },
  { id: "right", label: "Right channel" },
];

function routeIdentity(route: PluginSidechainRoute | null | undefined): string {
  return JSON.stringify(route
    ? [route.sourceStripId, route.inputBusIndex, route.channelMode]
    : null);
}

function matchesIdentity(metadata: PluginParameterList, stripId: string, slotId: string): boolean {
  return metadata.slotId === slotId
    && (metadata.stripId === undefined || metadata.stripId === stripId);
}

export function PluginSidechainControls({
  stripId,
  destinationStripId,
  slot,
  tracks,
  busses,
}: {
  stripId: string;
  destinationStripId: string;
  slot: PluginSlotRow;
  tracks: readonly TrackRow[];
  busses: readonly BusRow[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [metadata, setMetadata] = useState<PluginParameterList | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sourceId, setSourceId] = useState(slot.sidechain?.sourceStripId ?? "");
  const [busIndex, setBusIndex] = useState(
    slot.sidechain ? String(slot.sidechain.inputBusIndex) : "",
  );
  const [channelMode, setChannelMode] = useState<PluginSidechainChannelMode>(
    slot.sidechain?.channelMode ?? "automatic",
  );
  const persistedRouteKey = routeIdentity(slot.sidechain);
  const sourceOptions = useMemo(
    () => pluginSidechainSources(tracks, busses, destinationStripId),
    [tracks, busses, destinationStripId],
  );
  const persistedSourceId = slot.sidechain?.sourceStripId ?? "";
  const persistedBusIndex = slot.sidechain ? String(slot.sidechain.inputBusIndex) : "";
  const persistedChannelMode = slot.sidechain?.channelMode ?? "automatic";

  useEffect(() => {
    setSourceId(persistedSourceId);
    setBusIndex(persistedBusIndex);
    setChannelMode(persistedChannelMode);
  }, [persistedRouteKey, persistedSourceId, persistedBusIndex, persistedChannelMode]);

  useEffect(() => {
    if (!expanded || slot.loadState !== "loaded") {
      setMetadata(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    void pluginChains.parameters(stripId, slot.id)
      .then((result) => {
        if (!active) return;
        if (!matchesIdentity(result, stripId, slot.id)) {
          setMetadata(null);
          setError("Core returned capabilities for a different plug-in slot.");
          return;
        }
        setMetadata(result);
        if (result.loadState !== "loaded")
          setError(result.loadError || "Plug-in capabilities are not ready yet.");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setMetadata(null);
        setError(reason instanceof Error ? reason.message : "Could not read plug-in inputs.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [expanded, stripId, slot.id, slot.loadState, slot.hostGeneration]);

  const supportedBuses = metadata?.sidechainBuses ?? [];
  const busOptions: SelectOption[] = supportedBuses.map((bus) => ({
    id: String(bus.busIndex),
    label: `${bus.name || `Aux ${bus.busIndex}`} · ${bus.channelCount} ch`,
  }));
  if (slot.sidechain && !supportedBuses.some(
    (bus) => bus.busIndex === slot.sidechain?.inputBusIndex,
  )) {
    busOptions.push({
      id: String(slot.sidechain.inputBusIndex),
      label: `Unavailable auxiliary input ${slot.sidechain.inputBusIndex}`,
      isDisabled: true,
    });
  }
  const availableSources: SelectOption[] = sourceOptions.map((source) => ({
    id: source.id,
    label: source.label,
  }));
  if (slot.sidechain && !sourceOptions.some(
    (source) => source.id === slot.sidechain?.sourceStripId,
  )) {
    availableSources.push({
      id: slot.sidechain.sourceStripId,
      label: `Unavailable source · ${slot.sidechain.sourceStripId}`,
      isDisabled: true,
    });
  }

  const selectedBusIsSupported = supportedBuses.some(
    (bus) => String(bus.busIndex) === busIndex && bus.channelCount > 0,
  );
  const selectedSourceIsAvailable = sourceOptions.some(
    (source) => source.id === sourceId,
  );
  const nextRoute = sourceId && busIndex
    ? {
        sourceStripId: sourceId,
        inputBusIndex: Number(busIndex),
        channelMode,
      } satisfies PluginSidechainRoute
    : null;
  const hasChanges = routeIdentity(nextRoute) !== persistedRouteKey;
  const canApply = slot.loadState === "loaded"
    && !loading && metadata?.loadState === "loaded"
    && nextRoute !== null && selectedSourceIsAvailable
    && selectedBusIsSupported && hasChanges;

  const apply = async () => {
    if (!nextRoute || !canApply) return;
    setSaving(true);
    setError("");
    try {
      await pluginChains.setSidechain(stripId, slot.id, nextRoute);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update sidechain route.");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!slot.sidechain || saving) return;
    setSaving(true);
    setError("");
    try {
      await pluginChains.setSidechain(stripId, slot.id, null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not disconnect sidechain.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1">
      <Button
        size="sm"
        variant={slot.sidechain ? "secondary" : "ghost"}
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
      >
        {slot.sidechain ? "Sidechain · On" : "Sidechain"}
      </Button>
      {expanded && (
        <div className="mt-2 grid gap-2 rounded-lg border border-default/30 bg-surface-secondary p-3">
          {slot.loadState !== "loaded" ? (
            <p className="text-[11px] text-foreground/55">
              {slot.loadState === "loading"
                ? "Waiting for this plug-in to finish loading…"
                : slot.loadState
                  ? `Plug-in is ${slot.loadState}; disconnecting a saved route is still available.`
                  : "This Core does not report plug-in readiness; disconnecting a saved route is still available."}
            </p>
          ) : loading ? (
            <p className="text-[11px] text-foreground/55">Reading auxiliary inputs…</p>
          ) : metadata?.loadState === "loaded" && supportedBuses.length === 0 ? (
            <p className="text-[11px] text-foreground/55">
              This plug-in does not expose an auxiliary audio input.
            </p>
          ) : (
            <>
              <Select
                aria-label={`Sidechain source for ${slot.name}`}
                size="sm"
                placeholder="Choose an audio source"
                options={availableSources}
                value={sourceId}
                onChange={setSourceId}
                isDisabled={slot.loadState !== "loaded" || supportedBuses.length === 0}
              />
              <Select
                aria-label={`Sidechain input for ${slot.name}`}
                size="sm"
                placeholder="Choose an auxiliary input"
                options={busOptions}
                value={busIndex}
                onChange={setBusIndex}
                isDisabled={slot.loadState !== "loaded" || supportedBuses.length === 0}
              />
              <Select
                aria-label={`Sidechain channel mapping for ${slot.name}`}
                size="sm"
                options={CHANNEL_MODES}
                value={channelMode}
                onChange={(value) => setChannelMode(value as PluginSidechainChannelMode)}
                isDisabled={slot.loadState !== "loaded" || supportedBuses.length === 0}
              />
            </>
          )}
          {metadata?.sidechainBusMetadataTruncated && (
            <p className="text-[11px] text-warning">
              The host bus catalog is truncated; only explicitly listed inputs can be selected.
            </p>
          )}
          {sourceOptions.length === 0 && (
            <p className="text-[11px] text-foreground/45">
              Add another rendered audio track or bus to use as a source.
            </p>
          )}
          {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            {slot.sidechain && (
              <Button size="sm" variant="ghost" isDisabled={saving} onPress={() => void disconnect()}>
                Disconnect
              </Button>
            )}
            <Button size="sm" variant="outline" isDisabled={!canApply || saving} onPress={() => void apply()}>
              {saving ? "Applying…" : "Apply"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
