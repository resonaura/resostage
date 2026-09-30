import { useEffect } from "react";
import type { SongRow } from "../../../../lib/state/types";
import type { CueSelKey } from "../../../light/LightTimeline";
import { allRegionSelKeys, type RegionSelKey } from "../../regions/logic/regionUtils";
import type { TimelineViewMode } from "../../TimelineToolbar";
import { hotkeyManager, HotkeyScope } from "../../../../lib/interaction/HotkeyManager";

type Actions = {
  // light
  copySelectedCue: () => void;
  cutSelectedCues: () => void;
  pasteClipboardCues: () => void;
  duplicateSelectedCue: () => void;
  splitSelectedCueAtPlayhead: () => void;
  deleteSelectedCue: () => void;
  setCueSelection: (v: CueSelKey | null) => void;
  selectAllCues: () => void;
  // audio
  copySelectedRegions: () => void;
  cutSelectedRegions: () => void;
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
  hasCueSelection,
  selectedRegionKeys,
  songs,
  actions,
}: {
  readOnly: boolean;
  effectiveViewMode: TimelineViewMode;
  hasCueSelection: boolean;
  selectedRegionKeys: RegionSelKey[];
  songs: SongRow[];
  actions: Actions;
}) {
  useEffect(() => {
    if (readOnly) return;
    const mod = /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
      ? "cmd"
      : "ctrl";
    const scope = HotkeyScope.Timeline;
    const commands: Array<[string, string, () => void]> =
      effectiveViewMode === "light"
        ? [
            ["select-all-cues", `${mod} + a`, () => actions.selectAllCues()],
            ["copy-cue", `${mod} + c`, () => actions.copySelectedCue()],
            ["cut-cue", `${mod} + x`, () => actions.cutSelectedCues()],
            ["paste-cue", `${mod} + v`, () => void actions.pasteClipboardCues()],
            ["duplicate-cue", `${mod} + d`, () => actions.duplicateSelectedCue()],
            ["split-cue", `${mod} + t`, () => void actions.splitSelectedCueAtPlayhead()],
            ["delete-cue", "delete", () => { if (hasCueSelection) actions.deleteSelectedCue(); }],
            ["delete-cue-backspace", "backspace", () => { if (hasCueSelection) actions.deleteSelectedCue(); }],
            ["deselect-cue", "escape", () => actions.setCueSelection(null)],
          ]
        : [
            ["select-all-regions", `${mod} + a`, () => actions.setSelectedRegionKeys(allRegionSelKeys(songs))],
            ["copy-regions", `${mod} + c`, () => actions.copySelectedRegions()],
            ["cut-regions", `${mod} + x`, () => actions.cutSelectedRegions()],
            ["paste-regions", `${mod} + v`, () => void actions.pasteClipboardRegions()],
            ["duplicate-regions", `${mod} + d`, () => actions.duplicateSelectedRegions()],
            ["split-regions", `${mod} + t`, () => void actions.splitSelectedAtPlayhead()],
            ["delete-regions", "delete", () => { if (selectedRegionKeys.length) actions.deleteSelectedRegions(); }],
            ["delete-regions-backspace", "backspace", () => { if (selectedRegionKeys.length) actions.deleteSelectedRegions(); }],
            ["deselect-regions", "escape", () => actions.setSelectedRegionKeys([])],
          ];
    return commands.map(([id, key, handler]) =>
      hotkeyManager.registerCommand(
        `timeline.${id}`,
        key,
        { scope, priority: 100 },
        handler,
      ),
    ).reduce((disposeAll, dispose) => () => { dispose(); disposeAll(); }, () => {});
  }, [
    readOnly,
    effectiveViewMode,
    hasCueSelection,
    selectedRegionKeys,
    songs,
    actions,
  ]);
}
