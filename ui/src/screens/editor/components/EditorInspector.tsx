// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  mixer,
  pluginCatalog as pluginCatalogApi,
  type PluginCatalogEntry,
} from "@/lib/state/api";
import {
  type MidiRegionRow,
  type RegionRow,
  type WebUiState,
} from "@/lib/state/types";
import { ScrollShadow } from "@/components/ui";
import { PluginChainModal } from "@/screens/mixer/plugins/PluginChainModal";
import { extOutTarget } from "@/screens/mixer/logic/mixerIds";
import { BusStrip } from "@/screens/mixer/strips/BusStrip";
import { TrackStrip } from "@/screens/mixer/strips/TrackStrip";
import {
  DEFAULT_INSPECTOR_OVERFLOW_WIDTH,
  DEFAULT_INSPECTOR_WIDTH,
  MAX_INSPECTOR_WIDTH,
  MIN_INSPECTOR_WIDTH,
  resolveInspectorBusses,
} from "@/screens/editor/logic/inspectorRouting";

export function EditorInspector({
  state,
  selectedTrackId,
  selectedRegion: _selectedRegion,
  onClose: _onClose,
}: {
  state: WebUiState;
  selectedTrackId: string | null;
  selectedRegion?: RegionRow | MidiRegionRow | null;
  onClose?: () => void;
}) {
  const [effectCatalog, setEffectCatalog] = useState<PluginCatalogEntry[]>([]);
  const [pluginTarget, setPluginTarget] = useState<{
    stripId: string;
    stripName: string;
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    pluginCatalogApi
      .list()
      .then((r) => {
        if (!disposed) setEffectCatalog(r.catalog.plugins);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  const openPlugins = useCallback((stripId: string, stripName: string) => {
    setPluginTarget({ stripId, stripName });
  }, []);

  // Find selected track, or default to first track
  const trackIndex = Math.max(
    0,
    state.tracks.findIndex((t) => t.id === selectedTrackId),
  );
  const selectedTrack = state.tracks[trackIndex] ?? null;

  const auxBusses = state.busses.filter((b) => b.isAux);
  const destinationBusses = state.busses.filter((b) => !b.isAux);

  const { sendBusses, showMaster, master } = resolveInspectorBusses({
    selectedTrack,
    busses: state.busses,
  });
  const masterIndex = master ? state.busses.indexOf(master) : -1;

  const stripCount =
    (selectedTrack ? 1 : 0) +
    sendBusses.length +
    (showMaster && master ? 1 : 0);
  const targetDefaultWidth =
    stripCount > 2 ? DEFAULT_INSPECTOR_OVERFLOW_WIDTH : DEFAULT_INSPECTOR_WIDTH;

  // Custom user-resized width from localStorage or active drag.
  // When null, automatically uses targetDefaultWidth (218px for <= 2 strips, 254px for > 2 strips to fit the ScrollShadow).
  const [customWidth, setCustomWidth] = useState<number | null>(() => {
    if (typeof localStorage !== "undefined") {
      const saved = Number(localStorage.getItem("resostage:inspector-width"));
      if (
        Number.isFinite(saved) &&
        saved >= MIN_INSPECTOR_WIDTH &&
        saved <= MAX_INSPECTOR_WIDTH
      ) {
        return saved;
      }
    }
    return null;
  });

  const width = customWidth ?? targetDefaultWidth;

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    dragStartRef.current = { startX: e.clientX, startWidth: width };

    const handlePointerMove = (ev: PointerEvent) => {
      if (!dragStartRef.current) return;
      const delta = ev.clientX - dragStartRef.current.startX;
      const nextWidth = Math.max(
        MIN_INSPECTOR_WIDTH,
        Math.min(
          MAX_INSPECTOR_WIDTH,
          Math.round(dragStartRef.current.startWidth + delta),
        ),
      );
      setCustomWidth(nextWidth);
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("resostage:inspector-width", String(nextWidth));
      }
    };

    const handlePointerUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCustomWidth(null);
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("resostage:inspector-width");
    }
  };

  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  // Max plugin slots aligned across inspector strips:
  const inspectorStrips = [
    selectedTrack,
    ...sendBusses,
    showMaster ? master : null,
  ].filter(Boolean);
  const maxPluginSlots = Math.max(
    1,
    ...inspectorStrips.map(
      (s) => (s?.plugins?.filter((p) => !p.instrument).length ?? 0) + 1,
    ),
  );

  const requestTrackDirectOutput = useCallback(
    (tIdx: number, _mono: boolean, startChannel: number, pair: boolean) => {
      void mixer.setTrackBus(tIdx, extOutTarget(startChannel, pair));
    },
    [],
  );

  const anyTrackSolo = state.tracks.some((t) => t.solo);

  return (
    <>
      <aside
        style={{ width: `${width}px` }}
        className={`flex h-full shrink-0 select-none flex-col rounded-xl border border-default/30 bg-background-secondary z-20 text-xs overflow-hidden ${
          isDragging
            ? "transition-none"
            : "transition-[width] duration-150 ease-out"
        }`}
        aria-label="Channel Strip Inspector"
      >
        {/* ── Channel Strips Container with ScrollShadow ── */}
        <ScrollShadow
          orientation="horizontal"
          size={30}
          className="flex min-h-0 flex-1 flex-row items-stretch gap-2 px-2 py-2 overflow-x-auto overflow-y-hidden"
        >
          {selectedTrack ? (
            <div className="flex h-full min-h-0 shrink-0">
              <TrackStrip
                t={selectedTrack}
                index={trackIndex}
                destinationBusses={destinationBusses}
                allBusses={state.busses}
                auxBusses={auxBusses}
                meters={state.meters}
                settings={state.settings}
                anySoloInGroup={anyTrackSolo}
                pluginCatalog={effectCatalog}
                isRecording={state.recording ?? false}
                density="standard"
                targetPluginSlots={maxPluginSlots}
                onDirectOutput={requestTrackDirectOutput}
                onOpenPlugins={openPlugins}
              />
            </div>
          ) : (
            <div className="flex h-full w-24 items-center justify-center p-2 text-center text-foreground/40 text-[10px]">
              No track
            </div>
          )}

          {sendBusses.map((bus) => {
            const bIndex = state.busses.indexOf(bus);
            return (
              <div key={bus.id} className="flex h-full min-h-0 shrink-0">
                <BusStrip
                  b={bus}
                  index={bIndex >= 0 ? bIndex : 0}
                  meters={state.meters}
                  master={master}
                  settings={state.settings}
                  anySoloInGroup={bus.soloActiveInGroup}
                  isMaster={false}
                  pluginCatalog={effectCatalog}
                  density="standard"
                  targetPluginSlots={maxPluginSlots}
                  onOpenPlugins={openPlugins}
                />
              </div>
            );
          })}

          {showMaster && master ? (
            <div key={master.id} className="flex h-full min-h-0 shrink-0">
              <BusStrip
                b={master}
                index={masterIndex >= 0 ? masterIndex : 0}
                meters={state.meters}
                master={master}
                settings={state.settings}
                anySoloInGroup={master.soloActiveInGroup}
                isMaster={true}
                pluginCatalog={effectCatalog}
                density="standard"
                targetPluginSlots={maxPluginSlots}
                onOpenPlugins={openPlugins}
              />
            </div>
          ) : null}
        </ScrollShadow>
      </aside>

      {/* ── Vertical Division Line / Resizer ── */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
        className="group relative flex w-2.5 shrink-0 cursor-col-resize items-center justify-center -mx-1 select-none z-30"
        title="Drag to resize inspector, double-click to reset"
      >
        {/* Base subtle division track */}
        <div className="h-full w-0.5 rounded-full bg-default/20" />

        {/* Accent background hit-zone overlay with smooth transition */}
        <div
          className={`absolute inset-y-0 w-full rounded-md bg-accent/15 pointer-events-none transition-opacity duration-200 ease-out ${
            isDragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        />

        {/* Accent solid indicator overlay with smooth transition (no glow) */}
        <div
          className={`absolute inset-y-0 w-0.75 rounded-full bg-accent pointer-events-none transition-opacity duration-200 ease-out ${
            isDragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        />
      </div>

      {/* Audio FX / Instrument Plug-in Editor Modal */}
      {pluginTarget && (
        <PluginChainModal
          open
          stripId={pluginTarget.stripId}
          stripName={pluginTarget.stripName}
          track={selectedTrack?.id === pluginTarget.stripId ? selectedTrack : undefined}
          songIndex={Math.max(0, state.songIndex)}
          song={state.songs[Math.max(0, state.songIndex)]}
          slots={
            selectedTrack && selectedTrack.id === pluginTarget.stripId
              ? (selectedTrack.plugins ?? [])
              : (state.busses.find((b) => b.id === pluginTarget.stripId)
                  ?.plugins ?? [])
          }
          onClose={() => setPluginTarget(null)}
        />
      )}
    </>
  );
}
