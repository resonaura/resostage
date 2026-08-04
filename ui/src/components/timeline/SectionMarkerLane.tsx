import { useRef, useState } from "react";
import { builder } from "../../lib/api";
import type { SectionRow, SongRow } from "../../lib/types";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "../ContextMenu";
import {
  SECTION_LANE_HEIGHT,
  SECTION_PRESETS,
  TRACK_COLORS,
} from "./constants";
import { formatTimeShort, snapToGridSec } from "./geometry";

// Point markers, not ranges -- the segment a marker covers is implicitly
// "from here to the next marker (or song end)", same convention as the
// native TimelineView.cpp's section-marker ruler this mirrors. Right-click
// empty lane space to add one at that time; right-click an existing marker
// to rename/delete it; drag a marker to reposition it (commits on release).

interface SectionMenuState {
  x: number;
  y: number;
  songIndex: number;
  startSeconds: number;
  /** Present only when the menu was opened on an existing marker. */
  sectionId?: string;
}

export function SectionMarkerLane({
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  contentWidth,
  readOnly,
  snapToGrid = false,
}: {
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  contentWidth: number;
  readOnly: boolean;
  snapToGrid?: boolean;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<SectionMenuState | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // Drag bookkeeping (startX/origStart) lives in a ref -- doesn't need to
  // trigger renders. The live dragged position is state so the marker's
  // on-screen position actually updates as the pointer moves.
  const dragMetaRef = useRef<{
    songIndex: number;
    sectionId: string;
    startX: number;
    origStart: number;
  } | null>(null);
  const [liveDrag, setLiveDrag] = useState<{
    songIndex: number;
    sectionId: string;
    value: number;
  } | null>(null);

  const resolveSongAt = (
    absSeconds: number,
  ): { songIndex: number; localSeconds: number } => {
    for (let i = 0; i < songOffsets.length; i++) {
      const start = songOffsets[i];
      const end = start + songLengths[i];
      if (absSeconds < end || i === songOffsets.length - 1)
        return { songIndex: i, localSeconds: Math.max(0, absSeconds - start) };
    }
    return { songIndex: -1, localSeconds: 0 };
  };

  const openMenuAt = (
    e: React.MouseEvent,
    existing?: { songIndex: number; sectionId: string },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (readOnly) return;
    if (existing) {
      setMenu({
        x: e.clientX,
        y: e.clientY,
        songIndex: existing.songIndex,
        startSeconds: 0,
        sectionId: existing.sectionId,
      });
      return;
    }
    const rect = laneRef.current?.getBoundingClientRect();
    const absSeconds = rect
      ? Math.max(0, (e.clientX - rect.left) / pxPerSec)
      : 0;
    const { songIndex, localSeconds } = resolveSongAt(absSeconds);
    if (songIndex < 0) return;
    const song = songs[songIndex];
    const bpm = song?.bpm ?? 120;
    const tsNum = song?.tsNum ?? 4;
    const snappedLocal = snapToGridSec(
      localSeconds,
      pxPerSec,
      bpm,
      tsNum,
      snapToGrid,
    );
    setMenu({
      x: e.clientX,
      y: e.clientY,
      songIndex,
      startSeconds: snappedLocal,
    });
  };

  const closeMenu = () => {
    setMenu(null);
    setRenaming(false);
    setNameDraft("");
  };

  const applyPreset = (name: string) => {
    if (!menu) return;
    if (menu.sectionId) {
      void builder.sectionUpdate({
        songIndex: menu.songIndex,
        sectionId: menu.sectionId,
        name,
      });
    } else {
      void builder.sectionAdd(menu.songIndex, menu.startSeconds, name);
    }
    closeMenu();
  };

  const commitCustomName = () => {
    const name = nameDraft.trim();
    if (name.length > 0) applyPreset(name);
    else closeMenu();
  };

  const removeMarker = () => {
    if (!menu?.sectionId) return;
    void builder.sectionRemove(menu.songIndex, menu.sectionId);
    closeMenu();
  };

  const beginDrag = (
    e: React.PointerEvent,
    songIndex: number,
    sectionId: string,
    origStart: number,
  ) => {
    if (readOnly) return;
    e.stopPropagation();
    dragMetaRef.current = {
      songIndex,
      sectionId,
      startX: e.clientX,
      origStart,
    };
    setLiveDrag({ songIndex, sectionId, value: origStart });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const meta = dragMetaRef.current;
    if (!meta) return;
    const dSec = (e.clientX - meta.startX) / pxPerSec;
    const songLen = songLengths[meta.songIndex] ?? 0;
    const rawValue = Math.max(0, Math.min(songLen, meta.origStart + dSec));
    const song = songs[meta.songIndex];
    const bpm = song?.bpm ?? 120;
    const tsNum = song?.tsNum ?? 4;
    const value = snapToGridSec(rawValue, pxPerSec, bpm, tsNum, snapToGrid);
    setLiveDrag({
      songIndex: meta.songIndex,
      sectionId: meta.sectionId,
      value,
    });
  };
  const onDragEnd = (e: React.PointerEvent) => {
    const meta = dragMetaRef.current;
    dragMetaRef.current = null;
    if (!meta) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const finalValue = liveDrag?.value ?? meta.origStart;
    setLiveDrag(null);
    void builder.sectionUpdate({
      songIndex: meta.songIndex,
      sectionId: meta.sectionId,
      startSeconds: finalValue,
    });
  };

  return (
    <div
      ref={laneRef}
      className={`relative shrink-0 border-b border-default/30 bg-surface/20 touch-none ${
        readOnly ? "" : "cursor-context-menu"
      }`}
      style={{ height: SECTION_LANE_HEIGHT, width: contentWidth }}
      onContextMenu={(e) => openMenuAt(e)}
    >
      {songs.map((song, i) =>
        (song.sections ?? []).map((sec: SectionRow) => {
          const isDragging =
            liveDrag?.songIndex === i && liveDrag?.sectionId === sec.id;
          const startSeconds = isDragging ? liveDrag!.value : sec.startSeconds;
          const left = (songOffsets[i] + startSeconds) * pxPerSec;
          const color = TRACK_COLORS[sec.colorIndex % TRACK_COLORS.length];
          return (
            <div
              key={`${i}:${sec.id}`}
              className="absolute top-0 bottom-0 flex items-center"
              style={{ left, cursor: readOnly ? "default" : "ew-resize" }}
              title={`${sec.name} @ ${formatTimeShort(sec.startSeconds)}${readOnly ? "" : " (drag to move, right-click to edit)"}`}
              onPointerDown={(e) => beginDrag(e, i, sec.id, sec.startSeconds)}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onContextMenu={(e) =>
                openMenuAt(e, { songIndex: i, sectionId: sec.id })
              }
            >
              <div className="h-full w-px" style={{ background: color }} />
              <div
                className="ml-0.5 truncate rounded px-1 py-0.5 text-[9px] font-semibold leading-none"
                style={{ background: color + "33", color }}
              >
                {sec.name}
              </div>
            </div>
          );
        }),
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} width={168} onClose={closeMenu}>
          {renaming ? (
            <form
              className="px-2 py-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                commitCustomName();
              }}
            >
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeMenu();
                }}
                placeholder="Section name"
                className="w-full rounded border border-default/40 bg-default/20 px-1.5 py-1 text-xs text-foreground focus:outline-none"
              />
            </form>
          ) : (
            <>
              {SECTION_PRESETS.map((p) => (
                <ContextMenuItem key={p} onClick={() => applyPreset(p)}>
                  {p}
                </ContextMenuItem>
              ))}
              <ContextMenuItem
                onClick={() => {
                  setNameDraft("");
                  setRenaming(true);
                }}
              >
                Custom...
              </ContextMenuItem>
              {menu.sectionId && (
                <>
                  <ContextMenuDivider />
                  <ContextMenuItem danger onClick={removeMarker}>
                    Delete Marker
                  </ContextMenuItem>
                </>
              )}
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
