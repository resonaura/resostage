import { useRef, useState } from "react";
import { createPortal } from "react-dom";
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
// "from here to the next marker (or song end)". Editor empty-lane click /
// right-click opens create menu; markers: drag, double-click cycle, context edit.

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
  // Empty-lane click detection (pointer, not click — more reliable under
  // parent cursor-col-resize / touch-none scrollports).
  const emptyPtrRef = useRef<{ x: number; y: number } | null>(null);

  const resolveSongAt = (
    absSeconds: number,
  ): { songIndex: number; localSeconds: number } => {
    if (songOffsets.length === 0) return { songIndex: -1, localSeconds: 0 };
    for (let i = 0; i < songOffsets.length; i++) {
      const start = songOffsets[i];
      const end = start + (songLengths[i] ?? 0);
      if (absSeconds < end || i === songOffsets.length - 1)
        return { songIndex: i, localSeconds: Math.max(0, absSeconds - start) };
    }
    return { songIndex: 0, localSeconds: 0 };
  };

  const openMenuAtClient = (
    clientX: number,
    clientY: number,
    existing?: { songIndex: number; sectionId: string },
  ) => {
    if (readOnly) return;
    if (existing) {
      setMenu({
        x: clientX,
        y: clientY,
        songIndex: existing.songIndex,
        startSeconds: 0,
        sectionId: existing.sectionId,
      });
      return;
    }
    const rect = laneRef.current?.getBoundingClientRect();
    // Lane is full contentWidth inside a scroller — rect.left already shifts
    // with scrollLeft (same pattern as seekFromClientX).
    const absSeconds = rect ? Math.max(0, (clientX - rect.left) / pxPerSec) : 0;
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
      x: clientX,
      y: clientY,
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
      className={`relative z-[5] shrink-0 border-b border-default/30 bg-surface/20 touch-none ${
        readOnly ? "" : "cursor-context-menu"
      }`}
      style={{
        height: SECTION_LANE_HEIGHT,
        width: contentWidth,
        // Inline cursor wins over parent scrollport cursor-col-resize.
        cursor: readOnly ? undefined : "context-menu",
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (readOnly) return;
        openMenuAtClient(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        if (readOnly || e.button !== 0) return;
        // Stop the timeline scroller from treating this as a seek/drag start.
        e.stopPropagation();
        emptyPtrRef.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        if (readOnly || e.button !== 0) return;
        const start = emptyPtrRef.current;
        emptyPtrRef.current = null;
        if (!start) return;
        // Pure click (no drag) on empty lane → create menu.
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
        e.stopPropagation();
        openMenuAtClient(e.clientX, e.clientY);
      }}
      onPointerCancel={() => {
        emptyPtrRef.current = null;
      }}
    >
      {songs.map((song, i) => {
        const songLen = songLengths[i] ?? 0;
        // Sort once per song so each chip can size to the gap until the next
        // marker (or song end) — at low zoom chips would otherwise stack.
        const ordered = [...(song.sections ?? [])].sort(
          (a, b) => a.startSeconds - b.startSeconds,
        );
        return ordered.map((sec: SectionRow, si: number) => {
          const isDragging =
            liveDrag?.songIndex === i && liveDrag?.sectionId === sec.id;
          const startSeconds = isDragging ? liveDrag!.value : sec.startSeconds;
          const left = (songOffsets[i] + startSeconds) * pxPerSec;
          const nextStart =
            si + 1 < ordered.length
              ? isDragging && liveDrag!.sectionId === ordered[si + 1].id
                ? liveDrag!.value
                : ordered[si + 1].startSeconds
              : songLen;
          // Room until the next marker (or song end), minus a hair of gap.
          const availPx = Math.max(
            0,
            (nextStart - startSeconds) * pxPerSec - 2,
          );
          // < ~14px: line only (name stays in title tooltip).
          // otherwise: chip capped to the free span so neighbours never overlap.
          const showChip = availPx >= 14;
          const chipMax = Math.max(0, availPx - 3);
          const compact = chipMax < 36;

          return (
            <div
              key={`${i}:${sec.id}`}
              className="absolute top-0 bottom-0 z-[1] flex items-center overflow-hidden"
              style={{
                left,
                // Clip this marker's chrome to its span so it can't paint over
                // the next section even if text wants more room.
                width: Math.max(1, availPx + 1),
                cursor: readOnly ? "default" : "ew-resize",
              }}
              title={`${sec.name} @ ${formatTimeShort(sec.startSeconds)}${readOnly ? "" : " (drag · double-click = cycle · right-click edit)"}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                emptyPtrRef.current = null; // not an empty-lane click
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
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                emptyPtrRef.current = null;
                openMenuAtClient(e.clientX, e.clientY, {
                  songIndex: i,
                  sectionId: sec.id,
                });
              }}
            >
              <div
                className="h-full w-px shrink-0"
                style={{ background: SECTION_LINE }}
              />
              {showChip && (
                <div
                  className="ml-0.5 truncate rounded font-medium leading-none"
                  style={{
                    maxWidth: chipMax,
                    padding: compact ? "1px 3px" : "2px 4px",
                    fontSize: compact ? 8 : 9,
                    background: SECTION_CHIP_BG,
                    color: SECTION_CHIP_FG,
                  }}
                >
                  {sec.name}
                </div>
              )}
            </div>
          );
        });
      })}

      {menu && !renaming && (
        <ContextMenu x={menu.x} y={menu.y} width={168} onClose={closeMenu}>
          {/*
            Items must be direct-enough for ContextMenu's native collector
            (Fragments are flattened). Avoid non-item wrappers as sole children.
          */}
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
          {menu.sectionId ? (
            <>
              <ContextMenuDivider />
              <ContextMenuItem danger onClick={removeMarker}>
                Delete Marker
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenu>
      )}

      {/* Custom name: DOM portal (native menus can't host a text field). */}
      {menu &&
        renaming &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[9998]"
              onClick={closeMenu}
              onContextMenu={(e) => {
                e.preventDefault();
                closeMenu();
              }}
            />
            <form
              className="fixed z-[9999] w-44 rounded-xl border border-default/40 bg-surface/95 p-2 shadow-2xl backdrop-blur-md"
              style={{ left: menu.x, top: menu.y }}
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
          </>,
          document.body,
        )}
    </div>
  );
}
