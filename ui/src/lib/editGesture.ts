/**
 * One undo entry per adjustment, not per pixel of it.
 *
 * The engine collapses consecutive edits that share a `gestureId` into a
 * single history entry (see projectHistoryBeginEdit). Anything that streams
 * values -- a slider, a knob, a drag -- therefore has to carry one, or every
 * frame of the gesture becomes its own entry and the history that mattered is
 * a hundred steps back. That is not a smaller version of undo; it is no undo.
 *
 * A drag has no reliable "end" event at every call site (HeroUI sliders report
 * values, not gestures), so the id rotates on a quiet gap instead: keep
 * writing and it stays the same, stop for IDLE_MS and the next write starts a
 * new entry. A human pausing a third of a second between adjustments means
 * they were two adjustments.
 */

const IDLE_MS = 350;

export interface EditGesture {
  /** The id for a write happening right now. */
  id: () => string;
  /** End the gesture immediately -- for call sites that DO know (pointerup). */
  end: () => void;
}

export function createEditGesture(idleMs = IDLE_MS): EditGesture {
  let current: string | null = null;
  let lastAt = 0;
  return {
    id: () => {
      const now = Date.now();
      if (current === null || now - lastAt > idleMs) current = crypto.randomUUID();
      lastAt = now;
      return current;
    },
    end: () => {
      current = null;
    },
  };
}
