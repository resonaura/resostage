import { lighting } from "../../lib/api";
import type { LightCueRow, SongRow } from "../../lib/types";
import type { CueSelKey } from "../light/LightTimeline";

export interface CueClipboardEntry extends LightCueRow {
  songIndex: number;
}

function cueStyleFields(cue: LightCueRow) {
  return {
    colorR: cue.color.r,
    colorG: cue.color.g,
    colorB: cue.color.b,
    intensity: cue.intensity,
    fadeInSeconds: cue.fade.inSeconds,
    fadeOutSeconds: cue.fade.outSeconds,
    label: cue.label,
    effectType: cue.effect.type ?? null,
    effectSourceType: cue.effect.sourceType,
    effectSourceId: cue.effect.sourceId ?? null,
    effectIntensity: cue.effect.intensity,
    tempoSync: cue.effect.tempoSync,
    tempoSubdiv: cue.effect.tempoSubdivision,
    effectRateHz: cue.effect.rateHz,
    gradientPreset: cue.gradient.preset,
    gradientColors: cue.gradient.colors ?? null,
  };
}

export function findCue(
  songs: SongRow[],
  sel: CueSelKey,
): LightCueRow | undefined {
  return songs[sel.songIndex]?.lightCues?.find((c) => c.id === sel.cueId);
}

export async function duplicateCue(
  songs: SongRow[],
  sel: CueSelKey,
): Promise<boolean> {
  const cue = findCue(songs, sel);
  if (!cue) return false;
  await lighting.cueAdd(
    sel.songIndex,
    cue.trackId,
    cue.startSeconds,
    cue.durationSeconds,
    cueStyleFields(cue),
  );
  return true;
}

export async function pasteCues(items: CueClipboardEntry[]): Promise<number> {
  if (items.length === 0) return 0;
  const gestureId = crypto.randomUUID();
  for (const entry of items) {
    await lighting.cueAdd(
      entry.songIndex,
      entry.trackId,
      entry.startSeconds,
      entry.durationSeconds,
      {
        ...cueStyleFields(entry),
        gestureId,
      },
    );
  }
  return items.length;
}

/**
 * Re-anchor clipboard cues so the leftmost start lands at `localPlayhead`
 * in `targetSongIndex` (relative spacing preserved).
 */
export function offsetCuesToPlayhead(
  items: CueClipboardEntry[],
  targetSongIndex: number,
  localPlayhead: number,
): CueClipboardEntry[] {
  if (items.length === 0) return [];
  const base = Math.min(...items.map((e) => e.startSeconds));
  return items.map((e) => ({
    ...e,
    songIndex: targetSongIndex,
    startSeconds: Math.max(0, localPlayhead + (e.startSeconds - base)),
  }));
}

export async function deleteCues(sels: CueSelKey[]): Promise<void> {
  for (const s of sels) {
    await lighting.cueRemove(s.songIndex, s.cueId);
  }
}

/** Split selected cue at absolute playhead. Returns status message. */
export async function splitCueAtPlayhead(
  songs: SongRow[],
  sel: CueSelKey,
  songOffsets: number[],
  playheadAbsoluteSec: number,
): Promise<"ok" | "no-cue" | "playhead-outside"> {
  const cue = findCue(songs, sel);
  if (!cue) return "no-cue";

  const songStart = songOffsets[sel.songIndex] ?? 0;
  const localPlayhead = playheadAbsoluteSec - songStart;
  const cueEnd = cue.startSeconds + cue.durationSeconds;

  if (
    localPlayhead <= cue.startSeconds + 0.05 ||
    localPlayhead >= cueEnd - 0.05
  ) {
    return "playhead-outside";
  }

  const leftDur = localPlayhead - cue.startSeconds;
  const rightDur = cueEnd - localPlayhead;
  const gestureId = crypto.randomUUID();

  await lighting.cueUpdate({
    songIndex: sel.songIndex,
    cueId: cue.id,
    durationSeconds: leftDur,
    fadeOutSeconds: 0,
    gestureId,
  });

  const splitStyle = {
    ...cueStyleFields(cue),
    fadeInSeconds: 0,
    fadeOutSeconds: cue.fade.outSeconds,
  };

  await lighting.cueAdd(sel.songIndex, cue.trackId, localPlayhead, rightDur, {
    ...splitStyle,
    gestureId,
  });

  return "ok";
}
