import { useRef } from "react";
import { beginCancellableDrag, type CancellableDrag } from "../../lib/dragCancel";
import { RULER_HEIGHT } from "./constants";

/**
 * The draggable end of a song.
 *
 * Logic has one of these per project; a setlist has one per song, because each
 * song is its own stretch of the arrangement and the next one starts where
 * this one stops. Dragging it is the only way to make a song longer than its
 * content -- room to write into -- and the only way an EMPTY song has a length
 * at all, which is what made a blank timeline impossible to work in.
 *
 * Dragging left past the content is allowed on purpose. It does not delete
 * anything: the tail simply falls outside the song, which the arrangement
 * shows as out of bounds. Deleting audio is a destructive act and must be one
 * the user asks for explicitly, not a side effect of a drag.
 */

/** Hit area either side of the line, in px. The line itself is 1px. */
const GRAB_HALF_WIDTH = 5;

export interface SongEndDrag {
  index: number;
  seconds: number;
}

export function SongEndMarker({
  songIndex,
  /** Absolute project seconds where this song currently ends. */
  endAbsSec,
  /** Absolute project seconds this song starts at. */
  startAbsSec,
  /** How far the content reaches, in song-local seconds (0 when empty). */
  contentSec,
  pxPerSec,
  dragging,
  snapSec,
  onDrag,
  onDragEnd,
}: {
  songIndex: number;
  endAbsSec: number;
  startAbsSec: number;
  contentSec: number;
  pxPerSec: number;
  dragging: boolean;
  /** Grid step in seconds, or 0 for free movement. */
  snapSec: number;
  onDrag: (drag: SongEndDrag) => void;
  onDragEnd: (drag: SongEndDrag | null) => void;
}) {
  const pointerRef = useRef<number | null>(null);
  const cancelRef = useRef<CancellableDrag | null>(null);
  const startedAtRef = useRef(0);

  const secondsAt = (clientX: number, el: HTMLElement): number => {
    const rulerRect = el.parentElement?.getBoundingClientRect();
    if (!rulerRect) return endAbsSec;
    const abs = (clientX - rulerRect.left) / pxPerSec;
    const local = abs - startAbsSec;
    const snapped =
      snapSec > 0 ? Math.round(local / snapSec) * snapSec : local;
    // A song shorter than a second is not something to aim at with a pointer.
    return Math.max(0.25, snapped);
  };

  const end = (commit: boolean, seconds: number) => {
    pointerRef.current = null;
    cancelRef.current?.end();
    cancelRef.current = null;
    onDragEnd(commit ? { index: songIndex, seconds } : null);
  };

  const left = Math.round(endAbsSec * pxPerSec);
  const overContent = contentSec > 0 && endAbsSec - startAbsSec < contentSec;

  return (
    <div
      className="absolute z-[45] touch-none"
      style={{
        left: left - GRAB_HALF_WIDTH,
        top: 0,
        width: GRAB_HALF_WIDTH * 2,
        height: RULER_HEIGHT,
        cursor: "col-resize",
      }}
      title={
        overContent
          ? "Song end — content past here is out of bounds. Drag to resize."
          : "Song end — drag to resize"
      }
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        pointerRef.current = e.pointerId;
        startedAtRef.current = endAbsSec - startAbsSec;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* the pointerId gate below is the real guarantee */
        }
        // Esc puts the song back to the length it had when the drag began.
        cancelRef.current?.end();
        cancelRef.current = beginCancellableDrag(() => {
          const original = startedAtRef.current;
          pointerRef.current = null;
          cancelRef.current = null;
          onDragEnd({ index: songIndex, seconds: original });
        });
        onDrag({ index: songIndex, seconds: startedAtRef.current });
      }}
      onPointerMove={(e) => {
        if (pointerRef.current !== e.pointerId) return;
        // A move with no button held is a pointerup we never saw; keep what
        // the user dialled in rather than tracking the cursor forever.
        if (e.buttons === 0) {
          end(true, secondsAt(e.clientX, e.currentTarget));
          return;
        }
        onDrag({
          index: songIndex,
          seconds: secondsAt(e.clientX, e.currentTarget),
        });
      }}
      onPointerUp={(e) => {
        if (pointerRef.current !== e.pointerId) return;
        end(true, secondsAt(e.clientX, e.currentTarget));
      }}
      onPointerCancel={() => {
        if (pointerRef.current === null) return;
        end(false, 0);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // Back to "as long as its content" -- the reset, without a second
        // control to explain.
        onDragEnd({ index: songIndex, seconds: 0 });
      }}
    >
      {/* The line. Highlighted while dragging so it reads as the thing being
          moved rather than as one more boundary in a row of songs. */}
      <div
        className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 transition-colors"
        style={{
          width: dragging ? 2 : 1,
          backgroundColor: dragging
            ? "var(--accent)"
            : "color-mix(in oklab, var(--foreground) 45%, transparent)",
          boxShadow: dragging
            ? "0 0 6px color-mix(in oklab, var(--accent) 70%, transparent)"
            : undefined,
        }}
      />
      {/* Flag, so the boundary is grabbable by something visible rather than
          by a 1px line the pointer has to find. */}
      <div
        className="pointer-events-none absolute left-1/2 top-0 -translate-x-full"
        style={{
          width: 0,
          height: 0,
          borderTop: `7px solid ${
            dragging
              ? "var(--accent)"
              : "color-mix(in oklab, var(--foreground) 45%, transparent)"
          }`,
          borderLeft: "6px solid transparent",
        }}
      />
    </div>
  );
}
