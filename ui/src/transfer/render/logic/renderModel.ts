import { songSecondsAtBeat } from "@/lib/midi/standardMidiFile";
import type { WebUiState } from "@/lib/state/types";

export type RenderScope = "song" | "project" | "cycle" | "custom";
export type TailPolicy = "cut" | "leave" | "wrap";

export interface RenderOutputChoice {
  key: string;
  kind: "master" | "track" | "bus" | "click";
  id?: string;
  label: string;
  detail: string;
}

export function songDuration(song: WebUiState["songs"][number] | undefined): number {
  if (!song) return 0;
  if ((song.endSeconds ?? 0) > 0) return song.endSeconds ?? 0;
  return Math.max(
    0,
    ...(song.regions ?? []).map(
      (region) => region.startSeconds + region.durationSeconds,
    ),
    ...song.events.map((event) => event.timeSeconds),
    ...((song.midiRegions ?? []).map((region) =>
      songSecondsAtBeat(song, region.startBeats + region.durationBeats),
    )),
  );
}

export function resolveRange(
  scope: RenderScope,
  songEnd: number,
  state: WebUiState,
  songIndex: number,
  customStart: string,
  customEnd: string,
) {
  if (scope === "cycle" && state.cycle?.songIndex === songIndex)
    return { start: state.cycle.startSeconds, end: state.cycle.endSeconds };
  if (scope === "custom")
    return {
      start: Math.max(0, Number(customStart) || 0),
      end: Math.min(songEnd, Math.max(0, Number(customEnd) || 0)),
    };
  return { start: 0, end: songEnd };
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
