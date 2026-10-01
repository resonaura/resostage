/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// HTML5 drag & drop helpers for the timeline's audio-file ghost preview.
// The ghost is purely visual ("as if you'd added the file") until the user
// actually drops it, see ../components/AudioDropGhost.tsx + the drop wiring in
// Timeline.tsx.
//
// macOS/Electron quirk that drives this design: on an OS file drag (Finder),
// `dataTransfer.files` is empty and `getAsFile()` returns null for the whole
// dragover phase -- the pages can only identify the file by its drop-entry
// (`item.webkitGetAsEntry()`, gives the file NAME/extension) or its MIME in
// `dataTransfer.types`. The actual File is only handed out in the drop event.
// So identification during dragover is best-effort, and the drop
// (`audioFileFromDrop`) re-verifies before importing.

import { isImportableMediaFile, isImportableMediaName } from "@/transfer/audio/logic/mediaFormats";

/** Decoded preview of a local audio file: duration + a coarse peak envelope. */
export interface AudioPreview {
  duration: number;
  min: number[];
  max: number[];
}

export interface AudioDropPosition {
  rowIndex: number;
  trackIndex: number;
  songIndex: number;
  startPx: number;
}

/** Map a timeline-lane point to a valid track/song insertion position. */
export function computeAudioDropPosition(args: {
  x: number;
  y: number;
  rows: readonly { name: string }[];
  tracks: readonly { id: string; name: string }[];
  songOffsets: readonly number[];
  songLengths: readonly number[];
  pxPerSec: number;
  laneHeight: number;
  previewDuration: number;
}): AudioDropPosition | null {
  const rowIndex = Math.max(
    0,
    Math.min(args.rows.length - 1, Math.floor(args.y / args.laneHeight)),
  );
  const rowName = args.rows[rowIndex]?.name ?? "";
  const trackIndex = args.tracks.findIndex(
    (track) => (track.name || track.id) === rowName,
  );
  // Orphan rows (no staged track) cannot hold an import.
  if (trackIndex < 0) return null;

  let songIndex = 0;
  for (let index = 0; index < args.songOffsets.length; index++) {
    const start = args.songOffsets[index] * args.pxPerSec;
    if (
      args.x >= start &&
      args.x < start + args.songLengths[index] * args.pxPerSec
    ) {
      songIndex = index;
      break;
    }
  }

  const durationPx = Math.max(8, args.previewDuration * args.pxPerSec);
  const segmentStart = args.songOffsets[songIndex] * args.pxPerSec;
  const segmentEnd =
    segmentStart + Math.max(1, args.songLengths[songIndex] * args.pxPerSec);
  // Clamp the region start so the ghost stays inside the song segment.
  const maxStart = Math.max(segmentStart, segmentEnd - durationPx);
  return {
    rowIndex,
    trackIndex,
    songIndex,
    startPx: Math.max(segmentStart, Math.min(args.x, maxStart)),
  };
}

export function isAudioName(name: string): boolean {
  return isImportableMediaName(name);
}

export function isAudioFile(file: File): boolean {
  return isImportableMediaFile(file);
}

/**
 * What a dragover can tell us about the file being dragged (files are NOT
 * available during dragover on macOS/Electron -- see module doc).
 */
export interface AudioDragInfo {
  /** True when the drag carries at least one file (kind "file" / "Files"). */
  anyFiles: boolean;
  /** Positive audio identification via mime, extension, or audio type. */
  audio: boolean;
  /** Best-guess filename (only meaningful when `audio` is true). */
  name: string;
  /** The actual File when reachable synchronously (usually only at drop). */
  file: File | null;
  /** Drop-entry for the dragged file (srcables the File asynchronously). */
  entry: FileSystemFileEntry | null;
}

export function audioDragInfo(e: React.DragEvent): AudioDragInfo {
  const dt = e.dataTransfer;
  if (!dt)
    return { anyFiles: false, audio: false, name: "", file: null, entry: null };
  const items = dt.items ? Array.from(dt.items) : [];
  const types = Array.from((dt.types as unknown as string[]) ?? []);
  const anyFiles =
    (dt.files && dt.files.length > 0) ||
    items.some((i) => i.kind === "file") ||
    types.includes("Files");

  // Synchronously reachable File (plain browser tab drags provide it).
  for (const it of items) {
    if (it.kind !== "file") continue;
    const asFile = it.getAsFile();
    if (asFile) {
      return {
        anyFiles: true,
        audio: isAudioFile(asFile),
        name: asFile.name,
        file: asFile,
        entry: null,
      };
    }
  }

  // Drop-entry: gives the filename during dragover even without the file.
  let entryName = "";
  let entry: FileSystemFileEntry | null = null;
  for (const it of items) {
    if (it.kind !== "file") continue;
    if (typeof it.webkitGetAsEntry !== "function") continue;
    const fsEntry = it.webkitGetAsEntry();
    if (fsEntry && fsEntry.isFile) {
      entryName = fsEntry.name;
      entry = fsEntry as FileSystemFileEntry;
      break;
    }
  }
  if (entry) {
    return {
      anyFiles: true,
      audio: isAudioName(entryName),
      name: entryName,
      file: null,
      entry,
    };
  }

  // Audio/video MIME may be the only information exposed during dragover.
  const audioMime =
    types.find((t) => /^(audio|video)\//i.test(t)) ||
    items.find((i) => /^(audio|video)\//i.test(i.type));
  if (audioMime) {
    const direct = dt.files && dt.files.length === 1 ? dt.files[0] : null;
    return {
      anyFiles: true,
      audio: true,
      name: direct?.name || "Audio file",
      file: direct,
      entry: null,
    };
  }

  return { anyFiles, audio: false, name: "", file: null, entry: null };
}

/** Resolve the actual File from a dragover drop-entry (async). */
export function entryToFile(
  entry: FileSystemFileEntry | null,
): Promise<File | null> {
  if (!entry) return Promise.resolve(null);
  return new Promise((resolve) => {
    entry.file(resolve, () => resolve(null));
  });
}

/** The real file from a drop event -- this is where macOS hands it over. */
export function audioFileDropEvent(e: React.DragEvent): File | null {
  const dt = e.dataTransfer;
  if (!dt) return null;
  const file = dt.files && dt.files.length > 0 ? dt.files[0] : null;
  if (!file) return null;
  if (!isAudioFile(file)) return null;
  return file;
}

let audioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  try {
    audioCtx = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    )();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

const DECODE_BINS = 96;

function envelopeFromBuffer(buffer: AudioBuffer): {
  min: number[];
  max: number[];
} {
  const min = new Array<number>(DECODE_BINS).fill(0);
  const max = new Array<number>(DECODE_BINS).fill(0);
  const len = buffer.length;
  for (let b = 0; b < DECODE_BINS; b++) {
    const s = Math.floor((b / DECODE_BINS) * len);
    const e = Math.max(s + 1, Math.floor(((b + 1) / DECODE_BINS) * len));
    let mn = 1;
    let mx = -1;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = s; i < e; i++) {
        const v = ch[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    min[b] = mn === 1 ? 0 : mn;
    max[b] = mx === -1 ? 0 : mx;
  }
  return { min, max };
}

/** Metadata-only fallback: <audio> duration, no peaks. */
function durationOnlyPreview(file: File): Promise<AudioPreview> {
  return new Promise((resolve) => {
    const el = new Audio();
    let url: string | null = null;
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ duration: 0, min: [], max: [] });
    }, 10000);
    const cleanup = () => {
      clearTimeout(timeout);
      el.onloadedmetadata = null;
      el.onerror = null;
      el.src = "";
      if (url) URL.revokeObjectURL(url);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const d = Number.isFinite(el.duration) ? el.duration : 0;
      cleanup();
      resolve({ duration: d, min: [], max: [] });
    };
    el.onerror = () => {
      cleanup();
      resolve({ duration: 0, min: [], max: [] });
    };
    url = URL.createObjectURL(file);
    el.src = url;
  });
}

// Keyed so dragging the same file around (or re-entering the timeline) never
// re-decodes it. Cache stores the promise so concurrent dragover frames share
// one decode instead of firing N.
const previewCache = new Map<string, Promise<AudioPreview>>();
const MAXIMUM_DECODE_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAXIMUM_CACHED_PREVIEWS = 32;

export function loadAudioPreview(file: File): Promise<AudioPreview> {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  const hit = previewCache.get(key);
  if (hit) return hit;

  const p = (async (): Promise<AudioPreview> => {
    const ctx = getAudioContext();
    // Browser decoding materializes the whole file and its PCM. Large media
    // uses metadata only; Core later produces streamed peaks for all codecs.
    if (ctx && file.size <= MAXIMUM_DECODE_PREVIEW_BYTES) {
      try {
        const ab = await file.arrayBuffer();
        const buffer = await ctx.decodeAudioData(ab);
        if (buffer && Number.isFinite(buffer.duration)) {
          return {
            duration: buffer.duration,
            ...envelopeFromBuffer(buffer),
          };
        }
      } catch {
        // Fall through to the metadata-only path (unsupported codec, etc.).
      }
    }
    return durationOnlyPreview(file);
  })();

  if (previewCache.size >= MAXIMUM_CACHED_PREVIEWS)
    previewCache.delete(previewCache.keys().next().value!);
  previewCache.set(key, p);
  return p;
}
