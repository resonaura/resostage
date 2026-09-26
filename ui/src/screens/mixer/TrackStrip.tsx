import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
  ContextMenuSubmenu,
} from "../../components/common/ContextMenu";
import {
  mixer,
  pluginChains,
  type PluginCatalogEntry,
} from "../../lib/state/api";
import {
  rowsSameExceptLevels,
  sameExceptLevels,
} from "../../lib/audio/levelFields";
import { getLiveLevels } from "../../lib/audio/liveLevels";
import { deduplicatePlugins } from "../../lib/plugins/pluginCategories";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type BusRow,
  type MeterRow,
  type SettingsState,
  type TrackRow,
} from "../../lib/state/types";
import { ChannelStrip } from "./ChannelStrip";
import { colorForIndex } from "./constants";

interface InstrumentGroup {
  name: string;
  plugins: PluginCatalogEntry[];
}

function groupInstruments(plugins: PluginCatalogEntry[]): InstrumentGroup[] {
  const groups = new Map<string, PluginCatalogEntry[]>();
  const instruments = plugins.filter(
    (p) => p.instrument && p.enabled !== false,
  );
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
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
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

  const [optimisticPolarity, setOptimisticPolarity] = useState<
    "left" | "right" | "none" | "both" | null
  >(null);
  const lastPolarityEdit = useRef(0);
  const polarity: "left" | "right" | "none" | "both" =
    optimisticPolarity ?? t.polarity ?? (t.phaseInvert ? "both" : "none");
  const isPolarityActive = polarity !== "none";
  const [polarityMenu, setPolarityMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (Date.now() - lastPolarityEdit.current > 1200) {
      setOptimisticPolarity(null);
    }
  }, [t.polarity, t.phaseInvert]);

  const togglePolarity = () => {
    const nextPolarity = isPolarityActive ? "none" : isMono ? "left" : "both";
    lastPolarityEdit.current = Date.now();
    setOptimisticPolarity(nextPolarity);
    void mixer.setTrackTrim(
      index,
      t.inputTrimDb ?? 0,
      nextPolarity !== "none",
      nextPolarity,
    );
  };

  const instrumentSlot = t.plugins?.find((p) => p.instrument);
  const instrumentName = instrumentSlot?.name;
  const audioFxSlots = useMemo(
    () => (t.plugins ?? []).filter((p) => !p.instrument),
    [t.plugins],
  );
  const [instrumentMenu, setInstrumentMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
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
          ...(hwChannels.length >= 4
            ? [{ id: "in:3+4", label: "In 3+4" }]
            : []),
          { id: "in:1", label: "In 1 (Spread)" },
          { id: "in:2", label: "In 2 (Spread)" },
        ]),
    ...allBusses.map((b, bIdx) => ({
      id: `bus:${b.id}`,
      label: `Bus ${bIdx + 1}: ${b.name || b.id}`,
    })),
    { id: "none", label: "No In" },
  ];

  return (
    <>
      <ChannelStrip
        stripId={t.id}
        name={t.name || t.id}
        subtitle={`Track ${index + 1}`}
        color={color}
        busses={destinationBusses}
        busId={busId}
        formatToggle={{
          stereo: !isMono,
          onToggle: () => void mixer.setTrackMono(index, !isMono),
        }}
        inputRouting={{
          isInstrument,
          instrumentName,
          instrumentSlotId: instrumentSlot?.id,
          onOpenInstrument: () => {
            if (instrumentSlot)
              void pluginChains.openEditor(t.id, instrumentSlot.id);
          },
          onInstrumentMenu: (pos) => setInstrumentMenu(pos),
          inputOptions,
          currentInput,
          onInputChange: (val) =>
            void mixer.setTrackInputSource(
              index,
              val,
              t.midiInputChannel ?? 0,
              t.midiInputDevice ?? "all",
            ),
          polarity,
          onTogglePolarity: togglePolarity,
          onPolarityMenu: (pos) => setPolarityMenu(pos),
          trimDb: t.inputTrimDb ?? 0,
          onTrimChange: (trim) =>
            void mixer.setTrackTrim(index, trim, isPolarityActive, polarity),
        }}
        recordArmed={t.recordArmed}
        inputMonitoring={t.inputMonitoring}
        isRecording={isRecording}
        onRecordArm={() => void mixer.setTrackRecordArm(index, !t.recordArmed)}
        onInputMonitor={() =>
          void mixer.setTrackInputMonitor(index, !t.inputMonitoring)
        }
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
            void mixer.setTrackSend(
              index,
              sBusId,
              current?.level ?? 100,
              enabled,
            );
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
        pluginSlots={audioFxSlots}
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

      {polarityMenu && (
        <ContextMenu
          x={polarityMenu.x}
          y={polarityMenu.y}
          width={180}
          onClose={() => setPolarityMenu(null)}
        >
          <ContextMenuItem
            onClick={() => {
              void mixer.setTrackTrim(index, t.inputTrimDb ?? 0, true, "both");
              setPolarityMenu(null);
            }}
          >
            {polarity === "both"
              ? "✓ Both Channels (L+R)"
              : "Both Channels (L+R)"}
          </ContextMenuItem>
          {!isMono && (
            <>
              <ContextMenuItem
                onClick={() => {
                  void mixer.setTrackTrim(
                    index,
                    t.inputTrimDb ?? 0,
                    true,
                    "left",
                  );
                  setPolarityMenu(null);
                }}
              >
                {polarity === "left"
                  ? "✓ Left Channel Only (L)"
                  : "Left Channel Only (L)"}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  void mixer.setTrackTrim(
                    index,
                    t.inputTrimDb ?? 0,
                    true,
                    "right",
                  );
                  setPolarityMenu(null);
                }}
              >
                {polarity === "right"
                  ? "✓ Right Channel Only (R)"
                  : "Right Channel Only (R)"}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem
            onClick={() => {
              void mixer.setTrackTrim(index, t.inputTrimDb ?? 0, false, "none");
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
    </>
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
