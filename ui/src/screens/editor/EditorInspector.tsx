import {
  ChevronDown,
  ChevronRight,
  Mic,
  Music,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  builder,
  mixer,
  pluginCatalog as pluginCatalogApi,
  type PluginCatalogEntry,
} from "../../lib/api";
import {
  sourceOutputBusId,
  type MidiRegionRow,
  type RegionRow,
  type WebUiState,
} from "../../lib/types";
import { BusStrip } from "../mixer/BusStrip";
import { TrackStrip } from "../mixer/TrackStrip";
import { PluginChainModal } from "../mixer/PluginChainModal";
import { extOutTarget, isMainBusId } from "../mixer/mixerIds";

export function EditorInspector({
  state,
  selectedTrackId,
  selectedRegion,
  onClose,
}: {
  state: WebUiState;
  selectedTrackId: string | null;
  selectedRegion?: RegionRow | MidiRegionRow | null;
  onClose?: () => void;
}) {
  const [regionExpanded, setRegionExpanded] = useState(true);
  const [trackExpanded, setTrackExpanded] = useState(true);
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

  const master = state.busses.find((b) => isMainBusId(b.id)) ?? state.busses[0];
  const auxBusses = state.busses.filter((b) => b.isAux);
  const destinationBusses = state.busses.filter((b) => !b.isAux);

  // Find destination bus for the track or master bus
  const trackBusId = selectedTrack ? sourceOutputBusId(selectedTrack.output) : "";
  const outputBus =
    state.busses.find((b) => b.id === trackBusId) ?? master ?? state.busses[0];
  const outputBusIndex = outputBus ? state.busses.indexOf(outputBus) : 0;

  const requestTrackDirectOutput = useCallback(
    (
      tIdx: number,
      _mono: boolean,
      startChannel: number,
      pair: boolean,
    ) => {
      void mixer.setTrackBus(tIdx, extOutTarget(startChannel, pair));
    },
    [],
  );

  const anyTrackSolo = state.tracks.some((t) => t.solo);

  const isMidiRegion = selectedRegion ? "notes" in selectedRegion : false;
  const regionName = selectedRegion
    ? isMidiRegion
      ? (selectedRegion as MidiRegionRow).name
      : ((selectedRegion as RegionRow).source?.file?.split("/").pop() || selectedRegion.id)
    : selectedTrack?.kind === "instrument"
      ? "MIDI Defaults"
      : "Audio Defaults";

  const regionGainDb =
    selectedRegion && "gainDb" in selectedRegion
      ? (selectedRegion as RegionRow).gainDb
      : 0;

  const isRegionMuted = isMidiRegion
    ? Boolean((selectedRegion as MidiRegionRow).muted)
    : false;

  return (
    <aside
      className="flex h-full w-[260px] shrink-0 select-none flex-col border-r border-default/30 bg-background-tertiary z-20 text-xs overflow-hidden"
      aria-label="Channel Strip Inspector"
    >
      {/* ── Top Header / Inspector Accordions (Logic Pro style) ── */}
      <div className="flex shrink-0 flex-col border-b border-default/20 bg-background-secondary/80">
        {/* Region Section */}
        <div className="border-b border-default/15">
          <button
            type="button"
            onClick={() => setRegionExpanded((v) => !v)}
            className="flex w-full items-center justify-between px-2 py-1 text-left font-semibold text-foreground/80 hover:bg-surface/50 transition-colors"
          >
            <div className="flex items-center gap-1 min-w-0 truncate text-[11px]">
              {regionExpanded ? (
                <ChevronDown size={12} className="shrink-0 text-foreground/50" />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-foreground/50" />
              )}
              <span className="font-bold text-foreground/50">Region:</span>
              <span className="truncate text-foreground/90 font-medium">
                {regionName}
              </span>
            </div>
            {onClose && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                className="rounded p-0.5 text-foreground/40 hover:bg-default/20 hover:text-foreground cursor-pointer"
                title="Hide Inspector (I)"
              >
                <X size={11} />
              </span>
            )}
          </button>
          {regionExpanded && (
            <div className="flex flex-col gap-1 px-3 py-1 bg-surface/20 text-[10px] text-foreground/70">
              {isMidiRegion && (
                <div className="flex items-center justify-between">
                  <span className="text-foreground/40 font-mono uppercase text-[9px]">Mute</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedRegion && state.songIndex >= 0) {
                        void builder.midiRegionUpdate({
                          songIndex: state.songIndex,
                          regionId: selectedRegion.id,
                          muted: !isRegionMuted,
                        });
                      }
                    }}
                    className={`px-1.5 py-0.2 rounded border text-[9px] font-bold ${
                      isRegionMuted
                        ? "border-warning/60 bg-warning/20 text-warning"
                        : "border-default/25 text-foreground/40 hover:text-foreground"
                    }`}
                  >
                    {isRegionMuted ? "MUTED" : "OFF"}
                  </button>
                </div>
              )}
              {!isMidiRegion && selectedRegion && (
                <div className="flex items-center justify-between">
                  <span className="text-foreground/40 font-mono uppercase text-[9px]">Gain</span>
                  <span className="font-mono text-foreground/70">
                    {regionGainDb !== 0
                      ? `${regionGainDb > 0 ? "+" : ""}${regionGainDb.toFixed(1)} dB`
                      : "0.0 dB"}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Track Section */}
        <div>
          <button
            type="button"
            onClick={() => setTrackExpanded((v) => !v)}
            className="flex w-full items-center gap-1 px-2 py-1 text-left font-semibold text-foreground/80 hover:bg-surface/50 transition-colors text-[11px]"
          >
            {trackExpanded ? (
              <ChevronDown size={12} className="shrink-0 text-foreground/50" />
            ) : (
              <ChevronRight size={12} className="shrink-0 text-foreground/50" />
            )}
            <span className="font-bold text-foreground/50">Track:</span>
            <span className="truncate text-foreground/90 font-medium">
              {selectedTrack?.name || "No Track Selected"}
            </span>
          </button>
          {trackExpanded && selectedTrack && (
            <div className="flex items-center justify-between px-3 py-1 bg-surface/20 text-[10px] text-foreground/70">
              <div className="flex items-center gap-1.5">
                {selectedTrack.kind === "instrument" ? (
                  <span className="flex items-center gap-1 text-purple-400 font-medium">
                    <Music size={10} /> Inst
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-sky-400 font-medium">
                    <Mic size={10} /> Audio
                  </span>
                )}
              </div>
              <span className="font-mono text-[9px] text-foreground/45 truncate max-w-[100px]">
                {selectedTrack.inputSource || (selectedTrack.channels === 1 ? "In 1" : "In 1-2")}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Dual Channel Strips Container ── */}
      <div className="flex min-h-0 flex-1 flex-row items-stretch justify-center gap-1.5 px-1.5 py-2 overflow-y-auto overflow-x-hidden">
        {selectedTrack ? (
          <div className="flex h-full min-h-0 flex-1">
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
              density="narrow"
              targetPluginSlots={2}
              onDirectOutput={requestTrackDirectOutput}
              onOpenPlugins={openPlugins}
            />
          </div>
        ) : (
          <div className="flex h-full w-24 items-center justify-center p-2 text-center text-foreground/40 text-[10px]">
            No track
          </div>
        )}

        {outputBus ? (
          <div className="flex h-full min-h-0 flex-1">
            <BusStrip
              b={outputBus}
              index={outputBusIndex}
              meters={state.meters}
              master={master}
              settings={state.settings}
              anySoloInGroup={outputBus.soloActiveInGroup}
              isMaster={outputBus.id === master?.id}
              pluginCatalog={effectCatalog}
              density="narrow"
              targetPluginSlots={2}
              onOpenPlugins={openPlugins}
            />
          </div>
        ) : null}
      </div>

      {/* Audio FX / Instrument Plug-in Editor Modal */}
      {pluginTarget && (
        <PluginChainModal
          open
          stripId={pluginTarget.stripId}
          stripName={pluginTarget.stripName}
          slots={
            selectedTrack && selectedTrack.id === pluginTarget.stripId
              ? (selectedTrack.plugins ?? [])
              : outputBus && outputBus.id === pluginTarget.stripId
                ? (outputBus.plugins ?? [])
                : []
          }
          onClose={() => setPluginTarget(null)}
        />
      )}
    </aside>
  );
}
