import { useEffect, useRef, useState } from "react";

import {
  beginCancellableDrag,
  type CancellableDrag,
} from "../../lib/dragCancel";
import { triggerHaptic } from "../../lib/haptics";
import type { SongRow } from "../../lib/types";
import { RULER_CYCLE_HEIGHT } from "./constants";
import { crossedDetent, songDetents } from "./detents";
import { snapToGridSec } from "./geometry";
import type { CycleLocators } from "./useCycleState";

type DragMode = "create" | "move" | "resizeL" | "resizeR" | "click";

const EDGE_PX = 6;
/**
 * Half-width of a locator's grab zone, in px.
 *
 * Wider than EDGE_PX because this one is not a hit test inside the bar -- it
 * is a real element centred on the locator, and half of it hangs outside the
 * cycle where a miss used to mean "create a new one".
 */
const HANDLE_HALF_PX = 7;

/**
 * The cycle's own colour, at a given opacity.
 *
 * `color-mix` rather than a resolved hex: the zone then follows a live theme
 * switch with no JS involved, which the hardcoded orange it replaces could
 * not do. The percentages are the alphas the strip has always used.
 */
function warningAlpha(alpha: number): string {
  return `color-mix(in oklab, var(--warning) ${alpha * 100}%, transparent)`;
}
const DRAG_ATTR = "data-cycle-drag";
const DRAG_VAR = "--cycle-drag-cursor";
const STYLE_ID = "resostage-cycle-drag-cursor";

/**
 * Force cursor on the whole document while dragging. Setting body alone is
 * not enough: the hit target (and Timeline's cursor-col-resize ancestors)
 * keep their own cursor and win the cascade. Attribute + `* { cursor: var()
 * !important }` overrides every descendant for the drag lifetime.
 */
function ensureDragCursorStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
    html[${DRAG_ATTR}],
    html[${DRAG_ATTR}] * {
      cursor: var(${DRAG_VAR}) !important;
    }
  `;
  document.head.appendChild(el);
}

function setDragCursor(cursor: string | null) {
  ensureDragCursorStyle();
  const html = document.documentElement;
  if (cursor) {
    html.style.setProperty(DRAG_VAR, cursor);
    html.setAttribute(DRAG_ATTR, "1");
  } else {
    html.removeAttribute(DRAG_ATTR);
    html.style.removeProperty(DRAG_VAR);
  }
}

function cursorForMode(mode: DragMode): string {
  if (mode === "resizeL" || mode === "resizeR" || mode === "create")
    return "ew-resize";
  return "grabbing";
}

/**
 * Logic-style cycle zone — UPPER bar-ruler tier only.
 *
 * Mounted on EVERY song segment: drag empty space here rebinds the single
 * project cycle to THIS song (loop still cannot span two songs). The yellow
 * bar only paints when `ownsCycle` (this song is cycle.songIndex).
 */
export function CycleStrip({
  song,
  songIndex,
  songLength,
  pxPerSec,
  cycle,
  /** True when the project cycle belongs to this song segment. */
  ownsCycle,
  bpm = 120,
  tsNum = 4,
  snapToGrid = false,
  onToggleActive,
  onSetRange,
  onToggleSkip,
  onDragEnd,
}: {
  /** The song this strip sits over -- its content is what a free drag ticks against. */
  song?: SongRow;
  songIndex: number;
  songLength: number;
  pxPerSec: number;
  cycle: CycleLocators;
  ownsCycle: boolean;
  bpm?: number;
  tsNum?: number;
  snapToGrid?: boolean;
  onToggleActive: () => void;
  onSetRange: (
    leftSec: number,
    rightSec: number,
    opts?: {
      activate?: boolean;
      skip?: boolean;
      dragging?: boolean;
      songIndex?: number;
    },
  ) => void;
  onToggleSkip: () => void;
  onDragEnd?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    originLeft: number;
    originRight: number;
    anchorSec: number;
    moved: boolean;
    option: boolean;
    /** Cycle state as it was at pointerdown -- what Esc restores. */
    originActive: boolean;
    originSkip: boolean;
    originHadRange: boolean;
    /** Last locator pair this drag emitted -- what the next tick compares to. */
    lastLeft: number;
    lastRight: number;
  } | null>(null);
  const dragCancelRef = useRef<CancellableDrag | null>(null);
  /** Landmarks for a free drag; see detents.ts. Frozen when the drag starts. */
  const detentsRef = useRef<number[]>([]);
  // Idle hover cursor on the yellow bar (edges vs body).
  const [barHoverCursor, setBarHoverCursor] = useState("grab");

  useEffect(() => {
    return () => {
      setDragCursor(null);
      dragCancelRef.current?.end();
      dragCancelRef.current = null;
    };
  }, []);

  const lo = Math.min(cycle.leftSec, cycle.rightSec);
  const hi = Math.max(cycle.leftSec, cycle.rightSec);
  const leftPx = lo * pxPerSec;
  const widthPx = Math.max(2, (hi - lo) * pxPerSec);
  const hasRange = hi - lo > 0.05;
  // Bar only on the song that owns the zone (never drawn across songs).
  const showBar = ownsCycle && hasRange;

  const clientXToLocalSec = (clientX: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.min(songLength, (clientX - rect.left) / pxPerSec));
  };

  const snapSec = (sec: number) =>
    snapToGridSec(sec, pxPerSec, bpm, tsNum, snapToGrid);

  const barCursorAt = (clientX: number) => {
    const local = clientXToLocalSec(clientX);
    const xInSong = local * pxPerSec;
    const leftEdge = lo * pxPerSec;
    const rightEdge = hi * pxPerSec;
    if (Math.abs(xInSong - leftEdge) <= EDGE_PX) return "ew-resize";
    if (Math.abs(xInSong - rightEdge) <= EDGE_PX) return "ew-resize";
    return cycle.active ? "grab" : "pointer";
  };

  const beginDrag = (
    e: React.PointerEvent,
    mode: DragMode,
    opts?: { anchorSec?: number },
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const local = opts?.anchorSec ?? clientXToLocalSec(e.clientX);
    dragRef.current = {
      mode,
      startX: e.clientX,
      originLeft: lo,
      originRight: hi,
      anchorSec: local,
      moved: false,
      option: e.altKey,
      originActive: cycle.active,
      originSkip: cycle.skip,
      originHadRange: hasRange,
      lastLeft: lo,
      lastRight: hi,
    };
    // A locator dragged with the magnet off still passes things worth feeling
    // -- region edges, section markers, the end of the song.
    detentsRef.current = snapToGrid
      ? []
      : songDetents(song, songIndex, { songLength });
    triggerHaptic("generic");
    dragCancelRef.current?.end();
    dragCancelRef.current = beginCancellableDrag(cancelDrag);
    // click / create wait for a few px of motion before locking the cursor;
    // move / resize show the drag cursor immediately.
    if (mode === "move" || mode === "resizeL" || mode === "resizeR") {
      setDragCursor(cursorForMode(mode));
    }
  };

  const onBarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !ownsCycle) return;
    const local = clientXToLocalSec(e.clientX);
    const xInSong = local * pxPerSec;
    const leftEdge = lo * pxPerSec;
    const rightEdge = hi * pxPerSec;

    if (e.shiftKey && hasRange) {
      e.stopPropagation();
      e.preventDefault();
      const snapped = snapSec(local);
      const distL = Math.abs(local - lo);
      const distR = Math.abs(local - hi);
      const moveLeft = e.altKey ? distL >= distR : distL <= distR;
      if (moveLeft) onSetRange(snapped, hi, { activate: true });
      else onSetRange(lo, snapped, { activate: true });
      dragRef.current = null;
      return;
    }

    if (e.metaKey && cycle.active && hasRange) {
      e.stopPropagation();
      e.preventDefault();
      onToggleSkip();
      dragRef.current = null;
      return;
    }

    let mode: DragMode = "move";
    if (Math.abs(xInSong - leftEdge) <= EDGE_PX) mode = "resizeL";
    else if (Math.abs(xInSong - rightEdge) <= EDGE_PX) mode = "resizeR";
    else if (cycle.active) mode = "move";
    else mode = "click";

    beginDrag(e, mode, { anchorSec: local });
  };

  /** Empty upper tier on ANY song: drag creates / rebinds the project cycle. */
  const onEmptyPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    beginDrag(e, "create", {
      anchorSec: snapSec(clientXToLocalSec(e.clientX)),
    });
  };

  /**
   * Tick for a locator pair that just moved, and remember where it landed.
   *
   * With the magnet on every emitted change is a detent; with it off only a
   * crossing counts, or a free drag buzzes for its whole length.
   */
  const tickLocators = (
    d: NonNullable<typeof dragRef.current>,
    left: number,
    right: number,
  ) => {
    const moved = snapToGrid
      ? left !== d.lastLeft || right !== d.lastRight
      : crossedDetent(d.lastLeft, left, detentsRef.current) ||
        crossedDetent(d.lastRight, right, detentsRef.current);
    d.lastLeft = left;
    d.lastRight = right;
    if (moved) triggerHaptic("alignment");
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.startX) > 3) {
      if (!d.moved) {
        d.moved = true;
        if (d.mode === "click") d.mode = "create";
        setDragCursor(cursorForMode(d.mode));
      }
    }
    if (!d.moved && d.mode === "click") return;
    if (!d.moved && d.mode === "create") return;

    const local = snapSec(clientXToLocalSec(e.clientX));

    if (d.mode === "create") {
      tickLocators(d, d.anchorSec, local);
      onSetRange(d.anchorSec, local, {
        activate: true,
        skip: d.option,
        dragging: true,
      });
    } else if (d.mode === "move") {
      const span = d.originRight - d.originLeft;
      const rawLeft = d.originLeft + (e.clientX - d.startX) / pxPerSec;
      let left = snapToGrid ? snapSec(rawLeft) : rawLeft;
      let right = left + span;
      if (left < 0) {
        left = 0;
        right = span;
      }
      if (right > songLength) {
        right = songLength;
        left = Math.max(0, songLength - span);
      }
      tickLocators(d, left, right);
      onSetRange(left, right, { activate: true, dragging: true });
    } else if (d.mode === "resizeL") {
      tickLocators(d, local, d.originRight);
      onSetRange(local, d.originRight, { activate: true, dragging: true });
    } else if (d.mode === "resizeR") {
      tickLocators(d, d.originLeft, local);
      onSetRange(d.originLeft, local, { activate: true, dragging: true });
    }
  };

  /**
   * Esc: put the locators back exactly where the drag found them.
   *
   * `dragging: true` keeps the revert LOCAL, the same as every move in this
   * gesture did -- useCycleState only POSTs on commitDrag, so the engine still
   * holds the original range and re-sending it would be a wasted round trip
   * (and a second one, since onDragEnd below commits too). Restoring the local
   * state and letting the normal commit path close the gesture is both cheaper
   * and keeps useCycleState's draggingRef state machine honest.
   *
   * `create` on a song with no cycle yet is the one case with nothing to
   * restore: the drag invented the range, so cancelling deactivates instead.
   */
  const cancelDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragCursor(null);
    dragCancelRef.current?.end();
    dragCancelRef.current = null;
    if (!d) return;
    if (d.moved) {
      onSetRange(d.originLeft, d.originRight, {
        activate: d.originHadRange && d.originActive,
        skip: d.originSkip,
        dragging: true,
      });
    }
    onDragEnd?.();
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragCursor(null);
    dragCancelRef.current?.end();
    dragCancelRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    onDragEnd?.();
    if (!d) return;
    if (d.moved) triggerHaptic("generic");

    if (!d.moved) {
      if (d.mode === "create") return;
      onToggleActive();
    }
  };

  const active = cycle.active;
  const skip = cycle.skip;

  let barBg: string;
  let handleBg: string;
  let border: string | undefined;
  let bgImage: string | undefined;
  if (!active) {
    barBg = "rgba(255, 255, 255, 0.05)";
    handleBg = "rgba(255, 255, 255, 0)";
    border = "0px dashed rgba(255,255,255,0.18)";
  } else if (skip) {
    barBg = warningAlpha(0.22);
    handleBg = "rgba(255, 255, 255, 0)";
    border = `1px solid ${warningAlpha(0.5)}`;
    bgImage =
      "repeating-linear-gradient(-45deg, transparent, transparent 3px, rgba(0,0,0,0.28) 3px, rgba(0,0,0,0.28) 5px)";
  } else {
    // Translucent fill; bar numbers paint above this layer (Ruler layer="labels").
    barBg = warningAlpha(0.45);
    handleBg = "rgba(255, 255, 255, 0)";
    border = `0px solid ${warningAlpha(0.35)}`;
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute left-0 right-0 top-0 z-20"
      style={{ height: RULER_CYCLE_HEIGHT }}
    >
      {/* Always interactive: create/rebind cycle for THIS song. */}
      <div
        className="pointer-events-auto absolute inset-0 touch-none cursor-ew-resize"
        onPointerDown={onEmptyPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="Drag to set cycle on this song"
      />

      {showBar && (
        <div
          className="pointer-events-auto absolute inset-y-0 touch-none"
          style={{
            left: leftPx,
            width: widthPx,
            backgroundColor: barBg,
            backgroundImage: bgImage,
            border,
            boxSizing: "border-box",
            cursor: barHoverCursor,
            transition:
              "background-color 180ms ease, border-color 180ms ease, opacity 180ms ease",
          }}
          onPointerDown={onBarPointerDown}
          onPointerMove={(e) => {
            if (!dragRef.current) {
              setBarHoverCursor(barCursorAt(e.clientX));
            }
            onPointerMove(e);
          }}
          onPointerLeave={() => {
            if (!dragRef.current)
              setBarHoverCursor(active ? "grab" : "pointer");
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          title={
            active
              ? "Cycle: drag · click toggle · ⌥-drag = skip · ⌘-click = invert skip · ⇧-click = snap"
              : "Click to enable cycle · drag to move"
          }
        >
          <div
            className="absolute inset-y-0 left-0 w-1"
            style={{
              backgroundColor: handleBg,
              transition: "background-color 180ms ease",
            }}
          />
          <div
            className="absolute inset-y-0 right-0 w-1"
            style={{
              backgroundColor: handleBg,
              transition: "background-color 180ms ease",
            }}
          />
        </div>
      )}

      {/*
        Grab zones straddling each locator.
        They reach OUTSIDE the zone as well as into it, which the in-bar edge
        test could not: a locator sits on the boundary between "resize" and
        "empty strip", and every pixel on the outside used to start a brand
        new cycle instead. Landing on the wrong side of a 1px line and
        destroying the loop you meant to stretch is the whole complaint.
        Rendered after the bar so they take the pointer first; everything
        past them is still empty strip, so creating a cycle by dragging is
        untouched.
      */}
      {showBar &&
        (
          [
            ["resizeL", leftPx],
            ["resizeR", leftPx + widthPx],
          ] as const
        ).map(([mode, atPx]) => (
          <div
            key={mode}
            className="pointer-events-auto absolute inset-y-0 touch-none cursor-ew-resize"
            style={{
              // Never let the two meet in the middle of a short zone -- the
              // one drawn second would own the other's half of it.
              left: atPx - HANDLE_HALF_PX,
              width: HANDLE_HALF_PX + Math.min(HANDLE_HALF_PX, widthPx / 2),
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || !ownsCycle) return;
              beginDrag(e, mode);
            }}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            title="Drag to resize the cycle"
          />
        ))}
    </div>
  );
}
