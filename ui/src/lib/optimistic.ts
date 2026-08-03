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
 */
export function useContinuousPlayhead(
  serverAbsoluteSeconds: number,
  playing: boolean,
  resetKey?: unknown,
  frozen = false,
  draggingRef?: { current: boolean },
): [absoluteSeconds: number, seekAbsolute: (v: number, lockMs?: number) => void] {
  const [absolute, setAbsolute] = useState(serverAbsoluteSeconds);
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
  // Stronger pull than before so we stay glued to the engine without
  // looking like a second free-running timeline.
  const CORRECT_PER_SEC = 8;

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
  }, [resetKey, serverAbsoluteSeconds]);

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
    // Hard snap only on large discontinuities (seek we missed, stall, jump, project re-open).
    if (Math.abs(serverAbsoluteSeconds - localRef.current) > 0.5) {
      localRef.current = serverAbsoluteSeconds;
      setAbsolute(serverAbsoluteSeconds);
      lastFrameTs.current = null;
    }
  }, [serverAbsoluteSeconds, frozen, draggingRef]);

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
      if (prev != null && !draggingRef?.current && Date.now() - lastSeekAt.current > SEEK_LOCK_MS) {
        const dt = Math.min(0.08, Math.max(0, (ts - prev) / 1000));
        // Extrapolate expected server time considering elapsed time since packet arrival
        const serverAge = Math.max(0, (Date.now() - lastServerRxAt.current) / 1000);
        const targetServer = serverRef.current + (playingRef.current ? serverAge : 0);
        const err = targetServer - localRef.current;

        // Bounded speed correction (max ±5% speed variation) to filter jitter & prevent overshoots/jumps
        const maxAdjust = 0.05 * dt;
        const adjust = Math.max(-maxAdjust, Math.min(maxAdjust, err * 2.0 * dt));

        let next = localRef.current + dt + adjust;
        if (next < 0) next = 0;
        localRef.current = next;
        setAbsolute(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frozen, resetKey, draggingRef]);

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

  return [absolute, seekAbsolute];
}

/** @deprecated Prefer useContinuousPlayhead -- kept for mixer-style non-transport uses. */
export function useOptimisticSeek(
  serverSeconds: number,
  resetKey?: unknown,
  playing = false,
): [number, (v: number) => void] {
  // Thin adapter: treat serverSeconds as absolute for callers that still
  // pass song-local time (Timeline was migrated off this).
  return useContinuousPlayhead(serverSeconds, playing, resetKey);
}

/** @deprecated Use useContinuousPlayhead. */
export function useOptimisticGlobalPlayhead(
  serverGlobalSeconds: number,
  playing: boolean,
  resetKey?: unknown,
): number {
  const [abs] = useContinuousPlayhead(serverGlobalSeconds, playing, resetKey);
  return abs;
}
