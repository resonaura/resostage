import { builder } from "../../lib/api";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type ClickSendRow,
  type WebUiState,
} from "../../lib/types";

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
    clickSends?: ClickSendRow[];
  },
) {
  const hasSongs = state.songs.length > 0;
  const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
  const currentSong = hasSongs ? state.songs[songIdx] : null;
  const isMetronomeOn = state.click?.enabled ?? currentSong?.click ?? false;
  const currentClickBus = state.click
    ? sourceOutputBusId(state.click.output)
    : (currentSong?.clickBusId ?? "");
  const clickSends = state.click
    ? outputSendsToClickRows(state.click.output)
    : (currentSong?.clickSends ?? []);
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
    clickGainDb: partial.clickGainDb ?? state.click?.gainDb ?? 0,
    clickPan: partial.clickPan ?? state.click?.pan ?? 0,
    clickMono:
      partial.clickMono ?? (state.click ? state.click.channels === 1 : false),
    clickName: partial.clickName ?? state.click?.name ?? "Click",
    clickSends: partial.clickSends ?? clickSends,
  });
}
