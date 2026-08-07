import { builder, mixer } from "../../lib/api";
import { getClickPeaks } from "../../lib/liveLevels";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type WebUiState,
} from "../../lib/types";
import { ChannelStrip } from "./ChannelStrip";

export function MetronomeStrip({
  state,
  onDirectOutput,
}: {
  state: WebUiState;
  /** Shared Ext. Out helper — reuses/creates a bus then sets clickBusId. */
  onDirectOutput: (startChannel: number, pair: boolean) => void;
}) {
  const clickSolo = state.click?.solo ?? false;
  const hasSongs = state.songs.length > 0;
  const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
  const currentSong = hasSongs ? state.songs[songIdx] : null;
  // Project-global metronome (nested wire click). Fall back to the flat
  // per-song mirror when the view didn't ship the click channel.
  const isMetronomeOn = state.click?.enabled ?? currentSong?.click ?? false;
  const currentClickBus = state.click
    ? sourceOutputBusId(state.click.output)
    : (currentSong?.clickBusId ?? "");
  const clickGain = state.click?.gainDb ?? currentSong?.clickGainDb ?? 0;
  const clickPan = state.click?.pan ?? 0;
  const clickName = state.click?.name?.trim() || "Click";

  const auxBusses = state.busses.filter((b) => b.isAux);
  const clickSends = state.click
    ? outputSendsToClickRows(state.click.output)
    : (currentSong?.clickSends ?? []);
  const clickPeak = state.clickPeakDb ?? -100;
  const clickPeakL = state.clickPeakDbL ?? state.clickPeakDb ?? -100;
  const clickPeakR = state.clickPeakDbR ?? state.clickPeakDb ?? -100;
  const getLiveClick = () => getClickPeaks().peakDb;
  const getLiveClickL = () => getClickPeaks().peakDbL;
  const getLiveClickR = () => getClickPeaks().peakDbR;

  const patchClick = (partial: {
    click?: boolean;
    clickBusId?: string;
    clickGainDb?: number;
    clickPan?: number;
    clickMono?: boolean;
    clickName?: string;
    clickSends?: typeof clickSends;
  }) => {
    const nextClickBusId =
      partial.clickBusId !== undefined ? partial.clickBusId : currentClickBus;
    void builder.songUpdate({
      index: hasSongs ? songIdx : -1,
      name: currentSong?.name ?? "",
      bpm: currentSong?.bpm ?? 120,
      mode: currentSong?.mode ?? "wait",
      tsNum: currentSong?.tsNum ?? 4,
      tsDen: currentSong?.tsDen ?? 4,
      click: partial.click ?? isMetronomeOn,
      clickBusId: nextClickBusId,
      clickGainDb: partial.clickGainDb ?? state.click?.gainDb ?? 0,
      clickPan: partial.clickPan ?? state.click?.pan ?? 0,
      clickMono:
        partial.clickMono ?? (state.click ? state.click.channels === 1 : false),
      clickName: partial.clickName ?? state.click?.name ?? "Click",
      clickSends: partial.clickSends ?? clickSends,
    });
  };

  const destinationBusses = state.busses.filter(
    (b) => b.id === "audio::main" || b.id === "main" || b.isAux,
  );
  const clickMono = state.click ? state.click.channels === 1 : false;

  return (
    <ChannelStrip
      name={clickName}
      subtitle="Metronome"
      color="#ff9230"
      busses={destinationBusses}
      busId={currentClickBus}
      onBusSelect={(busId) => patchClick({ clickBusId: busId })}
      directOutput={{
        settings: state.settings,
        allBusses: state.busses,
        mono: clickMono,
        onMonoChange: (m) => patchClick({ clickMono: m }),
        onDirectOutput: (_mono, startChannel, pair) => {
          onDirectOutput(startChannel, pair);
        },
      }}
      sends={{
        auxBusses,
        values: clickSends,
        trackIndex: -1,
        onSendChange: (busId, gainDb) => {
          const existing = clickSends.find((cs) => cs.busId === busId);
          let updatedSends: typeof clickSends;
          if (existing) {
            updatedSends = clickSends.map((cs) =>
              cs.busId === busId
                ? { ...cs, gainDb, enabled: gainDb > -59 }
                : cs,
            );
          } else {
            updatedSends = [
              ...clickSends,
              { busId, gainDb, enabled: gainDb > -59 },
            ];
          }
          patchClick({ clickSends: updatedSends });
        },
        onRemoveSend: (busId) => {
          const updatedSends = clickSends.filter((cs) => cs.busId !== busId);
          patchClick({ clickSends: updatedSends });
        },
      }}
      gainDb={clickGain}
      pan={clickPan}
      peakDb={clickPeak}
      peakDbL={clickPeakL}
      peakDbR={clickPeakR}
      getLiveDb={getLiveClick}
      getLiveDbL={getLiveClickL}
      getLiveDbR={getLiveClickR}
      mute={!isMetronomeOn}
      solo={clickSolo}
      onGain={(v) => patchClick({ clickGainDb: v })}
      onPan={(v) => patchClick({ clickPan: v })}
      onMute={() => patchClick({ click: !isMetronomeOn })}
      onSolo={() => void mixer.setClickSolo(!clickSolo)}
    />
  );
}


