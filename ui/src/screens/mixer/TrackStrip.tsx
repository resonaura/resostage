import { memo } from "react";
import { mixer } from "../../lib/api";
import { rowsSameExceptLevels, sameExceptLevels } from "../../lib/levelFields";
import { getLiveLevels } from "../../lib/liveLevels";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type BusRow,
  type MeterRow,
  type SettingsState,
  type TrackRow,
} from "../../lib/types";
import { ChannelStrip } from "./ChannelStrip";
import { colorForIndex } from "./constants";

function TrackStripInner({
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
  const busId = sourceOutputBusId(t.output);
  const busMeter = meters.find((m) => m.id === busId);
  const peakDb = t.peakDb ?? busMeter?.peakDb;
  const peakDbL = t.peakDbL ?? busMeter?.peakDbL ?? peakDb;
  const peakDbR = t.peakDbR ?? busMeter?.peakDbR ?? peakDb;

  return (
    <ChannelStrip
      name={t.name || t.id}
      subtitle={`Track ${index + 1}`}
      color={color}
      busses={destinationBusses}
      busId={busId}
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
      anySoloInGroup={anySoloInGroup}
      onGain={(v) => mixer.setTrackGain(index, v)}
      onPan={(v) => mixer.setTrackPan(index, v)}
      onMute={() => mixer.setTrackMute(index, !t.mute)}
      onSolo={() => mixer.setTrackSolo(index, !t.solo)}
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
    prev.anySoloInGroup === next.anySoloInGroup &&
    prev.settings === next.settings &&
    prev.onDirectOutput === next.onDirectOutput &&
    // The bus lists are `.filter()` results, so they are new arrays every
    // render even when nothing moved -- compare them by content.
    rowsSameExceptLevels(prev.destinationBusses, next.destinationBusses) &&
    sameExceptLevels(prev.t, next.t) &&
    rowsSameExceptLevels(prev.allBusses, next.allBusses) &&
    rowsSameExceptLevels(prev.auxBusses, next.auxBusses) &&
    rowsSameExceptLevels(prev.meters, next.meters)
  );
});
