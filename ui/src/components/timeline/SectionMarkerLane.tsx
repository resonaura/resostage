import { useRef, useState } from "react";
import { builder } from "../../lib/api";
import type { SectionRow, SongRow } from "../../lib/types";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "../ContextMenu";
import { SECTION_LANE_HEIGHT, SECTION_PRESETS } from "./constants";
import { formatTimeShort, snapToGridSec } from "./geometry";

/** Neutral marker chrome — no per-section accent colours. */
const SECTION_LINE = "rgba(255,255,255,0.22)";
const SECTION_CHIP_BG = "rgba(255,255,255,0.08)";
const SECTION_CHIP_FG = "rgba(255,255,255,0.55)";

// Point markers, not ranges -- the segment a marker covers is implicitly
// "from here to the next marker (or song end)". In the Editor, empty-lane
// left-click (or right-click) opens the section-create context menu; existing
// markers: drag to move, double-click = cycle, right-click = edit/delete.

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
  /** Double-click a section marker → set cycle to that section's range
   *  (start → next section / song end). Song sections, not audio regions. */
  onCycleFromSection,
}: {
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  contentWidth: number;
  readOnly: boolean;
  snapToGrid?: boolean;
  onCycleFromSection?: (
    songIndex: number,
    leftSec: number,
    rightSec: number,
  ) => void;
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

  /** Section covers [start, next.start) or [start, songEnd). */
  const sectionRange = (
    songIndex: number,
    sectionId: string,
  ): { leftSec: number; rightSec: number } | null => {
    const song = songs[songIndex];
    if (!song) return null;
    const songLen = songLengths[songIndex] ?? 0;
    const ordered = [...(song.sections ?? [])].sort(
      (a, b) => a.startSeconds - b.startSeconds,
    );
    const idx = ordered.findIndex((s) => s.id === sectionId);
    if (idx < 0) return null;
    const leftSec = Math.max(0, ordered[idx].startSeconds);
    const rightSec =
      idx + 1 < ordered.length
        ? Math.max(leftSec, ordered[idx + 1].startSeconds)
        : Math.max(leftSec, songLen);
    if (rightSec - leftSec < 0.05) return null;
    return { leftSec, rightSec };
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
        // Editor: context-menu cursor on empty lane (place a section).
        // Markers below override with ew-resize for drag-to-move.
        readOnly ? "" : "cursor-context-menu"
      }`}
      style={{ height: SECTION_LANE_HEIGHT, width: contentWidth }}
      onContextMenu={(e) => {
        if (readOnly) return;
        openMenuAt(e);
      }}
      onClick={(e) => {
        // Editor only: left-click empty lane → section create menu
        // (Intro/Verse/Chorus/… + custom). Markers stopPropagation.
        if (readOnly || e.button !== 0) return;
        if (e.detail !== 1) return;
        openMenuAt(e);
      }}
    >
      {songs.map((song, i) =>
        (song.sections ?? []).map((sec: SectionRow) => {
          const isDragging =
            liveDrag?.songIndex === i && liveDrag?.sectionId === sec.id;
          const startSeconds = isDragging ? liveDrag!.value : sec.startSeconds;
          const left = (songOffsets[i] + startSeconds) * pxPerSec;
          return (
            <div
              key={`${i}:${sec.id}`}
              className="absolute top-0 bottom-0 flex items-center"
              style={{ left, cursor: readOnly ? "default" : "ew-resize" }}
              title={`${sec.name} @ ${formatTimeShort(sec.startSeconds)}${readOnly ? "" : " (drag to move · double-click = cycle · right-click to edit)"}`}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => {
                e.stopPropagation();
                // Second click of a double-click must not start a drag — it
                // would fight the cycle-from-section gesture below.
                if (e.detail >= 2) return;
                beginDrag(e, i, sec.id, sec.startSeconds);
              }}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onDoubleClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                if (readOnly || !onCycleFromSection) return;
                dragMetaRef.current = null;
                setLiveDrag(null);
                const range = sectionRange(i, sec.id);
                if (!range) return;
                onCycleFromSection(i, range.leftSec, range.rightSec);
              }}
              onContextMenu={(e) =>
                openMenuAt(e, { songIndex: i, sectionId: sec.id })
              }
            >
              <div
                className="h-full w-px"
                style={{ background: SECTION_LINE }}
              />
              <div
                className="ml-0.5 truncate rounded px-1 py-0.5 text-[9px] font-medium leading-none"
                style={{
                  background: SECTION_CHIP_BG,
                  color: SECTION_CHIP_FG,
                }}
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
