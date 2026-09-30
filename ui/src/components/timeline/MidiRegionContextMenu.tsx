import { builder } from "../../lib/state/api";
import type { MidiRegionRow } from "../../lib/state/types";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "../common/ContextMenu";

export interface MidiRegionContextMenuState {
  x: number;
  y: number;
  songIndex: number;
  region: MidiRegionRow;
}

interface MidiRegionContextMenuProps {
  menu: MidiRegionContextMenuState | null;
  onClose: () => void;
  onOpenMidiRegion?: (trackId: string, regionId: string) => void;
}

/** MIDI-region actions are kept together, separate from lane rendering. */
export function MidiRegionContextMenu({
  menu,
  onClose,
  onOpenMidiRegion,
}: MidiRegionContextMenuProps) {
  if (!menu) return null;

  return (
    <ContextMenu x={menu.x} y={menu.y} width={220} onClose={onClose}>
      <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-foreground/40 border-b border-default/20">
        {menu.region.name || "MIDI Region"}
      </div>
      <ContextMenuItem
        onClick={() => {
          const currentName = menu.region.name || "MIDI Region";
          const newName = window.prompt("Rename MIDI Region", currentName);
          if (newName !== null && newName.trim()) {
            void builder.midiRegionUpdate({
              songIndex: menu.songIndex,
              regionId: menu.region.id,
              name: newName.trim(),
            });
          }
          onClose();
        }}
      >
        Rename Region…
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          void builder.midiRegionAdd({
            songIndex: menu.songIndex,
            trackId: menu.region.trackId,
            name: `${menu.region.name || "MIDI"} (Copy)`,
            startBeats: menu.region.startBeats + menu.region.durationBeats,
            durationBeats: menu.region.durationBeats,
            clipOffsetBeats: menu.region.clipOffsetBeats,
            loop: menu.region.loop,
            loopLengthBeats: menu.region.loopLengthBeats,
            loopStartBeats: menu.region.loopStartBeats ?? 0,
            muted: Boolean(menu.region.muted),
            color: menu.region.color,
            notes: menu.region.notes.map((note) => ({ ...note })),
            events: (menu.region.events ?? []).map((event) => ({
              ...event,
              data: [...event.data],
            })),
            umpEvents: (menu.region.umpEvents ?? []).map((event) => ({
              ...event,
              words: [...event.words],
            })),
            automationLanes: menu.region.automationLanes,
          });
          onClose();
        }}
      >
        Duplicate Region
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          void builder.midiRegionUpdate({
            songIndex: menu.songIndex,
            regionId: menu.region.id,
            muted: !menu.region.muted,
          });
          onClose();
        }}
      >
        {menu.region.muted ? "Unmute Region" : "Mute Region"}
      </ContextMenuItem>
      <ContextMenuDivider />
      <ContextMenuItem
        onClick={() => {
          window.dispatchEvent(
            new CustomEvent("resostage-open-midi-export", {
              detail: {
                kind: "region",
                songIndex: menu.songIndex,
                trackId: menu.region.trackId,
                regionId: menu.region.id,
              },
            }),
          );
          onClose();
        }}
      >
        Export Region as MIDI…
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          onOpenMidiRegion?.(menu.region.trackId, menu.region.id);
          onClose();
        }}
      >
        Open in Piano Roll
      </ContextMenuItem>
      <ContextMenuDivider />
      <ContextMenuItem
        danger
        onClick={() => {
          void builder.midiRegionRemove(menu.songIndex, menu.region.id);
          onClose();
        }}
      >
        Delete Region
      </ContextMenuItem>
    </ContextMenu>
  );
}
