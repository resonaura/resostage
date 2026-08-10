import { useEffect, useRef, useState } from "react";
import { builder } from "../../lib/api";
import {
  beginCancellableDrag,
  type CancellableDrag,
} from "../../lib/dragCancel";
import { triggerHaptic } from "../../lib/haptics";
import type { SectionRow, SongRow } from "../../lib/types";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "../ContextMenu";
import { InlineNamePrompt } from "../InlineNamePrompt";
import { SECTION_LANE_HEIGHT, SECTION_PRESETS } from "./constants";
import {
  crossedDetent,
  songDetents,
  type CycleLocatorsForDetents,
} from "./detents";
import { formatTimeShort, snapToGridSec } from "./geometry";

/** Neutral marker chrome — no per-section accent colours. */
const SECTION_LINE = "rgba(255,255,255,0.22)";
/** Grab slop each side of the 1px marker line. Small enough that two markers a
 *  few pixels apart still address separately, big enough to hit with a mouse. */
const GRAB_SLOP_PX = 3;
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
  cycle,
  getPlayheadAbsoluteSec,
  onCycleFromSection,
}: {
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  contentWidth: number;
  readOnly: boolean;
  snapToGrid?: boolean;
  /** Cycle locators, so a free drag can tick as it passes them. */
  cycle?: CycleLocatorsForDetents | null;
  /**
   * Live absolute project seconds. New markers land here, not at the click.
   * A getter, not a value: while playing, the React mirror can be a commit
   * behind the rAF clock, and a marker that lands a frame off is wrong.
   */
  getPlayheadAbsoluteSec: () => number;
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
    value: number;
    moved: boolean;
  } | null>(null);
  const dragCancelRef = useRef<CancellableDrag | null>(null);
  const dragWindowCleanupRef = useRef<(() => void) | null>(null);
  const detentsRef = useRef<number[]>([]);
  /**
   * Pending "open the type menu" from a plain click.
   *
   * Deferred by the double-click interval on purpose: a double-click on a
   * marker sets the cycle to that section, and firing the menu on the first
   * of the two clicks would make that gesture unreachable. 260ms is below
   * where a menu feels slow and above every double-click that matters.
   */
  const clickMenuTimerRef = useRef<number | null>(null);
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
    // A new marker lands on the PLAYHEAD, not under the cursor: a section
    // boundary is a musical position you have already found by listening, and
    // the menu is opened wherever there happens to be room to click. The menu
    // still opens at the pointer -- only the value it commits comes from the
    // playhead.
    const { songIndex, localSeconds } = resolveSongAt(
      Math.max(0, getPlayheadAbsoluteSec()),
    );
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

  const cancelTypeMenu = () => {
    if (clickMenuTimerRef.current === null) return;
    window.clearTimeout(clickMenuTimerRef.current);
    clickMenuTimerRef.current = null;
  };

  /** Open the preset menu on a marker, unless a double-click beats us to it. */
  const scheduleTypeMenu = (
    clientX: number,
    clientY: number,
    songIndex: number,
    sectionId: string,
  ) => {
    cancelTypeMenu();
    clickMenuTimerRef.current = window.setTimeout(() => {
      clickMenuTimerRef.current = null;
      openMenuAtClient(clientX, clientY, { songIndex, sectionId });
    }, 260);
  };

  const closeMenu = () => {
    cancelTypeMenu();
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
      // Authoritative live value. It must live in the REF, not in `liveDrag`:
      // pointerup can be batched with the last pointermove, in which case the
      // handler still closes over the previous render's `liveDrag` and would
      // commit a position one move behind the cursor.
      value: origStart,
      moved: false,
    };
    // With the magnet off there is no snap to feel, so the tick comes from the
    // song's own landmarks -- the other markers, the region edges, the cycle.
    detentsRef.current = snapToGrid
      ? []
      : songDetents(songs[songIndex], songIndex, {
          cycle,
          songLength: songLengths[songIndex] ?? 0,
          excludeSectionId: sectionId,
        });
    setLiveDrag({ songIndex, sectionId, value: origStart });
    attachDragWindowListeners();
    dragCancelRef.current = beginCancellableDrag(() => finishDrag(null));
    triggerHaptic("generic");
  };

  const processDragMove = (clientX: number) => {
    const meta = dragMetaRef.current;
    if (!meta) return;
    const dx = clientX - meta.startX;
    // A marker is only "moved" once the pointer actually travels; without this
    // every click on a marker committed a sectionUpdate (and a project save)
    // for the value it already had.
    if (!meta.moved && Math.abs(dx) < 2) return;
    meta.moved = true;
    const songLen = songLengths[meta.songIndex] ?? 0;
    const rawValue = Math.max(
      0,
      Math.min(songLen, meta.origStart + dx / pxPerSec),
    );
    const song = songs[meta.songIndex];
    const bpm = song?.bpm ?? 120;
    const tsNum = song?.tsNum ?? 4;
    const prev = meta.value;
    meta.value = snapToGridSec(rawValue, pxPerSec, bpm, tsNum, snapToGrid);
    if (
      snapToGrid
        ? meta.value !== prev
        : crossedDetent(prev, meta.value, detentsRef.current)
    ) {
      triggerHaptic("alignment");
    }
    setLiveDrag({
      songIndex: meta.songIndex,
      sectionId: meta.sectionId,
      value: meta.value,
    });
  };

  /**
   * Window listeners, not handlers on the marker.
   *
   * A marker whose pointerup never arrives keeps its drag session open, and
   * the next pointermove over it moves it again -- the marker follows the
   * cursor long after the mouse was released. Element handlers are exactly
   * that fragile: pointer capture is dropped when the captured element is
   * removed, and this lane rebuilds its markers whenever the song's sections
   * change. The window always gets the release.
   */
  const attachDragWindowListeners = () => {
    dragWindowCleanupRef.current?.();
    const onMove = (e: PointerEvent) => {
      if (!dragMetaRef.current) return;
      e.preventDefault();
      processDragMove(e.clientX);
    };
    const onUp = (e: PointerEvent) => {
      const meta = dragMetaRef.current;
      if (!meta) return;
      processDragMove(e.clientX);
      const clicked = !dragMetaRef.current?.moved;
      const at = { x: e.clientX, y: e.clientY, ...meta };
      finishDrag("commit");
      // A click that never became a drag is a request to retype the marker.
      if (clicked) scheduleTypeMenu(at.x, at.y, at.songIndex, at.sectionId);
    };
    const onCancel = () => finishDrag(null);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    dragWindowCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  };

  /** Single exit for every way a marker drag can end: up, cancel, or Esc. */
  const finishDrag = (commit: "commit" | null) => {
    const meta = dragMetaRef.current;
    dragMetaRef.current = null;
    dragWindowCleanupRef.current?.();
    dragWindowCleanupRef.current = null;
    dragCancelRef.current?.end();
    dragCancelRef.current = null;
    setLiveDrag(null);
    if (!meta) return;
    if (meta.moved) triggerHaptic("generic");
    if (commit !== "commit" || !meta.moved) return;
    void builder.sectionUpdate({
      songIndex: meta.songIndex,
      sectionId: meta.sectionId,
      startSeconds: meta.value,
    });
  };
  // A drag (or a pending menu) must not outlive the lane.
  useEffect(
    () => () => {
      dragWindowCleanupRef.current?.();
      dragWindowCleanupRef.current = null;
      dragMetaRef.current = null;
      dragCancelRef.current?.end();
      dragCancelRef.current = null;
      if (clickMenuTimerRef.current !== null) {
        window.clearTimeout(clickMenuTimerRef.current);
        clickMenuTimerRef.current = null;
      }
    },
    [],
  );

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
            // The outer box spans to the NEXT marker purely so the chip can be
            // clipped and never paint over its neighbour. It must NOT be
            // interactive: when it was, the whole section behaved as a handle
            // for its own left edge (clicking mid-section dragged the line) and
            // right-clicking anywhere in it opened the EDIT menu -- so once one
            // section existed the lane was never "empty" and a second one could
            // not be created at all. Only the visible chrome takes pointers.
            <div
              key={`${i}:${sec.id}`}
              className="pointer-events-none absolute top-0 bottom-0 z-[1] flex items-center overflow-hidden"
              style={{
                // Shifted left by the grab slop and padded back by it, so the
                // line still lands exactly on `left` and the chip still clips
                // where it did.
                left: left - GRAB_SLOP_PX,
                width: Math.max(1, availPx + 1) + GRAB_SLOP_PX,
                paddingLeft: GRAB_SLOP_PX,
              }}
            >
              <div
                className="pointer-events-auto flex h-full items-center"
                style={{
                  cursor: readOnly ? "default" : "ew-resize",
                  // Grabbable slop around a 1px line, without making the marker
                  // look any heavier.
                  marginLeft: -GRAB_SLOP_PX,
                  paddingLeft: GRAB_SLOP_PX,
                  paddingRight: showChip ? 0 : GRAB_SLOP_PX,
                }}
                title={`${sec.name} @ ${formatTimeShort(sec.startSeconds)}${readOnly ? "" : " (drag · double-click = cycle · right-click edit)"}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  emptyPtrRef.current = null; // not an empty-lane click
                  if (e.detail >= 2) return;
                  // Left button only. A right-click armed a drag too, so
                  // opening the context menu counted as picking the marker
                  // up: dismissing the menu committed a move nobody asked
                  // for, and the release also queued the retype menu on top
                  // of the one already open.
                  if (e.button !== 0) return;
                  beginDrag(e, i, sec.id, sec.startSeconds);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  // Beat the pending type menu from the first click, whether
                  // or not the cycle callback is wired.
                  cancelTypeMenu();
                  if (readOnly || !onCycleFromSection) return;
                  finishDrag(null); // the first click armed a drag; drop it
                  const range = sectionRange(i, sec.id);
                  if (!range) return;
                  onCycleFromSection(i, range.leftSec, range.rightSec);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  emptyPtrRef.current = null;
                  cancelTypeMenu();
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

      {menu && renaming && (
        <InlineNamePrompt
          x={menu.x}
          y={menu.y}
          width={176}
          value={nameDraft}
          placeholder="Section name"
          onChange={setNameDraft}
          onCommit={commitCustomName}
          onCancel={closeMenu}
        />
      )}
    </div>
  );
}
