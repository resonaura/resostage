import { useEffect } from "react";
import type { SongRow } from "../../lib/types";
import type { CueSelKey } from "../light/LightTimeline";
import { allRegionSelKeys, type RegionSelKey } from "./regionUtils";
import type { TimelineViewMode } from "./TimelineToolbar";

type Actions = {
  // light
  copySelectedCue: () => void;
  pasteClipboardCues: () => void;
  duplicateSelectedCue: () => void;
  splitSelectedCueAtPlayhead: () => void;
  deleteSelectedCue: () => void;
  setCueSelection: (v: CueSelKey | null) => void;
  // audio
  copySelectedRegions: () => void;
  pasteClipboardRegions: () => void;
  duplicateSelectedRegions: () => void;
  splitSelectedAtPlayhead: () => void;
  deleteSelectedRegions: () => void;
  setSelectedRegionKeys: (
    v: RegionSelKey[] | ((p: RegionSelKey[]) => RegionSelKey[]),
  ) => void;
};

/**
 * Editor hotkeys: region/cue copy-paste-delete-split.
 * No-ops when readOnly or when focus is in an input.
 */
export function useTimelineKeyboard({
  readOnly,
  effectiveViewMode,
  cueSelection,
  selectedRegionKeys,
  songs,
  actions,
}: {
  readOnly: boolean;
  effectiveViewMode: TimelineViewMode;
  cueSelection: CueSelKey | null;
  selectedRegionKeys: RegionSelKey[];
  songs: SongRow[];
  actions: Actions;
}) {
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      const mod = e.metaKey || e.ctrlKey;

      if (effectiveViewMode === "light") {
        if (mod && e.key === "c") {
          e.preventDefault();
          actions.copySelectedCue();
        } else if (mod && e.key === "v") {
          e.preventDefault();
          void actions.pasteClipboardCues();
        } else if (mod && e.key === "d") {
          e.preventDefault();
          void actions.duplicateSelectedCue();
        } else if (mod && e.key === "t") {
          e.preventDefault();
          void actions.splitSelectedCueAtPlayhead();
        } else if (e.key === "Backspace" || e.key === "Delete") {
          if (!cueSelection) return;
          e.preventDefault();
          actions.deleteSelectedCue();
        } else if (e.key === "Escape") {
          actions.setCueSelection(null);
        }
      } else {
        if (mod && e.key === "a") {
          e.preventDefault();
          actions.setSelectedRegionKeys(allRegionSelKeys(songs));
        } else if (mod && e.key === "c") {
          e.preventDefault();
          actions.copySelectedRegions();
        } else if (mod && e.key === "v") {
          e.preventDefault();
          void actions.pasteClipboardRegions();
        } else if (mod && e.key === "d") {
          e.preventDefault();
          void actions.duplicateSelectedRegions();
        } else if (mod && e.key === "t") {
          e.preventDefault();
          void actions.splitSelectedAtPlayhead();
        } else if (e.key === "Backspace" || e.key === "Delete") {
          if (selectedRegionKeys.length === 0) return;
          e.preventDefault();
          actions.deleteSelectedRegions();
        } else if (e.key === "Escape") {
          actions.setSelectedRegionKeys([]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    readOnly,
    effectiveViewMode,
    cueSelection,
    selectedRegionKeys,
    songs,
    actions,
  ]);
}
