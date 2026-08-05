import { mixer } from "../../lib/api";
import { getLiveLevels } from "../../lib/liveLevels";
import type {
  BusRow,
  MeterRow,
  SettingsState,
  TrackRow,
} from "../../lib/types";
import { ChannelStrip } from "./ChannelStrip";
import { colorForIndex } from "./constants";

export function TrackStrip({
  t,
  index,
  destinationBusses,
  allBusses,
  auxBusses,
  meters,
  settings,
  anySoloInGroup,
  onDirectOutput,
}: {
  t: TrackRow;
  index: number;
  destinationBusses: BusRow[];
  allBusses: BusRow[];
  auxBusses: BusRow[];
  meters: MeterRow[];
  settings: SettingsState;
  anySoloInGroup?: boolean;
  onDirectOutput: (
    trackIndex: number,
    mono: boolean,
    startChannel: number,
    pair: boolean,
  ) => void;
}) {
  const color = colorForIndex(index);
  const busMeter = meters.find((m) => m.id === t.busId);
  const peakDb = t.peakDb ?? busMeter?.peakDb;
  const peakDbL = t.peakDbL ?? busMeter?.peakDbL ?? peakDb;
  const peakDbR = t.peakDbR ?? busMeter?.peakDbR ?? peakDb;

  return (
    <ChannelStrip
      name={t.name || t.id}
      subtitle={`Track ${index + 1}`}
      color={color}
      busses={destinationBusses}
      busId={t.busId}
      onBusSelect={(bId) => mixer.setTrackBus(index, bId)}
      directOutput={{
        settings,
        allBusses,
        mono: Boolean(t.mono),
        onMonoChange: (m) => void mixer.setTrackMono(index, m),
        onDirectOutput: (mono, ch, pair) =>
          onDirectOutput(index, mono, ch, pair),
      }}
      sends={{
        auxBusses,
        values: t.sends,
        trackIndex: index,
        onRemoveSend: (busId) => void mixer.removeTrackSend(index, busId),
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
      anySoloInGroup={anySoloInGroup}
      onGain={(v) => mixer.setTrackGain(index, v)}
      onPan={(v) => mixer.setTrackPan(index, v)}
      onMute={() => mixer.setTrackMute(index, !t.mute)}
      onSolo={() => mixer.setTrackSolo(index, !t.solo)}
    />
  );
}
