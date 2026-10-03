/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { memo } from "react";
import { builder, mixer, type PluginCatalogEntry } from "@/lib/state/api";
import {
  rowsSameExceptLevels,
  sameExceptLevels,
} from "@/lib/audio/levelFields";
import { getLiveLevels } from "@/lib/audio/liveLevels";
import type { BusRow, MeterRow, SettingsState } from "@/lib/state/types";
import { BusDestinationRouting } from "@/screens/mixer/routing/components/BusDestinationRouting";
import { ChannelStrip } from "@/screens/mixer/strips/ChannelStrip";
import { masterColor, sendColor } from "@/screens/mixer/logic/constants";
import { rotaryMidiTarget } from "@/components/daw/logic/rotaryMidiTarget";

function BusStripInner({
  b,
  motionKey,
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
  onShowSignalFlow,
  signalFlowOpenId,
}: {
  b: BusRow;
  motionKey?: string;
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
  onShowSignalFlow?: (stripId: string, stripName: string) => void;
  signalFlowOpenId?: string | null;
}) {
  const meter = meters.find((m) => m.id === b.id);
  const color = isMaster ? masterColor() : sendColor();
  const peakDb = meter?.peakDb ?? b.peakDb;
  const peakDbL = meter?.peakDbL ?? b.peakDbL ?? peakDb;
  const peakDbR = meter?.peakDbR ?? b.peakDbR ?? peakDb;

  return (
    <ChannelStrip
      stripId={b.id}
      motionKey={motionKey}
      name={b.name || b.id}
      subtitle={isMaster ? "Master Output" : "Send"}
      color={color}
      density={density}
      targetPluginSlots={targetPluginSlots}
      formatToggle={{
        stereo: b.channels === 2,
        onToggle: () => {
          const nextChannels = b.channels === 2 ? 1 : 2;
          void builder.busUpdate({
            index,
            name: b.name,
            channels: nextChannels,
            startChannel: b.startChannel,
            mute: b.mute,
            solo: b.solo,
            gainDb: b.gainDb,
            pan: b.pan,
            isAux: b.isAux,
          });
        },
      }}
      gainDb={b.gainDb ?? 0}
      automatedGainDb={b.automatedGainDb}
      pan={b.pan ?? 0}
      automatedPan={b.automatedPan}
      panMidiTarget={isMaster ? rotaryMidiTarget.masterPan() : rotaryMidiTarget.busPan(b.id)}
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
      onShowSignalFlow={onShowSignalFlow ? () => onShowSignalFlow(b.id, b.name || b.id) : undefined}
      audioFlowOpen={signalFlowOpenId === b.id}
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
    prev.motionKey === next.motionKey &&
    prev.density === next.density &&
    prev.targetPluginSlots === next.targetPluginSlots &&
    prev.isMaster === next.isMaster &&
    prev.anySoloInGroup === next.anySoloInGroup &&
    prev.settings === next.settings &&
    prev.onOpenPlugins === next.onOpenPlugins &&
    prev.onShowSignalFlow === next.onShowSignalFlow &&
    prev.signalFlowOpenId === next.signalFlowOpenId &&
    prev.pluginCatalog === next.pluginCatalog &&
    sameExceptLevels(prev.b, next.b) &&
    sameExceptLevels(prev.master, next.master) &&
    rowsSameExceptLevels(prev.meters, next.meters)
  );
});
