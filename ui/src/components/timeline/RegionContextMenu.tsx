import { builder } from "../../lib/api";
import type { SongRow } from "../../lib/types";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "../ContextMenu";
import type { RegionSelKey, RegionUiState } from "./regionUtils";

export type RegionContextMenuState = {
  x: number;
  y: number;
  songIndex: number;
  regionId: string;
  selKey: RegionSelKey;
};

export function RegionContextMenu({
  menu,
  songs,
  getRegionUi,
  setRegionUi,
  onCopy,
  onCut,
  onPaste,
  canPaste = false,
  onSplit,
  onClose,
}: {
  menu: RegionContextMenuState;
  songs: SongRow[];
  getRegionUi: (key: RegionSelKey) => RegionUiState;
  setRegionUi: (key: RegionSelKey, patch: Partial<RegionUiState>) => void;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
  /** Greys out Paste when the clipboard holds nothing for this surface. */
  canPaste?: boolean;
  onSplit?: () => void;
  onClose: () => void;
}) {
  const song = songs[menu.songIndex];
  const songRegion = song?.regions?.find((r) => r.id === menu.regionId);
  if (!songRegion || !song) return null;

  const regUi = getRegionUi(menu.selKey);

  return (
    <ContextMenu x={menu.x} y={menu.y} width={180} onClose={onClose}>
      {onCut && (
        <ContextMenuItem
          onClick={() => {
            onCut();
            onClose();
          }}
        >
          Cut
        </ContextMenuItem>
      )}
      {onCopy && (
        <ContextMenuItem
          onClick={() => {
            onCopy();
            onClose();
          }}
        >
          Copy
        </ContextMenuItem>
      )}
      {onPaste && (
        <ContextMenuItem
          disabled={!canPaste}
          onClick={() => {
            if (!canPaste) return;
            onPaste();
            onClose();
          }}
        >
          Paste at Playhead
        </ContextMenuItem>
      )}
      {onSplit && (
        <>
          <ContextMenuDivider />
          <ContextMenuItem
            onClick={() => {
              onSplit();
              onClose();
            }}
          >
            Split at Playhead
          </ContextMenuItem>
        </>
      )}
      <ContextMenuItem
        onClick={() => {
          setRegionUi(menu.selKey, { muted: !regUi.muted });
          onClose();
        }}
      >
        {regUi.muted ? "Unmute Region" : "Mute Region"}
      </ContextMenuItem>

      {/* Reverse is a property of the region, not of its speed: a region can
          be reversed at 1x, and a region at 0.5x need not be. Both live on
          Region::playback and neither touches looping -- a reversed loop
          still loops, backwards. */}
      <ContextMenuItem
        checked={songRegion.playback?.reverse ?? false}
        onClick={() => {
          void builder.regionUpdate({
            songIndex: menu.songIndex,
            regionId: menu.regionId,
            reverse: !(songRegion.playback?.reverse ?? false),
          });
          onClose();
        }}
      >
        Reverse
      </ContextMenuItem>

      <ContextMenuDivider />

      <ContextMenuItem
        danger
        onClick={() => {
          void builder.regionRemove(menu.songIndex, menu.regionId);
          onClose();
        }}
      >
        Delete Region
      </ContextMenuItem>
    </ContextMenu>
  );
}
