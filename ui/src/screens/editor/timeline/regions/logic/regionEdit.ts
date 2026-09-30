import { builder } from "@/lib/state/api";
import type { MidiNoteRow, SongRow } from "@/lib/state/types";
import {
  allRegionSelKeys,
  lookupAnyRegion,
  type RegionClipboardEntry,
  type RegionSelKey,
} from "@/screens/editor/timeline/regions/logic/regionUtils";

export function resolveSelectedRegions(
  selectedRegionKeys: RegionSelKey[],
  songs: SongRow[],
): RegionClipboardEntry[] {
  const out: RegionClipboardEntry[] = [];
  for (const key of selectedRegionKeys) {
    const hit = lookupAnyRegion(songs, key);
    if (!hit) continue;
    if (hit.kind === "midi") {
      const r = hit.region;
      const bpm = songs[hit.songIndex]?.bpm || 120;
      out.push({
        kind: "midi",
        songIndex: hit.songIndex,
        trackId: r.trackId,
        startSeconds: (r.startBeats * 60) / bpm,
        name: r.name,
        durationBeats: r.durationBeats,
        clipOffsetBeats: r.clipOffsetBeats,
        loop: r.loop,
        loopLengthBeats: r.loopLengthBeats,
        loopStartBeats: r.loopStartBeats ?? 0,
        muted: Boolean(r.muted),
        color: r.color,
        notes: r.notes.map((note) => ({ ...note })),
        events: (r.events ?? []).map((event) => ({ ...event, data: [...event.data] })),
        umpEvents: (r.umpEvents ?? []).map((event) => ({ ...event, words: [...event.words] })),
        automationLanes: r.automationLanes?.map((lane) => ({
          ...lane,
          target: { ...lane.target },
          points: lane.points.map((point) => ({ ...point })),
        })),
      });
      continue;
    }
    const r = hit.region;
    out.push({
      kind: "audio",
      songIndex: hit.songIndex,
      trackId: r.trackId,
      file: r.source.file,
      startSeconds: r.startSeconds,
      sourceOffsetSeconds: r.source.offsetSeconds,
      durationSeconds: r.durationSeconds,
      gainDb: r.gainDb,
      fadeInSeconds: r.fade?.inSeconds ?? 0,
      fadeOutSeconds: r.fade?.outSeconds ?? 0,
    });
  }
  return out;
}

export function deleteSelectedRegions(
  selectedRegionKeys: RegionSelKey[],
  songs: SongRow[],
): void {
  // Shared gestureId so the backend's undo history collapses this
  // multi-region delete into ONE undo step instead of N.
  const gestureId = crypto.randomUUID();
  for (const key of selectedRegionKeys) {
    const hit = lookupAnyRegion(songs, key);
    if (!hit) continue;
    if (hit.kind === "midi")
      void builder.midiRegionRemove(hit.songIndex, hit.region.id, gestureId);
    else void builder.regionRemove(hit.songIndex, hit.region.id, gestureId);
  }
}

export async function addRegionEntries(
  entries: RegionClipboardEntry[],
  songs: SongRow[],
): Promise<void> {
  if (entries.length === 0) return;
  const gestureId = crypto.randomUUID();
  for (const r of entries) {
    if (r.kind === "midi") {
      const bpm = songs[r.songIndex]?.bpm || 120;
      await builder.midiRegionAdd({
        songIndex: r.songIndex,
        trackId: r.trackId,
        name: r.name,
        startBeats: (r.startSeconds * bpm) / 60,
        durationBeats: r.durationBeats,
        clipOffsetBeats: r.clipOffsetBeats,
        loop: r.loop,
        loopLengthBeats: r.loopLengthBeats,
        loopStartBeats: r.loopStartBeats,
        muted: r.muted,
        color: r.color,
        notes: r.notes.map((note) => ({ ...note })),
        events: r.events?.map((event) => ({ ...event, data: [...event.data] })),
        umpEvents: r.umpEvents?.map((event) => ({ ...event, words: [...event.words] })),
        automationLanes: r.automationLanes,
        gestureId,
      });
      continue;
    }
    await builder.regionAdd({
      songIndex: r.songIndex,
      trackId: r.trackId,
      file: r.file,
      startSeconds: r.startSeconds,
      sourceOffsetSeconds: r.sourceOffsetSeconds,
      durationSeconds: r.durationSeconds,
      gainDb: r.gainDb,
      fadeInSeconds: r.fadeInSeconds,
      fadeOutSeconds: r.fadeOutSeconds,
      gestureId,
    });
  }
}

/** Map absolute project seconds → song index + local time. */
export function resolveSongLocal(
  songOffsets: number[],
  songLengths: number[],
  absSec: number,
): { songIndex: number; localSeconds: number } {
  for (let i = 0; i < songOffsets.length; i++) {
    const start = songOffsets[i] ?? 0;
    const end = start + (songLengths[i] ?? 0);
    if (absSec < end || i === songOffsets.length - 1) {
      return {
        songIndex: i,
        localSeconds: Math.max(0, absSec - start),
      };
    }
  }
  return { songIndex: 0, localSeconds: Math.max(0, absSec) };
}

/**
 * Re-anchor a clipboard set so its leftmost start lands at `localPlayhead`
 * in `targetSongIndex` (relative offsets between items preserved).
 */
export function offsetRegionsToPlayhead(
  entries: RegionClipboardEntry[],
  targetSongIndex: number,
  localPlayhead: number,
): RegionClipboardEntry[] {
  if (entries.length === 0) return [];
  const base = Math.min(...entries.map((e) => e.startSeconds));
  return entries.map((e) => ({
    ...e,
    songIndex: targetSongIndex,
    startSeconds: Math.max(0, localPlayhead + (e.startSeconds - base)),
  }));
}

/** Split selected region(s) at the absolute playhead (Logic-style ⌘T). */
export async function splitRegionsAtPlayhead(
  selectedRegionKeys: RegionSelKey[],
  songs: SongRow[],
  songOffsets: number[],
  songLengths: number[],
  playheadAbsoluteSec: number,
): Promise<number> {
  let splitCount = 0;
  // Shared across every region split (each is regionUpdate + regionAdd)
  // so the whole multi-region split collapses into ONE undo step.
  const gestureId = crypto.randomUUID();
  for (const key of selectedRegionKeys) {
    const hit = lookupAnyRegion(songs, key);
    if (!hit) continue;
    const { songIndex } = hit;
    const songStart = songOffsets[songIndex] ?? 0;
    const songLen = songLengths[songIndex] ?? 0;
    const localPlayhead = playheadAbsoluteSec - songStart;
    if (localPlayhead < 0 || (songLen > 0 && localPlayhead > songLen)) continue;

    if (hit.kind === "midi") {
      const r = hit.region;
      const bpm = songs[songIndex]?.bpm || 120;
      const localBeat = (localPlayhead * bpm) / 60;
      const splitBeats = localBeat - r.startBeats;
      if (splitBeats <= 0.03125 || splitBeats >= r.durationBeats - 0.03125)
        continue;

      await builder.midiRegionUpdate({
        songIndex,
        regionId: r.id,
        durationBeats: splitBeats,
        gestureId,
      });
      await builder.midiRegionAdd({
        songIndex,
        trackId: r.trackId,
        name: r.name,
        startBeats: localBeat,
        durationBeats: r.durationBeats - splitBeats,
        clipOffsetBeats: r.clipOffsetBeats + splitBeats,
        loop: r.loop,
        loopLengthBeats: r.loopLengthBeats,
        loopStartBeats: r.loopStartBeats,
        muted: Boolean(r.muted),
        color: r.color,
        // Both halves reference the same note source. clipOffsetBeats makes
        // the right half start at the cut without losing tails or loop data.
        notes: r.notes.map((note: MidiNoteRow) => ({ ...note })),
        events: (r.events ?? []).map((event) => ({ ...event, data: [...event.data] })),
        umpEvents: (r.umpEvents ?? []).map((event) => ({ ...event, words: [...event.words] })),
        automationLanes: r.automationLanes,
        gestureId,
      });
      splitCount += 1;
      continue;
    }

    const r = hit.region;
    const regionStart = r.startSeconds;
    const regionDur =
      r.durationSeconds > 0
        ? r.durationSeconds
        : Math.max(0.05, songLen - regionStart);
    const regionEnd = regionStart + regionDur;

    if (
      localPlayhead <= regionStart + 0.05 ||
      localPlayhead >= regionEnd - 0.05
    )
      continue;

    const leftDur = localPlayhead - regionStart;
    const rightDur = regionEnd - localPlayhead;
    const rightSourceOffset = r.source.offsetSeconds + leftDur;

    await builder.regionUpdate({
      songIndex,
      regionId: r.id,
      durationSeconds: leftDur,
      fadeOutSeconds: 0,
      gestureId,
    });
    await builder.regionAdd({
      songIndex,
      trackId: r.trackId,
      file: r.source.file,
      startSeconds: localPlayhead,
      sourceOffsetSeconds: rightSourceOffset,
      durationSeconds: rightDur,
      gainDb: r.gainDb,
      fadeInSeconds: 0,
      fadeOutSeconds: r.fade?.outSeconds ?? 0,
      gestureId,
    });
    splitCount += 1;
  }
  return splitCount;
}

export function selectRegionKeys(
  key: RegionSelKey,
  e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  selectedRegionKeys: RegionSelKey[],
  songs: SongRow[],
): RegionSelKey[] {
  if (e.metaKey || e.ctrlKey) {
    return selectedRegionKeys.includes(key)
      ? selectedRegionKeys.filter((x) => x !== key)
      : [...selectedRegionKeys, key];
  }
  if (e.shiftKey && selectedRegionKeys.length > 0) {
    const all = allRegionSelKeys(songs);
    const last = selectedRegionKeys[selectedRegionKeys.length - 1];
    const a = all.indexOf(last);
    const b = all.indexOf(key);
    if (a >= 0 && b >= 0) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return all.slice(lo, hi + 1);
    }
  }
  return [key];
}
