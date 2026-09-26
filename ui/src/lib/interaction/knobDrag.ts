import { useEffect, useRef, useState } from "react";

import { beginCancellableDrag, type CancellableDrag } from "./dragCancel";
import { triggerHaptic } from "./haptics";

/**
 * Shared drag behaviour for the rotary controls (Knob, SendArcKnob).
 *
 * It lives here rather than in each knob because the two had drifted: the same
 * three isolation holes existed in both copies, and fixing them twice is how
 * they would drift again. The knobs are now presentational -- geometry and
 * paint -- and this owns interaction.
 *
 * The isolation rules, which is what makes turning one knob unable to disturb
 * another:
 *
 *   1. A drag binds to ONE pointerId. Moves from any other pointer are
 *      ignored outright, so a second pointer (touch display, stylus, a mouse
 *      alongside a trackpad) cannot drive a knob that a different pointer
 *      already owns.
 *   2. Only the primary button starts a drag. Right-clicking a send knob is a
 *      real interaction -- it opens the send's context menu -- and it used to
 *      arm a drag as well, so every mouse move while that menu was open kept
 *      writing the send.
 *   3. A move with no buttons held ABORTS the drag instead of applying it.
 *      Without that, a single missed pointerup (released outside the window,
 *      swallowed by a context menu, an Electron blur) left the knob armed
 *      forever, and from then on merely HOVERING over it turned it -- the
 *      "I touched one knob and a different one moved" symptom, since the stuck
 *      knob is not the one under the cursor. Timeline.tsx's scrub already
 *      guards this way; the knobs never got it.
 *
 * Pointer capture is still requested (it keeps the drag alive when the cursor
 * leaves the knob), but correctness does not depend on it: the rules above
 * hold even when the browser refuses or silently drops the capture, which is
 * exactly when the old code broke.
 */

/** What a pointermove should do, given which pointer owns the drag. */
export type KnobMoveGate = "ignore" | "apply" | "abort";

export function gateKnobMove(
  activePointerId: number | null,
  ev: { pointerId: number; buttons: number },
): KnobMoveGate {
  if (activePointerId === null) return "ignore";
  if (ev.pointerId !== activePointerId) return "ignore";
  // Buttons released without us ever seeing the pointerup: the drag is over
  // and must not be resumed by the next stray move.
  if (ev.buttons === 0) return "abort";
  return "apply";
}

/**
 * Vertical drag mapped onto the value range. Up is louder/right, and
 * `sensitivityPx` is how far you travel for the full sweep.
 */
export function knobValueAt({
  startValue,
  startY,
  clientY,
  min,
  max,
  sensitivityPx,
}: {
  startValue: number;
  startY: number;
  clientY: number;
  min: number;
  max: number;
  sensitivityPx: number;
}): number {
  const dy = startY - clientY;
  const next = startValue + (dy / sensitivityPx) * (max - min);
  return Math.max(min, Math.min(max, next));
}

export interface KnobDrag {
  /** Optimistic local value -- what the knob should paint. */
  value: number;
  /** True only between a real pointerdown and its end. */
  dragging: boolean;
  /** Commit immediately, outside any drag (wheel, double-click reset). */
  setValue: (v: number) => void;
  dragProps: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
    onLostPointerCapture: (e: React.PointerEvent<HTMLDivElement>) => void;
  };
}

export function useKnobDrag({
  value,
  min,
  max,
  onCommit,
  round,
  sensitivityPx = 120,
  detent,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  /** Quantisation applied to every value that leaves this hook. */
  round: (v: number) => number;
  sensitivityPx?: number;
  /**
   * One value worth feeling on the way past -- centre for a pan knob.
   *
   * A knob is continuous, so there is nothing else to tick against: ticking
   * per rounded step would buzz, and ticking at the ends says nothing the
   * travel limit does not already say. Centre is different -- it is a value
   * you aim for and cannot see yourself hit while looking at the meters.
   */
  detent?: number;
}): KnobDrag {
  const [localValue, setLocalValue] = useState(() => round(value));
  const [dragging, setDragging] = useState(false);

  const activePointerId = useRef<number | null>(null);
  const startY = useRef(0);
  const startValue = useRef(0);
  const rafId = useRef<number | null>(null);
  const pendingCommit = useRef<number | null>(null);
  const lastEditTime = useRef(0);
  const cancelRef = useRef<CancellableDrag | null>(null);

  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const roundRef = useRef(round);
  roundRef.current = round;

  // Accept the external value only when this knob is idle and its optimistic
  // window has expired -- otherwise a server echo would fight the drag.
  useEffect(() => {
    if (
      activePointerId.current === null &&
      Date.now() - lastEditTime.current > 500
    ) {
      setLocalValue(roundRef.current(value));
    }
  }, [value]);

  // Unmounting mid-drag (a strip or send removed while its knob is held) must
  // not leave an Esc listener behind for a knob that no longer exists.
  useEffect(
    () => () => {
      cancelRef.current?.end();
      cancelRef.current = null;
      if (rafId.current != null) cancelAnimationFrame(rafId.current);
    },
    [],
  );

  /** Coalesce the stream of drag values to one commit per frame. */
  const scheduleCommit = (v: number) => {
    pendingCommit.current = v;
    if (rafId.current != null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      if (pendingCommit.current == null) return;
      onCommitRef.current(pendingCommit.current);
      pendingCommit.current = null;
    });
  };

  const flushPending = () => {
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    if (pendingCommit.current == null) return;
    onCommitRef.current(pendingCommit.current);
    pendingCommit.current = null;
  };

  const disarm = () => {
    activePointerId.current = null;
    setDragging(false);
    lastEditTime.current = Date.now();
    cancelRef.current?.end();
    cancelRef.current = null;
  };

  /**
   * Esc: back to where the drag started. The knob streams commits while you
   * turn it, so the engine is already sitting on the dragged value -- putting
   * `localValue` back alone would leave the two disagreeing. The original has
   * to be committed.
   */
  const revert = () => {
    if (activePointerId.current === null) return;
    const original = startValue.current;
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    pendingCommit.current = null; // whatever was queued is now wrong
    disarm();
    setLocalValue(original);
    onCommitRef.current(original);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    // Disarm unconditionally: an Esc revert already ended the drag, but the
    // pointerup still arrives and the handle must not outlive it.
    const wasActive = activePointerId.current !== null;
    disarm();
    if (wasActive) flushPending();
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already gone */
    }
  };

  return {
    value: localValue,
    dragging,
    setValue: (v: number) => {
      const next = roundRef.current(Math.max(min, Math.min(max, v)));
      lastEditTime.current = Date.now();
      setLocalValue(next);
      onCommitRef.current(next);
    },
    dragProps: {
      onPointerDown: (e) => {
        // Rule 2: right/middle click is not a drag. On a send knob the right
        // button opens the context menu, and arming here meant every move
        // while that menu was open rewrote the send.
        if (e.button !== 0) return;
        // Rule 1: one pointer owns the knob; a second one is not a new drag.
        if (activePointerId.current !== null) return;
        // Keeps a vertical drag from turning into a native text/image drag or
        // a selection sweep across the strip (SendArcKnob has always done
        // this; Knob relied on `select-none` alone).
        e.preventDefault();
        activePointerId.current = e.pointerId;
        setDragging(true);
        lastEditTime.current = Date.now();
        startY.current = e.clientY;
        startValue.current = localValue;
        cancelRef.current?.end();
        cancelRef.current = beginCancellableDrag(revert);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* capture is an optimisation; the pointerId gate is the guarantee */
        }
      },
      onPointerMove: (e) => {
        const gate = gateKnobMove(activePointerId.current, e);
        if (gate === "ignore") return;
        if (gate === "abort") {
          // Rule 3: a pointerup we never saw. Keep what the user dialled in
          // (this is a release, not a cancel) and stop tracking.
          disarm();
          flushPending();
          return;
        }
        lastEditTime.current = Date.now();
        const next = roundRef.current(
          knobValueAt({
            startValue: startValue.current,
            startY: startY.current,
            clientY: e.clientY,
            min,
            max,
            sensitivityPx,
          }),
        );
        if (
          detent !== undefined &&
          Math.min(localValue, next) < detent &&
          detent <= Math.max(localValue, next)
        ) {
          triggerHaptic("alignment");
        }
        setLocalValue(next);
        scheduleCommit(next);
      },
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
    },
  };
}
