import type { Dispatch, SetStateAction } from "react";
import type { SongRow } from "@/lib/state/types";
import type { CueSelKey } from "@/screens/light/components/LightTimeline";
import {
  deleteCues,
  duplicateCue,
  findCue,
  offsetCuesToPlayhead,
  pasteCues,
  splitCueAtPlayhead,
  type CueClipboardEntry,
} from "@/screens/editor/timeline/selection/logic/cueEdit";
import {
  getClipboardCues,
  getClipboardRegions,
  setClipboardCues,
  setClipboardRegions,
} from "@/screens/editor/timeline/selection/logic/timelineClipboard";
// Clipboards live in a module, not in this component -- see
// timelineClipboard.ts: Timeline unmounts on a tab switch, and a clipboard
// that empties because you looked at the Player is not a clipboard.
import {
  addRegionEntries,
  deleteSelectedRegions as deleteRegions,
  offsetRegionsToPlayhead,
  resolveSelectedRegions,
  resolveSongLocal,
  selectRegionKeys,
} from "@/screens/editor/timeline/regions/logic/regionEdit";
import { lookupAnyRegion, type RegionSelKey } from "@/screens/editor/timeline/regions/logic/regionUtils";
import {
  trackSelectionGesture,
  type TrackSelectionGesture,
} from "@/screens/editor/timeline/tracks/logic/trackSelection";

interface SelectionActionOptions {
  songs: SongRow[];
  selectedCueKeys: CueSelKey[];
  cueSelection: CueSelKey | null;
  setCueSelection: Dispatch<SetStateAction<CueSelKey | null>>;
  setSelectedCueKeys: Dispatch<SetStateAction<CueSelKey[]>>;
  selectedRegionKeys: RegionSelKey[];
  setSelectedRegionKeys: Dispatch<SetStateAction<RegionSelKey[]>>;
  songOffsets: number[];
  songLengths: number[];
  playheadAbsNow: () => number;
  showToast: (message: string) => void;
  onSelectTrackId?: (
    id: string | null,
    gesture?: TrackSelectionGesture,
  ) => void;
}

/** Keep selection, clipboard, and edit actions out of the timeline renderer. */
export function createTimelineSelectionActions({
  songs,
  selectedCueKeys,
  cueSelection,
  setCueSelection,
  setSelectedCueKeys,
  selectedRegionKeys,
  setSelectedRegionKeys,
  songOffsets,
  songLengths,
  playheadAbsNow,
  showToast,
  onSelectTrackId,
}: SelectionActionOptions) {
  const copySelectedCue = () => {
    const keys =
      selectedCueKeys.length > 0
        ? selectedCueKeys
        : cueSelection
          ? [cueSelection]
          : [];
    const entries: CueClipboardEntry[] = [];
    for (const key of keys) {
      const cue = findCue(songs, key);
      if (cue) entries.push({ ...cue, songIndex: key.songIndex });
    }
    if (entries.length === 0) return;
    setClipboardCues(entries);
    showToast(
      entries.length === 1
        ? "Copied light cue"
        : `Copied ${entries.length} light cues`,
    );
  };

  const deleteSelectedCue = () => {
    const keys =
      selectedCueKeys.length > 0
        ? selectedCueKeys
        : cueSelection
          ? [cueSelection]
          : [];
    if (keys.length === 0) return;
    void deleteCues(keys);
    setCueSelection(null);
    setSelectedCueKeys([]);
    showToast(
      keys.length === 1 ? "Deleted light cue" : `Deleted ${keys.length} cues`,
    );
  };

  const selectCue = (
    selection: CueSelKey | null,
    modifiers?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ) => {
    if (selection === null) {
      setCueSelection(null);
      setSelectedCueKeys([]);
      return;
    }
    const additive = Boolean(modifiers?.metaKey || modifiers?.ctrlKey);
    setCueSelection(selection);
    setSelectedCueKeys((previous) => {
      if (additive) {
        const hasSelection = previous.some(
          (item) =>
            item.songIndex === selection.songIndex &&
            item.cueId === selection.cueId,
        );
        return hasSelection
          ? previous.filter(
              (item) =>
                !(
                  item.songIndex === selection.songIndex &&
                  item.cueId === selection.cueId
                ),
            )
          : [...previous, selection];
      }
      return [selection];
    });
    // Selecting a cue clears audio region selection.
    setSelectedRegionKeys([]);
  };

  const duplicateSelectedCue = async () => {
    if (!cueSelection) return;
    if (await duplicateCue(songs, cueSelection))
      showToast("Duplicated light cue");
  };

  const pasteClipboardCues = async () => {
    if (getClipboardCues().length === 0) return;
    const { songIndex, localSeconds } = resolveSongLocal(
      songOffsets,
      songLengths,
      playheadAbsNow(),
    );
    const placed = offsetCuesToPlayhead(
      getClipboardCues(),
      songIndex,
      localSeconds,
    );
    const count = await pasteCues(placed);
    if (count) {
      showToast(`Pasted ${count} light cue(s) at playhead`);
      setSelectedCueKeys([]);
      setCueSelection(null);
      setSelectedRegionKeys([]);
    }
  };

  const splitSelectedCueAtPlayhead = async () => {
    if (!cueSelection) {
      showToast("Select a cue to trim");
      return;
    }
    const status = await splitCueAtPlayhead(
      songs,
      cueSelection,
      songOffsets,
      playheadAbsNow(),
    );
    if (status === "playhead-outside") {
      showToast("Playhead is not inside the selected cue");
      return;
    }
    if (status === "ok") {
      showToast("Split cue at playhead");
      setCueSelection(null);
    }
  };

  const selectRegion = (
    key: RegionSelKey,
    event: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ) => {
    setSelectedRegionKeys(
      selectRegionKeys(key, event, selectedRegionKeys, songs),
    );
    setCueSelection(null);
    setSelectedCueKeys([]);
    const found = lookupAnyRegion(songs, key);
    if (found?.region?.trackId) {
      onSelectTrackId?.(found.region.trackId, trackSelectionGesture(event));
    }
  };

  const copySelectedRegions = () => {
    const entries = resolveSelectedRegions(selectedRegionKeys, songs);
    setClipboardRegions(entries);
    if (entries.length) showToast(`Copied ${entries.length} region(s)`);
  };

  /**
   * Cut: copy, then remove.
   *
   * Missing until now, which is also why the toolbar's scissors read as
   * "cut" to everyone who saw it -- it is Split. Cut is the operation people
   * actually reach for when moving a region somewhere far away, where
   * dragging means scrolling with the mouse down.
   */
  const cutSelectedRegions = () => {
    if (selectedRegionKeys.length === 0) return;
    const entries = resolveSelectedRegions(selectedRegionKeys, songs);
    if (entries.length === 0) return;
    setClipboardRegions(entries);
    deleteRegions(selectedRegionKeys, songs);
    setSelectedRegionKeys([]);
    showToast(`Cut ${entries.length} region(s)`);
  };

  const cutSelectedCues = () => {
    copySelectedCue();
    if (getClipboardCues().length === 0) return;
    deleteSelectedCue();
    showToast(`Cut ${getClipboardCues().length} cue(s)`);
  };

  const deleteSelectedRegions = () => {
    if (selectedRegionKeys.length === 0) return;
    deleteRegions(selectedRegionKeys, songs);
    setSelectedRegionKeys([]);
    showToast("Deleted region(s)");
  };

  const duplicateSelectedRegions = async () => {
    const entries = resolveSelectedRegions(selectedRegionKeys, songs);
    await addRegionEntries(entries, songs);
    if (entries.length) showToast(`Duplicated ${entries.length} region(s)`);
  };

  const pasteClipboardRegions = async () => {
    if (getClipboardRegions().length === 0) return;
    const { songIndex, localSeconds } = resolveSongLocal(
      songOffsets,
      songLengths,
      playheadAbsNow(),
    );
    const placed = offsetRegionsToPlayhead(
      getClipboardRegions(),
      songIndex,
      localSeconds,
    );
    await addRegionEntries(placed, songs);
    showToast(`Pasted ${getClipboardRegions().length} region(s) at playhead`);
    setSelectedRegionKeys([]);
    setSelectedCueKeys([]);
    setCueSelection(null);
  };

  return {
    copySelectedCue,
    deleteSelectedCue,
    selectCue,
    duplicateSelectedCue,
    pasteClipboardCues,
    splitSelectedCueAtPlayhead,
    selectRegion,
    copySelectedRegions,
    cutSelectedRegions,
    cutSelectedCues,
    deleteSelectedRegions,
    duplicateSelectedRegions,
    pasteClipboardRegions,
  };
}
