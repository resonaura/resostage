/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { songBeatsAtSeconds } from "@/lib/midi/standardMidiFile";
import { builder } from "@/lib/state/api";
import type { SongRow, TrackRow } from "@/lib/state/types";
import { laneHeightPx } from "@/screens/editor/timeline/layout/logic/laneDimensions";
import {
  audioDragInfo,
  audioFileDropEvent,
  computeAudioDropPosition,
  entryToFile,
  loadAudioPreview,
  type AudioDropPosition,
  type AudioPreview,
} from "@/screens/editor/timeline/drop/logic/audioDrop";
import type { TimelineRow } from "@/screens/editor/timeline/layout/logic/rows";

interface TimelineFileDropOptions {
  readOnly: boolean;
  viewMode: "audio" | "light";
  tracks: TrackRow[];
  rows: TimelineRow[];
  rowHeights: number[];
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  verticalZoom: number;
  snapToGrid: boolean;
  tracksOriginRef: { current: HTMLDivElement | null };
  showToast: (message: string) => void;
}

/**
 * Owns timeline file-drop state, preview decoding, and import dispatch.
 * In audio view, AudioDropGhost may show a fake region with the local file's
 * decoded waveform and duration while a file is dragged over the lanes.
 * Nothing is imported until the drop fires and dispatches the real builder
 * import command.
 */
export function useTimelineFileDrop({
  readOnly,
  viewMode,
  tracks,
  rows,
  rowHeights,
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  verticalZoom,
  snapToGrid,
  tracksOriginRef,
  showToast,
}: TimelineFileDropOptions) {
  const audioDropFileRef = useRef<File | null>(null);
  const audioDropEntryResolvedRef = useRef<string | null>(null);
  const [audioDropFile, setAudioDropFile] = useState<{
    file: File;
    name: string;
  } | null>(null);
  const [midiDropName, setMidiDropName] = useState<string | null>(null);
  const [audioDropPreview, setAudioDropPreview] =
    useState<AudioPreview | null>(null);
  const [audioDropPos, setAudioDropPos] = useState<AudioDropPosition | null>(
    null,
  );

  const clearAudioDrop = useCallback(() => {
    audioDropFileRef.current = null;
    audioDropEntryResolvedRef.current = null;
    setAudioDropFile(null);
    setMidiDropName(null);
    setAudioDropPreview(null);
    setAudioDropPos(null);
  }, []);

  // Decode the dragged file once (cached in ../logic/audioDrop.ts); preview fills in
  // as soon as it resolves.
  useEffect(() => {
    if (!audioDropFile) return;
    let cancelled = false;
    void loadAudioPreview(audioDropFile.file).then((preview) => {
      if (!cancelled) setAudioDropPreview(preview);
    });
    return () => {
      cancelled = true;
    };
  }, [audioDropFile]);

  // Leaving audio view (or readOnly) dismisses any ghost.
  useEffect(() => {
    if (readOnly || viewMode !== "audio") clearAudioDrop();
  }, [readOnly, viewMode, clearAudioDrop]);

  const computeDropPosition = (x: number, y: number) =>
    computeAudioDropPosition({
      x,
      y,
      rows,
      rowHeights,
      tracks,
      songOffsets,
      songLengths,
      pxPerSec,
      laneHeight: laneHeightPx(verticalZoom),
      previewDuration: audioDropPreview?.duration ?? 0,
    });

  const onTracksDragOver = (event: React.DragEvent) => {
    if (readOnly || viewMode !== "audio") return;
    const info = audioDragInfo(event);
    // Not a file drag at all -- leave the browser default (no drop target).
    if (!info.anyFiles) return;
    // Accept the drag (drop allowed). On macOS the dragover phase carries no
    // File (../logic/audioDrop.ts documents the quirk) -- the audio check runs again on
    // drop, and the ghost only shows when we positively identified audio.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";

    const midiName = /\.(mid|midi)$/i.test(info.name) ? info.name : null;
    setMidiDropName(midiName);
    if (midiName && audioDropFile) {
      audioDropFileRef.current = null;
      setAudioDropFile(null);
      setAudioDropPreview(null);
    }
    if (info.audio) {
      // Grab the File for the preview: sync when available, else async via
      // the drop-entry (one resolution attempt per dragged filename).
      if (info.file) {
        if (audioDropFileRef.current !== info.file) {
          audioDropFileRef.current = info.file;
          setAudioDropFile({ file: info.file, name: info.name });
        }
      } else if (
        info.entry &&
        audioDropEntryResolvedRef.current !== info.name
      ) {
        audioDropEntryResolvedRef.current = info.name;
        void entryToFile(info.entry).then((file) => {
          if (file && audioDropFileRef.current !== file) {
            audioDropFileRef.current = file;
            setAudioDropFile({ file, name: file.name });
          }
        });
      }
    } else if (!midiName && (audioDropFile || audioDropPos)) {
      // A file we couldn't identify as audio -- hide any stale ghost.
      clearAudioDrop();
    }

    const origin = tracksOriginRef.current;
    if (!origin) return;
    const rect = origin.getBoundingClientRect();
    // tracksOrigin lives inside the scrolled body -- getBoundingClientRect()
    // already shifts with scrollLeft (same rule as the marquee handlers).
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setAudioDropPos(computeDropPosition(x, y));
  };

  const onTracksDragLeave = (event: React.DragEvent) => {
    const related = event.relatedTarget as Node | null;
    if (related && event.currentTarget.contains(related)) return;
    clearAudioDrop();
  };

  const onTracksDrop = (event: React.DragEvent) => {
    if (readOnly || viewMode !== "audio") return;
    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    const dropped = droppedFiles[0] ?? null;
    const allMidi =
      droppedFiles.length > 0 &&
      droppedFiles.every((file) => /\.(mid|midi|midi2)$/i.test(file.name));
    const isMidi = Boolean(dropped && /\.(mid|midi|midi2)$/i.test(dropped.name));
    const file = isMidi ? dropped : audioFileDropEvent(event);
    if (!file) {
      clearAudioDrop();
      return;
    }
    event.preventDefault();
    const origin = tracksOriginRef.current;
    let pos = audioDropPos;
    // Drags that skipped the ghost (unidentified during dragover) still land
    // here with coordinates -- recompute so the import targets the right row.
    if (!pos && origin) {
      const rect = origin.getBoundingClientRect();
      pos = computeDropPosition(event.clientX - rect.left, event.clientY - rect.top);
    }
    clearAudioDrop();
    if (!pos) return;
    if (isMidi) {
      if (!allMidi) {
        showToast(
          "Drop MIDI files together, or audio files together; mixed batches are not supported yet",
        );
        return;
      }
      const track = tracks[pos.trackIndex];
      if (
        !track ||
        !["instrument", "midi", "externalMidi"].includes(track.kind ?? "")
      ) {
        showToast("Drop MIDI on an instrument or MIDI track");
        return;
      }
      const song = songs[pos.songIndex];
      const startSeconds = Math.max(
        0,
        pos.startPx / pxPerSec - (songOffsets[pos.songIndex] ?? 0),
      );
      const rawStartBeats = song
        ? songBeatsAtSeconds(song, startSeconds)
        : startSeconds * 2;
      const startBeats = snapToGrid
        ? Math.round(rawStartBeats * 4) / 4
        : rawStartBeats;
      window.dispatchEvent(
        new CustomEvent("resostage-import-midi", {
          detail: {
            files: droppedFiles,
            target: { songIndex: pos.songIndex, trackId: track.id, startBeats },
          },
        }),
      );
      return;
    }
    if (droppedFiles.some((candidate) => /\.(mid|midi|midi2)$/i.test(candidate.name))) {
      showToast(
        "Drop MIDI files together, or audio files together; mixed batches are not supported",
      );
      return;
    }
    const startSeconds = Math.max(
      0,
      pos.startPx / pxPerSec - (songOffsets[pos.songIndex] ?? 0),
    );
    if (droppedFiles.length > 1) {
      window.dispatchEvent(
        new CustomEvent("resostage-import-audio-batch", {
          detail: { files: droppedFiles, songIndex: pos.songIndex, startSeconds },
        }),
      );
      return;
    }
    void builder.trackImportWav(pos.songIndex, pos.trackIndex, file, startSeconds);
  };

  return {
    audioDropFile,
    midiDropName,
    audioDropPreview,
    audioDropPos,
    onTracksDragOver,
    onTracksDragLeave,
    onTracksDrop,
  };
}
