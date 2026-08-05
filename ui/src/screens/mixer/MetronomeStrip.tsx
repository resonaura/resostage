import { builder, mixer } from "../../lib/api";
import { getClickPeaks } from "../../lib/liveLevels";
import type { WebUiState } from "../../lib/types";
import { ChannelStrip } from "./ChannelStrip";

export function MetronomeStrip({
  state,
  onDirectOutput,
}: {
  state: WebUiState;
  /** Shared Ext. Out helper — reuses/creates a bus then sets clickBusId. */
  onDirectOutput: (startChannel: number, pair: boolean) => void;
}) {
  const clickSolo = state.clickSolo ?? false;
  const hasSongs = state.songs.length > 0;
  const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
  const currentSong = hasSongs ? state.songs[songIdx] : null;
  const isMetronomeOn = state.click ?? currentSong?.click ?? false;
  const currentClickBus = state.clickBusId ?? currentSong?.clickBusId ?? "";
  const clickGain = state.clickGainDb ?? 0;
  const clickPan = state.clickPan ?? 0;
  const clickName = state.clickName?.trim() || "Click";

  const auxBusses = state.busses.filter((b) => b.isAux);
  const clickSends = state.clickSends ?? currentSong?.clickSends ?? [];
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
      clickGainDb: partial.clickGainDb ?? state.clickGainDb ?? 0,
      clickPan: partial.clickPan ?? state.clickPan ?? 0,
      clickMono: partial.clickMono ?? state.clickMono ?? false,
      clickName: partial.clickName ?? state.clickName ?? "Click",
      clickSends: partial.clickSends ?? clickSends,
    });
  };

  const destinationBusses = state.busses.filter(
    (b) => b.id === "main" || b.isAux,
  );
  const clickMono = state.clickMono ?? false;

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

/** Helpers for the unified context menu (rename / reset / sends). */
export function patchClickFields(
  state: WebUiState,
  partial: {
    click?: boolean;
    clickBusId?: string;
    clickGainDb?: number;
    clickPan?: number;
    clickMono?: boolean;
    clickName?: string;
    clickSends?: WebUiState["clickSends"];
  },
) {
  const hasSongs = state.songs.length > 0;
  const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
  const currentSong = hasSongs ? state.songs[songIdx] : null;
  const isMetronomeOn = state.click ?? currentSong?.click ?? false;
  const currentClickBus = state.clickBusId ?? currentSong?.clickBusId ?? "";
  const clickSends = state.clickSends ?? currentSong?.clickSends ?? [];
  void builder.songUpdate({
    index: hasSongs ? songIdx : -1,
    name: currentSong?.name ?? "",
    bpm: currentSong?.bpm ?? 120,
    mode: currentSong?.mode ?? "wait",
    tsNum: currentSong?.tsNum ?? 4,
    tsDen: currentSong?.tsDen ?? 4,
    click: partial.click ?? isMetronomeOn,
    clickBusId:
      partial.clickBusId !== undefined ? partial.clickBusId : currentClickBus,
    clickGainDb: partial.clickGainDb ?? state.clickGainDb ?? 0,
    clickPan: partial.clickPan ?? state.clickPan ?? 0,
    clickMono: partial.clickMono ?? state.clickMono ?? false,
    clickName: partial.clickName ?? state.clickName ?? "Click",
    clickSends: partial.clickSends ?? clickSends,
  });
}
