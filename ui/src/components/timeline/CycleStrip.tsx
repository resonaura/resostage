import { useRef } from "react";
import { RULER_CYCLE_HEIGHT } from "./constants";
import { snapToGridSec } from "./geometry";
import type { CycleLocators } from "./useCycleState";

type DragMode = "create" | "move" | "resizeL" | "resizeR" | "click";

const EDGE_PX = 6;

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
    if (Math.abs(e.clientX - d.startX) > 3) d.moved = true;
    if (!d.moved && d.mode === "click") return;
    if (!d.moved && d.mode === "create") return;

    const local = snapSec(clientXToLocalSec(e.clientX));

    if (d.mode === "create" || (d.mode === "click" && d.moved)) {
      d.mode = "create";
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
    barBg = "rgba(140, 142, 150, 0.07)";
    handleBg = "rgba(200, 200, 210, 0.22)";
    border = "1px dashed rgba(255,255,255,0.12)";
  } else if (skip) {
    barBg = "rgba(255, 146, 48, 0.12)";
    handleBg = "rgba(255, 146, 48, 0.75)";
    border = "1px solid rgba(255, 146, 48, 0.45)";
    bgImage =
      "repeating-linear-gradient(-45deg, transparent, transparent 3px, rgba(0,0,0,0.3) 3px, rgba(0,0,0,0.3) 5px)";
  } else {
    barBg = "rgba(255, 146, 48, 0.32)";
    handleBg = "rgba(255, 146, 48, 0.8)";
    border = "1px solid transparent";
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute left-0 right-0 top-0 z-20"
      style={{ height: RULER_CYCLE_HEIGHT }}
    >
      {/* Always interactive: create/rebind cycle for THIS song. */}
      <div
        className="pointer-events-auto absolute inset-0 touch-none cursor-default"
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
            transition:
              "background-color 180ms ease, border-color 180ms ease, opacity 180ms ease",
          }}
          onPointerDown={onBarPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          title={
            active
              ? "Cycle: drag · click toggle · ⌥-drag = skip · ⌘-click = invert skip · ⇧-click = snap"
              : "Click to enable cycle · drag to move"
          }
        >
          <div
            className="absolute inset-y-0 left-0 w-1 cursor-ew-resize"
            style={{
              backgroundColor: handleBg,
              transition: "background-color 180ms ease",
            }}
          />
          <div
            className="absolute inset-y-0 right-0 w-1 cursor-ew-resize"
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
