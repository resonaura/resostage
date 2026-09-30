import type { Dispatch, SetStateAction } from "react";
import { Music, Mic, Sliders } from "lucide-react";
import { builder, lighting, mixer } from "../../../../lib/state/api";
import type {
  LightTrackRow,
  TrackRow,
  WebUiState,
} from "../../../../lib/state/types";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "../../../common/ContextMenu";
import { InlineNamePrompt } from "../../../common/InlineNamePrompt";

export interface SidebarMenuPosition {
  x: number;
  y: number;
}

export interface SidebarTrackMenuState extends SidebarMenuPosition {
  trackIndex: number;
  track: TrackRow;
}

export interface SidebarLightTrackMenuState extends SidebarMenuPosition {
  index: number;
  track: LightTrackRow;
}

export interface SidebarRenameState extends SidebarMenuPosition {
  index: number;
  name: string;
}

interface TimelineSidebarMenusProps {
  state: WebUiState;
  lightTracks: LightTrackRow[];
  contextTrackIndices: number[];
  addTrackMenu: SidebarMenuPosition | null;
  setAddTrackMenu: Dispatch<SetStateAction<SidebarMenuPosition | null>>;
  trackMenu: SidebarTrackMenuState | null;
  setTrackMenu: Dispatch<SetStateAction<SidebarTrackMenuState | null>>;
  lightTrackMenu: SidebarLightTrackMenuState | null;
  setLightTrackMenu: Dispatch<
    SetStateAction<SidebarLightTrackMenuState | null>
  >;
  renamingTrack: SidebarRenameState | null;
  setRenamingTrack: Dispatch<SetStateAction<SidebarRenameState | null>>;
  renamingLightTrack: SidebarRenameState | null;
  setRenamingLightTrack: Dispatch<SetStateAction<SidebarRenameState | null>>;
  onAddTrack: (kind: "audio" | "instrument", channels: number) => void;
  onAddBus: () => void;
}

/** Context menus and inline rename prompts owned by the timeline sidebar. */
export function TimelineSidebarMenus({
  state,
  lightTracks,
  contextTrackIndices,
  addTrackMenu,
  setAddTrackMenu,
  trackMenu,
  setTrackMenu,
  lightTrackMenu,
  setLightTrackMenu,
  renamingTrack,
  setRenamingTrack,
  renamingLightTrack,
  setRenamingLightTrack,
  onAddTrack,
  onAddBus,
}: TimelineSidebarMenusProps) {
  return (
    <>
      {addTrackMenu && (
        <ContextMenu
          x={addTrackMenu.x}
          y={addTrackMenu.y}
          width={220}
          onClose={() => setAddTrackMenu(null)}
        >
          <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-foreground/40 border-b border-default/20">
            Create New Track
          </div>
          <ContextMenuItem onClick={() => onAddTrack("instrument", 2)}>
            <div className="flex items-center gap-2">
              <Music size={14} className="text-purple-400" />
              <span>Software Instrument Track</span>
            </div>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onAddTrack("audio", 2)}>
            <div className="flex items-center gap-2">
              <Mic size={14} className="text-blue-400" />
              <span>Audio Track (Stereo)</span>
            </div>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onAddTrack("audio", 1)}>
            <div className="flex items-center gap-2">
              <Mic size={14} className="text-teal-400" />
              <span>Audio Track (Mono)</span>
            </div>
          </ContextMenuItem>
          <div className="my-1 border-t border-default/20" />
          <ContextMenuItem onClick={onAddBus}>
            <div className="flex items-center gap-2">
              <Sliders size={14} className="text-orange-400" />
              <span>Aux / Send Bus</span>
            </div>
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Audio / Instrument Track Context Menu */}
      {trackMenu && (
        <ContextMenu
          x={trackMenu.x}
          y={trackMenu.y}
          width={210}
          onClose={() => setTrackMenu(null)}
        >
          {contextTrackIndices.length > 1 && (
            <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-foreground/40 border-b border-default/20">
              {contextTrackIndices.length} Selected Tracks
            </div>
          )}
          <ContextMenuItem
            disabled={contextTrackIndices.length > 1}
            onClick={() => {
              const menu = trackMenu;
              setTrackMenu(null);
              setRenamingTrack({
                x: menu.x,
                y: menu.y,
                index: menu.trackIndex,
                name: menu.track.name || menu.track.id,
              });
            }}
          >
            Rename…
          </ContextMenuItem>
          <ContextMenuItem
            disabled={contextTrackIndices.length > 1}
            onClick={() => {
              void builder.trackDuplicate(trackMenu.trackIndex, false);
              setTrackMenu(null);
            }}
          >
            Duplicate Track
          </ContextMenuItem>
          <ContextMenuItem
            disabled={contextTrackIndices.length > 1}
            onClick={() => {
              void builder.trackDuplicate(trackMenu.trackIndex, true);
              setTrackMenu(null);
            }}
          >
            Duplicate Track with Content
          </ContextMenuItem>
          {["instrument", "midi", "externalMidi"].includes(
            trackMenu.track.kind ?? "",
          ) && (
            <ContextMenuItem
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("resostage-open-midi-export", {
                    detail: { kind: "track", trackId: trackMenu.track.id },
                  }),
                );
                setTrackMenu(null);
              }}
            >
              Export Track as MIDI…
            </ContextMenuItem>
          )}
          <ContextMenuDivider />
          <ContextMenuItem
            disabled={contextTrackIndices.length > 1 || trackMenu.trackIndex === 0}
            onClick={() => {
              const songIndex = state.songIndex >= 0 ? state.songIndex : 0;
              void builder.trackMove(songIndex, trackMenu.trackIndex, -1);
              setTrackMenu(null);
            }}
          >
            Move Up
          </ContextMenuItem>
          <ContextMenuItem
            disabled={
              contextTrackIndices.length > 1 ||
              trackMenu.trackIndex >= state.tracks.length - 1
            }
            onClick={() => {
              const songIndex = state.songIndex >= 0 ? state.songIndex : 0;
              void builder.trackMove(songIndex, trackMenu.trackIndex, 1);
              setTrackMenu(null);
            }}
          >
            Move Down
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            onClick={() => {
              for (const index of contextTrackIndices) {
                void mixer.setTrackGain(index, 0);
                void mixer.setTrackPan(index, 0);
              }
              setTrackMenu(null);
            }}
          >
            Reset Gain &amp; Pan
            {contextTrackIndices.length > 1 ? " (Selected)" : ""}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              for (const index of contextTrackIndices) {
                void mixer.setTrackMute(index, false);
                void mixer.setTrackSolo(index, false);
              }
              setTrackMenu(null);
            }}
          >
            Clear Mute &amp; Solo
            {contextTrackIndices.length > 1 ? " (Selected)" : ""}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              for (const index of contextTrackIndices) {
                const track = state.tracks[index];
                if (!track) continue;
                const isPol =
                  (track.polarity ??
                    (track.phaseInvert ? "both" : "none")) !== "none";
                const nextPol = isPol
                  ? "none"
                  : track.channels === 1
                    ? "left"
                    : "both";
                void mixer.setTrackTrim(
                  index,
                  track.inputTrimDb ?? 0,
                  nextPol !== "none",
                  nextPol,
                );
              }
              setTrackMenu(null);
            }}
          >
            Phase Invert (Ø)
            {contextTrackIndices.length > 1 ? " (Selected)" : ""}
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            danger
            onClick={async () => {
              const songIndex = state.songIndex >= 0 ? state.songIndex : 0;
              setTrackMenu(null);
              for (const index of [...contextTrackIndices].sort(
                (a, b) => b - a,
              )) {
                await builder.trackRemove(songIndex, index);
              }
            }}
          >
            Delete {contextTrackIndices.length > 1
              ? `${contextTrackIndices.length} Tracks`
              : "Track"}
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Light Track Context Menu */}
      {lightTrackMenu && (
        <ContextMenu
          x={lightTrackMenu.x}
          y={lightTrackMenu.y}
          width={200}
          onClose={() => setLightTrackMenu(null)}
        >
          <ContextMenuItem
            onClick={() => {
              const menu = lightTrackMenu;
              setLightTrackMenu(null);
              setRenamingLightTrack({
                x: menu.x,
                y: menu.y,
                index: menu.index,
                name: menu.track.name || `Light Track ${menu.index + 1}`,
              });
            }}
          >
            Rename…
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            disabled={lightTrackMenu.index === 0}
            onClick={() => {
              void lighting.trackMove(lightTrackMenu.index, -1);
              setLightTrackMenu(null);
            }}
          >
            Move Up
          </ContextMenuItem>
          <ContextMenuItem
            disabled={lightTrackMenu.index >= lightTracks.length - 1}
            onClick={() => {
              void lighting.trackMove(lightTrackMenu.index, 1);
              setLightTrackMenu(null);
            }}
          >
            Move Down
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            onClick={() => {
              void lighting.trackAdd();
              setLightTrackMenu(null);
            }}
          >
            Add Light Track
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            danger
            onClick={() => {
              void lighting.trackRemove(lightTrackMenu.index);
              setLightTrackMenu(null);
            }}
          >
            Delete Track
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Rename Prompt for Audio / Instrument Track */}
      {renamingTrack && (
        <InlineNamePrompt
          x={renamingTrack.x}
          y={renamingTrack.y}
          value={renamingTrack.name}
          placeholder="Track name"
          onChange={(value) =>
            setRenamingTrack((previous) =>
              previous ? { ...previous, name: value } : null,
            )
          }
          onCommit={() => {
            const name = renamingTrack.name.trim();
            if (name.length > 0) {
              const songIndex = state.songIndex >= 0 ? state.songIndex : 0;
              void builder.trackUpdate({
                songIndex,
                index: renamingTrack.index,
                name,
              });
            }
            setRenamingTrack(null);
          }}
          onCancel={() => setRenamingTrack(null)}
        />
      )}

      {/* Rename Prompt for Light Track */}
      {renamingLightTrack && (
        <InlineNamePrompt
          x={renamingLightTrack.x}
          y={renamingLightTrack.y}
          value={renamingLightTrack.name}
          placeholder="Light track name"
          onChange={(value) =>
            setRenamingLightTrack((previous) =>
              previous ? { ...previous, name: value } : null,
            )
          }
          onCommit={() => {
            const name = renamingLightTrack.name.trim();
            if (name.length > 0) {
              void lighting.trackUpdate({
                index: renamingLightTrack.index,
                name,
              });
            }
            setRenamingLightTrack(null);
          }}
          onCancel={() => setRenamingLightTrack(null)}
        />
      )}
    </>
  );
}
