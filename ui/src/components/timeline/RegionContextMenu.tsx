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
  onClose,
}: {
  menu: RegionContextMenuState;
  songs: SongRow[];
  getRegionUi: (key: RegionSelKey) => RegionUiState;
  setRegionUi: (key: RegionSelKey, patch: Partial<RegionUiState>) => void;
  onClose: () => void;
}) {
  const song = songs[menu.songIndex];
  const songRegion = song?.regions?.find((r) => r.id === menu.regionId);
  if (!songRegion || !song) return null;

  const regUi = getRegionUi(menu.selKey);

  return (
    <ContextMenu x={menu.x} y={menu.y} width={180} onClose={onClose}>
      <ContextMenuItem
        onClick={() => {
          setRegionUi(menu.selKey, { muted: !regUi.muted });
          onClose();
        }}
      >
        {regUi.muted ? "Unmute Region" : "Mute Region"}
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
