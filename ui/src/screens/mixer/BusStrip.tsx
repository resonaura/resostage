import { memo } from "react";
import { mixer, type PluginCatalogEntry } from "../../lib/api";
import { rowsSameExceptLevels, sameExceptLevels } from "../../lib/levelFields";
import { getLiveLevels } from "../../lib/liveLevels";
import type { BusRow, MeterRow, SettingsState } from "../../lib/types";
import { BusDestinationRouting } from "./BusDestinationRouting";
import { ChannelStrip } from "./ChannelStrip";
import { masterColor, sendColor } from "./constants";

function BusStripInner({
  b,
  index,
  meters,
  master,
  settings,
  isMaster = false,
  anySoloInGroup,
  pluginCatalog,
  density = "standard",
  targetPluginSlots,
  onOpenPlugins,
}: {
  b: BusRow;
  index: number;
  meters: MeterRow[];
  master?: BusRow;
  settings: SettingsState;
  isMaster?: boolean;
  anySoloInGroup?: boolean;
  pluginCatalog: PluginCatalogEntry[];
  density?: "narrow" | "standard" | "wide";
  targetPluginSlots?: number;
  onOpenPlugins: (stripId: string, stripName: string) => void;
}) {
  const meter = meters.find((m) => m.id === b.id);
  const color = isMaster ? masterColor() : sendColor();
  const peakDb = meter?.peakDb ?? b.peakDb;
  const peakDbL = meter?.peakDbL ?? b.peakDbL ?? peakDb;
  const peakDbR = meter?.peakDbR ?? b.peakDbR ?? peakDb;

  return (
    <ChannelStrip
      stripId={b.id}
      name={b.name || b.id}
      subtitle={isMaster ? "Master Output" : "Send"}
      color={color}
      density={density}
      targetPluginSlots={targetPluginSlots}
      gainDb={b.gainDb ?? 0}
      pan={b.pan ?? 0}
      peakDb={peakDb}
      peakDbL={peakDbL}
      peakDbR={peakDbR}
      getLiveDbL={() =>
        getLiveLevels().meters.find((m) => m.id === b.id)?.needleDbL ?? -144
      }
      getLiveDbR={() =>
        getLiveLevels().meters.find((m) => m.id === b.id)?.needleDbR ?? -144
      }
      mute={b.mute}
      solo={b.solo}
      soloSafe={b.soloSafe}
      anySoloInGroup={anySoloInGroup}
      isMaster={isMaster}
      shortTermLufs={meter?.shortTermLufs}
      pluginSlots={b.plugins ?? []}
      pluginCatalog={pluginCatalog}
      onPlugins={() => onOpenPlugins(b.id, b.name || b.id)}
      onGain={(v) => mixer.setBusGain(index, v)}
      onPan={(v) => mixer.setBusPan(index, v)}
      onMute={() => mixer.setBusMute(index, !b.mute)}
      onSolo={() => mixer.setBusSolo(index, !b.solo)}
      onSoloSafe={(safe) => void mixer.setBusSoloSafe(index, safe)}
      busDestination={
        <BusDestinationRouting
          bus={b}
          index={index}
          master={master}
          settings={settings}
        />
      }
    />
  );
}

/** Same reasoning as TrackStrip's memo -- see there and lib/levelFields. */
export const BusStrip = memo(BusStripInner, (prev, next) => {
  return (
    prev.index === next.index &&
    prev.density === next.density &&
    prev.targetPluginSlots === next.targetPluginSlots &&
    prev.isMaster === next.isMaster &&
    prev.anySoloInGroup === next.anySoloInGroup &&
    prev.settings === next.settings &&
    prev.onOpenPlugins === next.onOpenPlugins &&
    prev.pluginCatalog === next.pluginCatalog &&
    sameExceptLevels(prev.b, next.b) &&
    sameExceptLevels(prev.master, next.master) &&
    rowsSameExceptLevels(prev.meters, next.meters)
  );
});
