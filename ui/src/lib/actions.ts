import { transport, timelineHistory } from "./api";
import type { WebUiState } from "./types";

export const ACTION_IDS = [
  "play",
  "stop",
  "stop_to_start",
  "next",
  "prev",
  "mode_player",
  "mode_mixer",
  "mode_editor",
  "mode_light",
  "mode_settings",
  "section_prev",
  "section_next",
  "section_last",
  "bar_prev",
  "bar_next",
  "undo",
  "redo",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export function performAction(
  action: ActionId,
  songs: WebUiState["songs"],
  songIndex: number,
  playhead: number,
  setTab: (tab: string) => void,
  playing: boolean = false,
): void {
  switch (action) {
    case "play":
      if (playing) void transport.stop();
      else void transport.play();
      break;
    case "stop":
      void transport.stop();
      break;
    case "stop_to_start":
      void transport.stopToStart();
      break;
    case "next":
      void transport.next();
      break;
    case "prev":
      void transport.prev();
      break;
    case "mode_player":
      setTab("player");
      break;
    case "mode_mixer":
      setTab("mixer");
      break;
    case "mode_editor":
      setTab("editor");
      break;
    case "mode_light":
      setTab("light");
      break;
    case "mode_settings":
      setTab("settings");
      break;
    case "section_prev":
    case "section_next":
    case "section_last":
      jumpSection(action, songs, songIndex, playhead);
      break;
    case "bar_prev":
    case "bar_next":
      jumpBar(action, songs, songIndex, playhead);
      break;
    case "undo":
      void timelineHistory.undo();
      break;
    case "redo":
      void timelineHistory.redo();
      break;
  }
}

/** Jump one bar backward/forward (matches MainComponent::jumpToBarRelative). */
export function jumpBar(
  action: "bar_prev" | "bar_next",
  songs: WebUiState["songs"],
  songIndex: number,
  playhead: number,
) {
  const song = songs[songIndex];
  const bpm = song?.bpm && song.bpm > 0 ? song.bpm : 120;
  const tsNum = song?.tsNum && song.tsNum > 0 ? song.tsNum : 4;
  const barSec = (60 / bpm) * tsNum;
  if (!(barSec > 0)) return;
  const curBar = playhead / barSec;
  if (action === "bar_prev") {
    const prevBarSec = Math.max(0, Math.floor(curBar - 0.01) * barSec);
    void transport.seek(prevBarSec);
  } else {
    const nextBarSec = Math.floor(curBar + 1.01) * barSec;
    void transport.seek(nextBarSec);
  }
}

export function jumpSection(
  action: string,
  songs: WebUiState["songs"],
  songIndex: number,
  playhead: number,
) {
  if (songIndex < 0 || songIndex >= songs.length) return;
  const sections = [...(songs[songIndex]?.sections ?? [])].sort(
    (a, b) => a.startSeconds - b.startSeconds,
  );
  if (sections.length === 0) return;

  const eps = 0.05;
  if (action === "section_last") {
    void transport.seek(sections[sections.length - 1].startSeconds);
    return;
  }

  let at = -1;
  for (let i = 0; i < sections.length; i++) {
    if (playhead + eps >= sections[i].startSeconds) at = i;
  }

  if (action === "section_prev") {
    const target = at < 0 ? 0 : at - 1;
    if (target >= 0) void transport.seek(sections[target].startSeconds);
    return;
  }
  if (action === "section_next") {
    const target = at + 1;
    if (target < sections.length)
      void transport.seek(sections[target].startSeconds);
  }
}
