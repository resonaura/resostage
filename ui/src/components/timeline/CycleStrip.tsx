import { useEffect, useRef, useState } from "react";
import { RULER_CYCLE_HEIGHT } from "./constants";
import { snapToGridSec } from "./geometry";
import type { CycleLocators } from "./useCycleState";

type DragMode = "create" | "move" | "resizeL" | "resizeR" | "click";

const EDGE_PX = 6;
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
  } | null>(null);
  // Idle hover cursor on the yellow bar (edges vs body).
  const [barHoverCursor, setBarHoverCursor] = useState("grab");

  useEffect(() => {
    return () => setDragCursor(null);
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
    };
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
      onSetRange(left, right, { activate: true, dragging: true });
    } else if (d.mode === "resizeL") {
      onSetRange(local, d.originRight, { activate: true, dragging: true });
    } else if (d.mode === "resizeR") {
      onSetRange(d.originLeft, local, { activate: true, dragging: true });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragCursor(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    onDragEnd?.();
    if (!d) return;

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
    barBg = "rgba(255, 166, 48, 0.22)";
    handleBg = "rgba(255, 255, 255, 0)";
    border = "1px solid rgba(255, 146, 48, 0.5)";
    bgImage =
      "repeating-linear-gradient(-45deg, transparent, transparent 3px, rgba(0,0,0,0.28) 3px, rgba(0,0,0,0.28) 5px)";
  } else {
    // Translucent fill; bar numbers paint above this layer (Ruler layer="labels").
    barBg = "rgba(255, 166, 48, 0.45)";
    handleBg = "rgba(255, 255, 255, 0)";
    border = "0px solid rgba(255, 180, 72, 0.35)";
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
    </div>
  );
}
