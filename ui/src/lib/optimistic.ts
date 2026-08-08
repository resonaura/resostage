// Optimistic UI helpers.
//
// Transport playhead model:
//   One continuous ABSOLUTE clock (whole-project seconds). Song-local time is
//   always derived as max(0, absolute - songOffset). Never run two independent
//   rAF clocks (local + global) -- that felt like "two timelines" and fought
//   across gapless song boundaries.

import { useEffect, useRef, useState } from "react";

export const OPTIMISTIC_LOCK_MS = 500;

export function useLiveValue(
  serverValue: number,
  commit: (v: number) => void,
  lockMs = OPTIMISTIC_LOCK_MS,
): [number, (v: number) => void] {
  const [value, setValue] = useState(serverValue);
  const lastLocalEdit = useRef(0);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (Date.now() - lastLocalEdit.current > lockMs) setValue(serverValue);
  }, [serverValue, lockMs]);

  const onChange = (v: number) => {
    lastLocalEdit.current = Date.now();
    setValue(v);
    commitRef.current(v);
  };

  return [value, onChange];
}

/**
 * Focus-aware draft for text / number inputs that commit on every keystroke.
 *
 * Problem: a controlled input with `value={serverProp}` and
 * `onChange={→ server}` creates a feedback loop when editing with a remote
 * client. Each keystroke fires a commit → the server echoes back the new value
 * → React re-renders with the updated prop → the input selection/cursor resets
 * mid-word. Worse: a concurrent remote edit during the same WS tick overwrites
 * what the local user is typing.
 *
 * Solution: keep a local `draft` string in state; sync from `serverValue` only
 * while the input is NOT focused. The `commit` callback (optional) is still
 * called on every change so the server receives updates immediately — we just
 * don't let the echo land back while the field is active.
 *
 * Usage:
 *   const { draft, inputProps } = useFocusDraft(fixture.name, (v) =>
 *     lighting.fixtureUpdate({ fixtureId: fixture.id, name: v }),
 *   );
 *   <input value={draft} {...inputProps} onChange={(e) => { inputProps.onChange(e); }} />
 *
 * Or shorter — spread inputProps directly when no extra onChange logic needed:
 *   <input {...inputProps} />  // includes value, onChange, onFocus, onBlur
 *
 * `fieldProps` is the same draft in the shape HeroUI's (React Aria's) TextField
 * wants -- `onChange` takes the string itself, not a DOM event, and focus is
 * tracked on the inner Input rather than on the field root:
 *   <TextField {...fieldProps}><Input {...fieldProps.focusProps} /></TextField>
 */
export function useFocusDraft(
  serverValue: string,
  commit?: (v: string) => void,
): {
  draft: string;
  setDraft: (v: string) => void;
  focused: boolean;
  inputProps: {
    value: string;
    onFocus: () => void;
    onBlur: () => void;
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  };
  fieldProps: {
    value: string;
    onChange: (v: string) => void;
    focusProps: { onFocus: () => void; onBlur: () => void };
  };
} {
  const [draft, setDraft] = useState(serverValue);
  const [focused, setFocused] = useState(false);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // Sync from server only when not focused.
  if (!focused && draft !== serverValue) {
    setDraft(serverValue);
  }

  const onFocus = () => setFocused(true);
  const onBlur = () => {
    setFocused(false);
    // On blur, sync back to server value in case our last commit was the
    // same as current draft but the server diverged (e.g. validation
    // rejected our value). Calling commit here again is a no-op if value
    // was accepted, and corrects the display if it wasn't.
    if (commitRef.current) commitRef.current(draft);
  };
  const onChangeValue = (v: string) => {
    setDraft(v);
    if (commitRef.current) commitRef.current(v);
  };

  const inputProps = {
    value: draft,
    onFocus,
    onBlur,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChangeValue(e.target.value),
  };

  const fieldProps = {
    value: draft,
    onChange: onChangeValue,
    focusProps: { onFocus, onBlur },
  };

  return { draft, setDraft, focused, inputProps, fieldProps };
}

/**
 * Variant of useFocusDraft for number inputs. Accepts a numeric server value;
 * locally holds the raw string so the user can type "1." mid-way without
 * the browser rounding it. Parses and commits on every change; on blur
 * re-formats from server to stay in sync.
 *
 * Usage:
 *   const { inputProps } = useNumberDraft(fixture.posX, (v) =>
 *     void lighting.fixtureUpdate({ fixtureId: fixture.id, posX: v }),
 *   );
 *   <input type="number" {...inputProps} />
 */
export function useNumberDraft(
  serverValue: number,
  commit?: (v: number) => void,
  toStr: (v: number) => string = String,
): {
  draft: string;
  focused: boolean;
  inputProps: {
    value: string;
    onFocus: () => void;
    onBlur: () => void;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  };
} {
  const [draft, setDraft] = useState(toStr(serverValue));
  const [focused, setFocused] = useState(false);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // Only sync from server when not focused — avoids reset mid-edit.
  const serverStr = toStr(serverValue);
  if (!focused && draft !== serverStr) {
    setDraft(serverStr);
  }

  const inputProps = {
    value: draft,
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      // Re-normalize on blur (removes trailing dots, adjusts to server format).
      setDraft(toStr(serverValue));
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setDraft(raw);
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed) && commitRef.current) {
        commitRef.current(parsed);
      }
    },
  };

  return { draft, focused, inputProps };
}



/**
 * Absolute project-second bounds of an active loop cycle (not skip).
 * Written by Timeline each render; read LIVE by the rAF loop.
 * Playhead outside [loAbs, hiAbs) is intentional and left alone — only
 * crossings of hiAbs from *inside* the zone wrap back to loAbs.
 */
export type CycleWrapRange = {
  loAbs: number;
  hiAbs: number;
};

/** One display frame of the local playhead clock. Pure, so it is testable. */
export interface PlayheadStep {
  /** Where the local clock is now, in absolute project seconds. */
  prevPos: number;
  /** Seconds since the previous frame, already clamped by the caller. */
  dt: number;
  /** Latest position the engine published. */
  serverSeconds: number;
  /** How long ago that engine frame arrived, in seconds. */
  serverAgeSec: number;
  playing: boolean;
  /**
   * True while a just-committed seek still owns the clock. The correction
   * term is skipped: `serverSeconds` is still a pre-seek frame, so measuring
   * error against it would only pull the playhead back toward where the user
   * dragged it FROM.
   */
  seekLocked: boolean;
  cycleWrap?: CycleWrapRange | null;
}

/**
 * Advances the local playhead one frame and soft-corrects toward the engine.
 *
 * Always advances by `dt` -- a seek does not pause the clock, it relocates it.
 * Freezing the advance during the seek lock is what made the playhead sit dead
 * still for up to 800 ms after a committed drag before suddenly taking off.
 */
export function advancePlayhead(step: PlayheadStep): number {
  const { prevPos, dt, serverSeconds, serverAgeSec, playing, seekLocked } = step;

  const targetServer = serverSeconds + (playing ? Math.max(0, serverAgeSec) : 0);
  const err = targetServer - prevPos;

  // Bounded speed correction (max ±5% speed variation) to filter jitter and
  // prevent overshoots/jumps.
  const maxAdjust = 0.05 * dt;
  const adjust = seekLocked
    ? 0
    : Math.max(-maxAdjust, Math.min(maxAdjust, err * 2.0 * dt));

  let next = prevPos + dt + adjust;
  if (next < 0) next = 0;

  // Local cycle wrap (display parity with AudioEngine). Only when the needle
  // was *inside* the loop and crosses the right locator -- a playhead sitting
  // before/after the cycle is intentional and stays.
  const wrap = step.cycleWrap;
  if (wrap) {
    const span = wrap.hiAbs - wrap.loAbs;
    if (
      span >= 0.05 &&
      prevPos >= wrap.loAbs &&
      prevPos < wrap.hiAbs &&
      next >= wrap.hiAbs
    ) {
      // Carry overshoot so multi-frame skips on tiny cycles stay accurate.
      next = wrap.loAbs + (next - wrap.hiAbs);
      if (next >= wrap.hiAbs) {
        next = wrap.loAbs + ((next - wrap.loAbs) % span);
      }
      if (next < wrap.loAbs) next = wrap.loAbs;
    }
  }

  return next;
}

/**
 * Single continuous project playhead.
 *
 * - Advances at ~60fps while `playing` (does not wait for ~30Hz WS frames).
 * - Soft-corrects toward `serverAbsoluteSeconds`.
 * - `resetKey` should be the project identity only -- NOT songIndex -- so a
 *   gapless song change does not zero/reset the clock.
 * - `seekAbsolute(sec)` snaps immediately (scrub) and locks briefly.
 * - `frozen` (e.g. while a zoom gesture is active) stops the clock dead in
 *   its tracks so the playhead marker holds still; it resumes cleanly the
 *   moment `frozen` drops and re-corrects toward the engine.
 * - `draggingRef` (optional): read LIVE, not as a dependency -- a ref so the
 *   caller can flip it synchronously in a pointer handler without waiting
 *   for a React render, same reasoning as Timeline.tsx's own
 *   gestureActiveNowRef. While true, ALL server reconciliation is inert:
 *   the caller owns the absolute value entirely (via seekAbsolute on every
 *   pointermove) and nothing here may second-guess it. This used to be
 *   approximated by a "release the lock early if the server value already
 *   looks close" heuristic, which was the actual bug behind a dropped drag
 *   silently snapping back -- while playing, the live (not-yet-seeked)
 *   transport keeps advancing on its own, so it routinely drifts to within
 *   the old 0.35s proximity threshold of wherever the user is mid-drag
 *   purely by coincidence, which isn't the same as "the seek landed".
 * - `cycleWrapRef` (optional): when set to an active loop range, the local
 *   clock wraps at the right locator *only if* it was already inside the
 *   zone (matches AudioEngine; playhead outside the cycle is left alone).
 *   Needed because short cycles (<0.5s) never trip the hard server snap.
 */
export function useContinuousPlayhead(
  serverAbsoluteSeconds: number,
  playing: boolean,
  resetKey?: unknown,
  frozen = false,
  draggingRef?: { current: boolean },
  cycleWrapRef?: { current: CycleWrapRange | null },
  /**
   * Whether the clock is mirrored into React state.
   *
   * A caller that DISPLAYS the time (the Player's big clock) needs the mirror
   * -- that is what re-renders the readout sixty times a second. A caller that
   * only paints imperatively needs no such thing: Timeline moves its playhead
   * marker by writing `style.left` straight to the DOM from its own frame loop
   * (see the long note at that loop) and reads the clock through
   * `getLiveAbsolute`, so the state mirror was re-rendering the entire
   * arrangement -- every lane, every region, every cue -- once per frame for a
   * value nothing in the returned JSX actually reads.
   *
   * With the mirror off, the returned `absoluteSeconds` is read live at render
   * time instead of at commit time, so it stays correct for the render that
   * asks for it; it simply stops being a reason TO render.
   */
  publishToReact = true,
): [
  absoluteSeconds: number,
  seekAbsolute: (v: number, lockMs?: number) => void,
  /** Live read of the clock without waiting for a React commit (rAF loops). */
  getLiveAbsolute: () => number,
] {
  const [absolute, setAbsoluteState] = useState(serverAbsoluteSeconds);
  const publishRef = useRef(publishToReact);
  publishRef.current = publishToReact;
  // Every write below goes through here, so "don't mirror into React" is one
  // decision in one place rather than a condition at each of the six sites
  // that move the clock.
  const setAbsolute = useRef((v: number) => {
    if (publishRef.current) setAbsoluteState(v);
  }).current;
  const localRef = useRef(serverAbsoluteSeconds);
  const serverRef = useRef(serverAbsoluteSeconds);
  const playingRef = useRef(playing);
  const prevKey = useRef(resetKey);
  const lastSeekAt = useRef(0);
  const lastFrameTs = useRef<number | null>(null);
  // Held for a short, FIXED window after a committed seek -- long enough to
  // outlast a busy native seek plus one WS telemetry turn without a stale
  // pre-seek frame visibly undoing the drop, but with no proximity-based
  // early release (see the dragging-related bug this replaced above).
  const SEEK_LOCK_MS = 500;

  const lastServerRxAt = useRef(Date.now());

  // Synchronously update server references whenever new prop arrives (never race with useEffect!)
  if (serverRef.current !== serverAbsoluteSeconds) {
    serverRef.current = serverAbsoluteSeconds;
    lastServerRxAt.current = Date.now();
  }
  playingRef.current = playing;

  // Project change only -- hard snap.
  useEffect(() => {
    if (prevKey.current !== resetKey) {
      prevKey.current = resetKey;
      lastSeekAt.current = 0;
      localRef.current = serverAbsoluteSeconds;
      setAbsolute(serverAbsoluteSeconds);
      lastFrameTs.current = null;
      lastServerRxAt.current = Date.now();
    }
  }, [resetKey, serverAbsoluteSeconds, setAbsolute]);

  // Server snapshots.
  useEffect(() => {
    // While frozen (zoom gesture) or actively dragging the playhead, don't
    // let server corrections yank the clock -- it must stand still
    // ("автостоп времени при зуме") or stay exactly where the user dropped
    // it, unconditionally, for the whole gesture. Both resume cleanly once
    // the flag drops: frozen re-corrects on its own next tick, dragging
    // hands off to the fixed post-commit lock below.
    if (frozen || draggingRef?.current) return;
    const seekLocked = Date.now() - lastSeekAt.current <= SEEK_LOCK_MS;
    if (seekLocked) return;
    if (!playingRef.current) {
      localRef.current = serverAbsoluteSeconds;
      setAbsolute(serverAbsoluteSeconds);
      lastFrameTs.current = null;
      return;
    }
    const delta = serverAbsoluteSeconds - localRef.current;
    // Large discontinuity (seek/stall/project reopen), OR a backward jump
    // while playing (cycle wrap is often << 0.5s for a single beat, so the
    // old 0.5s threshold never fired and the SPA needle kept walking past
    // the right locator until soft-correct slowly crawled back).
    if (Math.abs(delta) > 0.5 || delta < -0.06) {
      localRef.current = serverAbsoluteSeconds;
      setAbsolute(serverAbsoluteSeconds);
      lastFrameTs.current = null;
    }
  }, [serverAbsoluteSeconds, frozen, draggingRef, setAbsolute]);

  // rAF advance while playing.
  useEffect(() => {
    if (!playing || frozen) {
      // Frozen (zoom): hold the last value, and reset the frame timestamp so
      // resuming starts a fresh dt (no jump).
      lastFrameTs.current = null;
      return;
    }
    let raf = 0;
    const tick = (ts: number) => {
      const prev = lastFrameTs.current;
      lastFrameTs.current = ts;
      // The seek lock deliberately does NOT gate this advance. seekAbsolute
      // has already put localRef exactly where the user dropped the playhead,
      // and that value is authoritative -- so the clock must start running
      // from it immediately. Gating the advance too is what made the playhead
      // sit dead still for the whole lock window (800 ms on a committed drag,
      // see Timeline's setPlayheadAbsoluteSec call) before suddenly taking
      // off. What the lock is actually for is the stale pre-seek server frame,
      // and that is handled by ignoring the correction term below and by the
      // server-snapshot effect above.
      if (prev != null && !draggingRef?.current) {
        const next = advancePlayhead({
          prevPos: localRef.current,
          dt: Math.min(0.08, Math.max(0, (ts - prev) / 1000)),
          serverSeconds: serverRef.current,
          serverAgeSec: (Date.now() - lastServerRxAt.current) / 1000,
          playing: playingRef.current,
          seekLocked: Date.now() - lastSeekAt.current <= SEEK_LOCK_MS,
          cycleWrap: cycleWrapRef?.current,
        });

        localRef.current = next;
        setAbsolute(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frozen, resetKey, draggingRef, cycleWrapRef, setAbsolute]);

  const seekAbsolute = (v: number, lockMs = SEEK_LOCK_MS) => {
    const clamped = Math.max(0, v);
    // A released scrub must remain authoritative until the engine has had a
    // chance to restage and publish its new transport position. Callers use
    // the default for a live drag and may request a longer window only for
    // its final committed position.
    lastSeekAt.current = Date.now() + Math.max(0, lockMs - SEEK_LOCK_MS);
    localRef.current = clamped;
    setAbsolute(clamped);
    lastFrameTs.current = null;
  };

  // Stable identity: always reads the same ref the rAF loop writes. Timeline
  // follow/marker rAF loops use this so they never lag a React commit behind
  // the live clock (setState every frame is not guaranteed to commit every
  // display frame, which made smooth-follow scroll in discrete steps).
  const getLiveAbsolute = useRef(() => localRef.current).current;

  return [
    publishToReact ? absolute : localRef.current,
    seekAbsolute,
    getLiveAbsolute,
  ];
}
