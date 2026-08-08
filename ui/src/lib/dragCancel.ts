/**
 * Esc-cancels an in-progress mouse drag.
 *
 * Every draggable thing in the app -- regions (move and resize), loop
 * locators, section markers, knobs, faders, sliders -- shares one rule: while
 * the pointer is down, Esc puts the value back where the drag started and the
 * drag is over. Doing that per-component means a dozen slightly different
 * keydown listeners, so it lives here once.
 *
 * Why a capture-phase listener with stopImmediatePropagation: Esc is also the
 * universal "close this" key. Dialogs, popovers and context menus listen for it
 * on window/document too, and HeroUI's overlays listen in capture. If the drag
 * did not swallow the event, aborting a knob drag inside a dialog would abort
 * the drag AND close the dialog. Only the innermost active drag reacts.
 */

export interface CancellableDrag {
  /** True once this drag was reverted (Esc, or an explicit cancel()). */
  readonly cancelled: boolean;
  /** Ends the drag normally: detaches the listener. Safe to call twice. */
  end(): void;
  /** Reverts and ends, exactly as Esc would. Safe to call twice. */
  cancel(): void;
}

interface Entry {
  revert: () => void;
  cancelled: boolean;
  done: boolean;
}

/**
 * Innermost drag last. A stack rather than a single slot because a drag can
 * legitimately start while another is live (a knob inside a panel the user is
 * also dragging); Esc must address the one they started most recently.
 */
const stack: Entry[] = [];
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (!top) return;
  // Claim the key before anything else can read it (see file header).
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  revertEntry(top);
}

function revertEntry(entry: Entry) {
  if (entry.done) return;
  entry.cancelled = true;
  finish(entry);
  // After finish(), so a revert that starts a fresh drag (a knob re-arming, a
  // component remounting) cannot find this entry still on the stack.
  entry.revert();
}

function finish(entry: Entry) {
  if (entry.done) return;
  entry.done = true;
  const at = stack.indexOf(entry);
  if (at >= 0) stack.splice(at, 1);
  if (stack.length === 0 && listening) {
    window.removeEventListener("keydown", onKeyDown, true);
    listening = false;
  }
}

/**
 * Call on pointerdown, once the drag's original value has been captured.
 *
 * `revert` must restore that original value AND publish it -- for anything
 * that streams changes to the engine mid-drag (knobs, faders, region moves),
 * restoring only local state would leave the engine on the dragged value.
 *
 * The returned handle must be `end()`ed on pointerup/pointercancel, or the
 * listener outlives the drag and a later Esc reverts something long finished.
 */
export function beginCancellableDrag(revert: () => void): CancellableDrag {
  const entry: Entry = { revert, cancelled: false, done: false };
  stack.push(entry);
  if (!listening) {
    window.addEventListener("keydown", onKeyDown, true);
    listening = true;
  }
  return {
    get cancelled() {
      return entry.cancelled;
    },
    end: () => finish(entry),
    cancel: () => revertEntry(entry),
  };
}

/** Test seam: true while a drag is armed. Not for production logic. */
export function activeDragCount(): number {
  return stack.length;
}
