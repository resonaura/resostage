import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
  ContextMenuSubmenu,
} from "../../components/ContextMenu";
import { mixer, pluginChains, type PluginCatalogEntry } from "../../lib/api";
import { rowsSameExceptLevels, sameExceptLevels } from "../../lib/levelFields";
import { getLiveLevels } from "../../lib/liveLevels";
import { useLiveValue } from "../../lib/optimistic";
import { deduplicatePlugins } from "../../lib/pluginCategories";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type BusRow,
  type MeterRow,
  type SettingsState,
  type TrackRow,
} from "../../lib/types";
import { ChannelStrip } from "./ChannelStrip";
import { colorForIndex, ROUTING_SELECT_SIZE } from "./constants";
import { Select } from "../../components/ui";

interface InstrumentGroup {
  name: string;
  plugins: PluginCatalogEntry[];
}

function groupInstruments(plugins: PluginCatalogEntry[]): InstrumentGroup[] {
  const groups = new Map<string, PluginCatalogEntry[]>();
  const instruments = plugins.filter((p) => p.instrument && p.enabled !== false);
  const deduplicated = deduplicatePlugins(instruments);

  for (const plugin of deduplicated) {
    const rawMfg = (plugin.manufacturer || "").trim();
    const groupName = rawMfg || plugin.category || "Instruments";
    const group = groups.get(groupName) ?? [];
    group.push(plugin);
    groups.set(groupName, group);
  }

  return [...groups]
    .map(([name, entries]) => ({
      name,
      plugins: entries.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function TrackStripInner({
  t,
  index,
  destinationBusses,
  allBusses,
  auxBusses,
  meters,
  settings,
  anySoloInGroup,
  pluginCatalog,
  isRecording = false,
  density = "standard",
  targetPluginSlots,
  onDirectOutput,
  onOpenPlugins,
}: {
  t: TrackRow;
  index: number;
  destinationBusses: BusRow[];
  allBusses: BusRow[];
  auxBusses: BusRow[];
  meters: MeterRow[];
  settings: SettingsState;
  anySoloInGroup?: boolean;
  pluginCatalog: PluginCatalogEntry[];
  isRecording?: boolean;
  density?: "narrow" | "standard" | "wide";
  targetPluginSlots?: number;
  onDirectOutput: (
    trackIndex: number,
    mono: boolean,
    startChannel: number,
    pair: boolean,
  ) => void;
  onOpenPlugins: (stripId: string, stripName: string) => void;
}) {
  const color = colorForIndex(index);
  const busId = sourceOutputBusId(t.output);
  const busMeter = meters.find((m) => m.id === busId);
  const peakDb = t.peakDb ?? busMeter?.peakDb;
  const peakDbL = t.peakDbL ?? busMeter?.peakDbL ?? peakDb;
  const peakDbR = t.peakDbR ?? busMeter?.peakDbR ?? peakDb;

  const isInstrument = t.kind === "instrument";
  const isMono = t.channels === 1;
  const currentInput = t.inputSource || (isMono ? "in:1" : "in:1+2");
  
  const [optimisticPolarity, setOptimisticPolarity] = useState<"left" | "right" | "none" | "both" | null>(null);
  const lastPolarityEdit = useRef(0);
  const polarity: "left" | "right" | "none" | "both" =
    optimisticPolarity ?? (t.polarity ?? (t.phaseInvert ? "both" : "none"));
  const isPolarityActive = polarity !== "none";
  const [polarityMenu, setPolarityMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (Date.now() - lastPolarityEdit.current > 1200) {
      setOptimisticPolarity(null);
    }
  }, [t.polarity, t.phaseInvert]);

  const [displayTrimDb, commitTrimDb] = useLiveValue(
    t.inputTrimDb ?? 0.0,
    (val) => void mixer.setTrackTrim(index, val, isPolarityActive, polarity),
  );

  const togglePolarity = () => {
    const nextPolarity = isPolarityActive ? "none" : isMono ? "left" : "both";
    lastPolarityEdit.current = Date.now();
    setOptimisticPolarity(nextPolarity);
    void mixer.setTrackTrim(index, displayTrimDb, nextPolarity !== "none", nextPolarity);
  };

  const instrumentSlot = t.plugins?.find((p) => p.instrument);
  const instrumentName = instrumentSlot?.name;
  const [instrumentMenu, setInstrumentMenu] = useState<{ x: number; y: number } | null>(null);
  const instrumentGroups = useMemo(
    () => (isInstrument ? groupInstruments(pluginCatalog) : []),
    [isInstrument, pluginCatalog],
  );

  const hwChannels =
    settings?.inputChannelNames && settings.inputChannelNames.length > 0
      ? settings.inputChannelNames
      : ["In 1", "In 2"];

  const inputOptions = [
    ...(isMono
      ? hwChannels.map((chName, chIdx) => ({
          id: `in:${chIdx + 1}`,
          label: chName || `In ${chIdx + 1}`,
        }))
      : [
          { id: "in:1+2", label: "In 1+2" },
          ...(hwChannels.length >= 4 ? [{ id: "in:3+4", label: "In 3+4" }] : []),
          { id: "in:1", label: "In 1 (Spread)" },
          { id: "in:2", label: "In 2 (Spread)" },
        ]),
    ...allBusses.map((b, bIdx) => ({
      id: `bus:${b.id}`,
      label: `Bus ${bIdx + 1}: ${b.name || b.id}`,
    })),
    { id: "none", label: "No In" },
  ];

  const handleTrimPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    const startY = e.clientY;
    const startVal = displayTrimDb;

    const onPointerMove = (ev: PointerEvent) => {
      const dy = startY - ev.clientY; // Up is positive dB, Down is negative dB
      const sensitivity = ev.shiftKey ? 0.02 : 0.15; // smooth like a real knob
      const step = ev.shiftKey ? 0.05 : 0.1;
      const raw = startVal + dy * sensitivity;
      const next = Math.max(-24, Math.min(24, Math.round(raw / step) * step));
      commitTrimDb(Math.round(next * 100) / 100);
    };

    const onPointerUp = (ev: PointerEvent) => {
      try {
        if (e.currentTarget.hasPointerCapture(ev.pointerId)) {
          e.currentTarget.releasePointerCapture(ev.pointerId);
        }
      } catch {}
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const inputRoutingNode = (
    <div className="my-1 flex w-full flex-col gap-1">
      {/* Logic Pro X style Channel Format + Input routing / Instrument slot row */}
      <div className="flex w-full items-center gap-1">
        {/* Format button: Mono [ ◎ ] vs Stereo [ ◎◎ ] */}
        <button
          type="button"
          onClick={() => void mixer.setTrackMono(index, !isMono)}
          title={
            isMono
              ? "Format: Mono (Click to switch to Stereo)"
              : "Format: Stereo (Click to switch to Mono)"
          }
          className={`flex h-[22px] w-[26px] shrink-0 items-center justify-center rounded border transition-colors ${
            isMono
              ? "border-default/40 bg-surface/70 text-foreground/80 hover:bg-surface hover:text-foreground"
              : "border-accent/40 bg-accent/15 text-accent hover:bg-accent/25"
          }`}
          aria-label={isMono ? "Mono format" : "Stereo format"}
        >
          {isMono ? (
            /* Single Circle (Mono) [ ◎ ] */
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <circle
                cx="8"
                cy="8"
                r="5.5"
                stroke="currentColor"
                fill="none"
                strokeWidth="1.6"
              />
              <circle cx="8" cy="8" r="1.8" fill="currentColor" />
            </svg>
          ) : (
            /* Interlocking Circles (Stereo) [ ◎◎ ] */
            <svg width="15" height="13" viewBox="0 0 18 16" fill="currentColor">
              <circle
                cx="6.5"
                cy="8"
                r="4.2"
                stroke="currentColor"
                fill="none"
                strokeWidth="1.4"
              />
              <circle
                cx="11.5"
                cy="8"
                r="4.2"
                stroke="currentColor"
                fill="none"
                strokeWidth="1.4"
              />
            </svg>
          )}
        </button>

        {/* If instrument track: Green Instrument Slot [ Serum 2 ] / [ + Instrument ] */}
        {isInstrument ? (
          <div
            className={`flex h-[22px] flex-1 min-w-0 items-center justify-between rounded border text-xs font-semibold transition-all ${
              instrumentName
                ? "border-emerald-500/70 bg-emerald-600/25 text-emerald-300 hover:bg-emerald-600/35 shadow-[0_1px_4px_rgba(16,185,129,0.2)]"
                : "border-dashed border-emerald-500/40 text-emerald-400/60 hover:border-emerald-500/70 hover:bg-emerald-500/10 hover:text-emerald-300"
            }`}
          >
            <button
              type="button"
              onClick={(e) => {
                if (instrumentSlot) {
                  void pluginChains.openEditor(t.id, instrumentSlot.id);
                } else {
                  setInstrumentMenu({ x: e.clientX, y: e.clientY });
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setInstrumentMenu({ x: e.clientX, y: e.clientY });
              }}
              title={
                instrumentName
                  ? `Software Instrument: ${instrumentName} (Click to open UI, right-click to change)`
                  : "Add Software Instrument (Click to choose)"
              }
              className="flex h-full flex-1 min-w-0 items-center px-1.5 truncate text-left"
            >
              <span className="truncate">
                {instrumentName || "+ Instrument"}
              </span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setInstrumentMenu({ x: e.clientX, y: e.clientY });
              }}
              title="Choose Software Instrument"
              className="flex h-full px-1 items-center justify-center opacity-60 hover:opacity-100 text-[10px] select-none"
            >
              ⇅
            </button>
          </div>
        ) : (
          /* Audio track: Hardware audio input dropdown */
          <div className="flex-1 min-w-0">
            <Select
              aria-label="Input routing"
              size={ROUTING_SELECT_SIZE}
              options={inputOptions}
              value={currentInput}
              onChange={(val) =>
                void mixer.setTrackInputSource(
                  index,
                  val,
                  t.midiInputChannel ?? 0,
                  t.midiInputDevice ?? "all",
                )
              }
            />
          </div>
        )}
      </div>

      {/* Input Conditioning: Polarity Inversion (Ø) and Gain Trim */}
      <div className="flex w-full items-center justify-between px-0.5 text-[9px]">
        <button
          type="button"
          onClick={togglePolarity}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setPolarityMenu({ x: e.clientX, y: e.clientY });
          }}
          title={
            isPolarityActive
              ? `Polarity Inverted (${polarity.toUpperCase()}) — right-click for L/R options`
              : "Polarity Normal (0°) — click to invert, right-click for L/R options"
          }
          className={`flex h-4 px-1 items-center justify-center rounded border transition-colors ${
            isPolarityActive
              ? "border-[var(--rs-phase)]/60 bg-[var(--rs-phase)]/20 text-[var(--rs-phase)] font-black shadow-[0_0_6px_rgba(48,209,88,0.4)]"
              : "border-default/20 text-foreground/45 hover:text-foreground/80 hover:bg-surface/50"
          }`}
          aria-label="Phase Invert"
        >
          {polarity === "left" ? "Ø L" : polarity === "right" ? "Ø R" : "Ø"}
        </button>

        <span
          className="font-mono text-foreground/50 hover:text-foreground cursor-ns-resize transition-colors select-none px-1 rounded hover:bg-surface/60"
          title="Input Trim dB (Drag up/down like a knob, Shift for fine, double-click for 0.0dB)"
          onPointerDown={handleTrimPointerDown}
          onDoubleClick={(e) => {
            e.preventDefault();
            commitTrimDb(0.0);
          }}
        >
          {displayTrimDb === 0 ? "±0.0dB" : `${displayTrimDb > 0 ? "+" : ""}${displayTrimDb.toFixed(1)}dB`}
        </span>
      </div>

      {polarityMenu && (
        <ContextMenu
          x={polarityMenu.x}
          y={polarityMenu.y}
          width={180}
          onClose={() => setPolarityMenu(null)}
        >
          <ContextMenuItem
            onClick={() => {
              void mixer.setTrackTrim(index, displayTrimDb, true, "both");
              setPolarityMenu(null);
            }}
          >
            {polarity === "both" ? "✓ Both Channels (L+R)" : "Both Channels (L+R)"}
          </ContextMenuItem>
          {!isMono && (
            <>
              <ContextMenuItem
                onClick={() => {
                  void mixer.setTrackTrim(index, displayTrimDb, true, "left");
                  setPolarityMenu(null);
                }}
              >
                {polarity === "left" ? "✓ Left Channel Only (L)" : "Left Channel Only (L)"}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  void mixer.setTrackTrim(index, displayTrimDb, true, "right");
                  setPolarityMenu(null);
                }}
              >
                {polarity === "right" ? "✓ Right Channel Only (R)" : "Right Channel Only (R)"}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem
            onClick={() => {
              void mixer.setTrackTrim(index, displayTrimDb, false, "none");
              setPolarityMenu(null);
            }}
          >
            {polarity === "none" ? "✓ Normal (0°)" : "Normal (0°)"}
          </ContextMenuItem>
        </ContextMenu>
      )}

      {instrumentMenu && (
        <ContextMenu
          x={instrumentMenu.x}
          y={instrumentMenu.y}
          width={220}
          onClose={() => setInstrumentMenu(null)}
        >
          {instrumentSlot && (
            <>
              <ContextMenuItem
                onClick={() => {
                  void pluginChains.openEditor(t.id, instrumentSlot.id);
                  setInstrumentMenu(null);
                }}
              >
                Open {instrumentName}
              </ContextMenuItem>
              <ContextMenuItem
                danger
                onClick={() => {
                  void pluginChains.remove(t.id, instrumentSlot.id);
                  setInstrumentMenu(null);
                }}
              >
                No Plug-in
              </ContextMenuItem>
              <ContextMenuDivider />
            </>
          )}

          {instrumentGroups.length === 0 ? (
            <ContextMenuItem disabled onClick={() => {}}>
              No instruments scanned · see Settings
            </ContextMenuItem>
          ) : (
            instrumentGroups.map((group) => (
              <ContextMenuSubmenu key={group.name} label={group.name}>
                {group.plugins.map((plugin) => (
                  <ContextMenuItem
                    key={plugin.id}
                    checked={instrumentSlot?.pluginId === plugin.id}
                    onClick={() => {
                      void pluginChains.add(t.id, plugin.id);
                      setInstrumentMenu(null);
                    }}
                  >
                    {plugin.name}
                    {plugin.format ? ` (${plugin.format})` : ""}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubmenu>
            ))
          )}
        </ContextMenu>
      )}
    </div>
  );

  return (
    <ChannelStrip
      stripId={t.id}
      name={t.name || t.id}
      subtitle={`Track ${index + 1}`}
      color={color}
      busses={destinationBusses}
      busId={busId}
      inputRoutingNode={inputRoutingNode}
      recordArmed={t.recordArmed}
      inputMonitoring={t.inputMonitoring}
      isRecording={isRecording}
      onRecordArm={() => void mixer.setTrackRecordArm(index, !t.recordArmed)}
      onInputMonitor={() => void mixer.setTrackInputMonitor(index, !t.inputMonitoring)}
      onBusSelect={(bId) => mixer.setTrackBus(index, bId)}
      directOutput={{
        settings,
        allBusses,
        mono: t.channels === 1,
        onMonoChange: (m) => void mixer.setTrackMono(index, m),
        onDirectOutput: (mono, ch, pair) =>
          onDirectOutput(index, mono, ch, pair),
      }}
      sends={{
        auxBusses,
        values: outputSendsToClickRows(t.output),
        trackIndex: index,
        onSendEnabledChange: (sBusId, enabled) => {
          const current = outputSendsToClickRows(t.output).find(
            (s) => s.busId === sBusId,
          );
          void mixer.setTrackSend(index, sBusId, current?.level ?? 100, enabled);
        },
      }}
      gainDb={t.gainDb ?? 0}
      pan={t.pan ?? 0}
      peakDb={peakDb}
      peakDbL={peakDbL}
      peakDbR={peakDbR}
      getLiveDbL={() => getLiveLevels().tracks[index]?.peakDbL ?? -144}
      getLiveDbR={() => getLiveLevels().tracks[index]?.peakDbR ?? -144}
      mute={t.mute}
      solo={t.solo}
      soloSafe={t.soloSafe}
      anySoloInGroup={anySoloInGroup}
      pluginSlots={t.plugins ?? []}
      pluginCatalog={pluginCatalog}
      density={density}
      targetPluginSlots={targetPluginSlots}
      onPlugins={() => onOpenPlugins(t.id, t.name || t.id)}
      onGain={(v) => mixer.setTrackGain(index, v)}
      onPan={(v) => mixer.setTrackPan(index, v)}
      onMute={() => mixer.setTrackMute(index, !t.mute)}
      onSolo={() => mixer.setTrackSolo(index, !t.solo)}
      onSoloSafe={(safe) => void mixer.setTrackSoloSafe(index, safe)}
    />
  );
}

/**
 * A strip is expensive -- two routing selects, a send knob per aux, a fader --
 * and none of it depends on how loud the track currently is. The default
 * shallow compare would still re-render all of it on every telemetry frame,
 * because `t` and `meters` are new objects whenever a peak moves; see
 * lib/levelFields.
 */
export const TrackStrip = memo(TrackStripInner, (prev, next) => {
  return (
    prev.index === next.index &&
    prev.density === next.density &&
    prev.targetPluginSlots === next.targetPluginSlots &&
    prev.anySoloInGroup === next.anySoloInGroup &&
    prev.settings === next.settings &&
    prev.isRecording === next.isRecording &&
    prev.onDirectOutput === next.onDirectOutput &&
    prev.onOpenPlugins === next.onOpenPlugins &&
    prev.pluginCatalog === next.pluginCatalog &&
    // The bus lists are `.filter()` results, so they are new arrays every
    // render even when nothing moved -- compare them by content.
    rowsSameExceptLevels(prev.destinationBusses, next.destinationBusses) &&
    sameExceptLevels(prev.t, next.t) &&
    rowsSameExceptLevels(prev.allBusses, next.allBusses) &&
    rowsSameExceptLevels(prev.auxBusses, next.auxBusses) &&
    rowsSameExceptLevels(prev.meters, next.meters)
  );
});
