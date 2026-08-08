/**
 * One animation-frame driver for the whole UI.
 *
 * Before this, every live widget owned a private requestAnimationFrame loop:
 * two per meter bar, one per VU needle, one for the shared level ticker, one
 * for the timeline playhead. A mixer with twenty strips meant well over forty
 * independent rAF callbacks per frame -- forty closures, forty timestamp
 * diffs, forty chances for the browser to interleave layout -- to move a
 * handful of pixels. Collapsing them into a single callback keeps exactly the
 * same visual behaviour (each task still gets a real timestamp and its own dt)
 * while the browser only schedules, and we only pay for, ONE frame callback.
 *
 * It also gives the app a single on/off switch. Tasks stop entirely when
 * nothing is on screen and the transport is stopped (see appActivity), and
 * resume on the next frame after the window comes back -- with dt reset, so a
 * meter that was suspended for ten minutes does not decay ten minutes' worth
 * of ballistics in one step.
 *
 * Ordering note: tasks run in registration order, which for the live meters
 * means liveLevels' roll (registered on first telemetry frame) lands before
 * the widgets that read it. Nothing depends on that beyond one frame of
 * latency either way, but it is the desirable order and it is stable.
 */

import { isRenderActive, subscribeRenderActive } from "./appActivity";

/**
 * @param nowMs  performance.now() for this frame -- shared by every task, so
 *               widgets animating together stay in lockstep.
 * @param dtSec  Seconds since this task's previous run, clamped to a sane
 *               ceiling (a tab restored after an hour must not integrate an
 *               hour of decay).
 */
export type RafTask = (nowMs: number, dtSec: number) => void;

/** Longest dt any task will ever be handed, in seconds. */
const MAX_DT = 0.1;
/** dt handed to a task on its first frame, and on the first frame after a resume. */
const NOMINAL_DT = 1 / 60;

interface Entry {
  fn: RafTask;
  lastMs: number;
}

const tasks = new Set<Entry>();
let rafId = 0;

function frame(nowMs: number): void {
  rafId = 0;
  // Snapshot: a task may unsubscribe (or subscribe) from inside its own tick.
  for (const entry of Array.from(tasks)) {
    if (!tasks.has(entry)) continue;
    const prev = entry.lastMs;
    entry.lastMs = nowMs;
    const dt =
      prev > 0 ? Math.min(MAX_DT, Math.max(0, (nowMs - prev) / 1000)) : NOMINAL_DT;
    try {
      entry.fn(nowMs, dt);
    } catch (err) {
      // One misbehaving widget must never take down every other meter on
      // screen with it -- that would be a black console AND a dead mixer.
      console.error("rafLoop task failed", err);
    }
  }
  schedule();
}

function schedule(): void {
  if (rafId || tasks.size === 0 || !isRenderActive()) return;
  rafId = requestAnimationFrame(frame);
}

/** Register a per-frame task. Returns an unsubscribe function. */
export function addRafTask(fn: RafTask): () => void {
  const entry: Entry = { fn, lastMs: 0 };
  tasks.add(entry);
  schedule();
  return () => {
    tasks.delete(entry);
    if (tasks.size === 0 && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}

subscribeRenderActive((active) => {
  if (active) {
    // Fresh dt for everyone: the gap since the last frame is however long the
    // window was hidden, and integrating that would snap every ballistic
    // animation to its target in a single visible jump.
    for (const entry of tasks) entry.lastMs = 0;
    schedule();
    return;
  }
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
});
