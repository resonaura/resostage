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
 */
export function useContinuousPlayhead(
  serverAbsoluteSeconds: number,
  playing: boolean,
  resetKey?: unknown,
  frozen = false,
): [absoluteSeconds: number, seekAbsolute: (v: number, lockMs?: number) => void] {
  const [absolute, setAbsolute] = useState(serverAbsoluteSeconds);
  const localRef = useRef(serverAbsoluteSeconds);
  const serverRef = useRef(serverAbsoluteSeconds);
  const playingRef = useRef(playing);
  const prevKey = useRef(resetKey);
  const lastSeekAt = useRef(0);
  const lastFrameTs = useRef<number | null>(null);
  const SEEK_LOCK_MS = 450;
  // Stronger pull than before so we stay glued to the engine without
  // looking like a second free-running timeline.
  const CORRECT_PER_SEC = 8;

  serverRef.current = serverAbsoluteSeconds;
  playingRef.current = playing;

  // Project change only -- hard snap.
  useEffect(() => {
    if (prevKey.current !== resetKey) {
      prevKey.current = resetKey;
      lastSeekAt.current = 0;
      localRef.current = serverAbsoluteSeconds;
      setAbsolute(serverAbsoluteSeconds);
      lastFrameTs.current = null;
    }
  }, [resetKey, serverAbsoluteSeconds]);

  // Server snapshots.
  useEffect(() => {
    // While frozen (zoom gesture) don't let server corrections yank the
    // clock -- it must stand still ("автостоп времени при зуме"). The resume
    // path re-corrects after the gesture settles.
    if (frozen) return;
    const seekLocked = Date.now() - lastSeekAt.current <= SEEK_LOCK_MS;
    if (seekLocked) {
      // During scrub lock, only release early if server is near our target.
      if (Math.abs(serverAbsoluteSeconds - localRef.current) < 0.35) {
        lastSeekAt.current = 0;
        localRef.current = serverAbsoluteSeconds;
        setAbsolute(serverAbsoluteSeconds);
      }
      return;
    }
    if (!playingRef.current) {
      localRef.current = serverAbsoluteSeconds;
      setAbsolute(serverAbsoluteSeconds);
      lastFrameTs.current = null;
      return;
    }
    // Hard snap only on large discontinuities (seek we missed, stall, jump).
    if (Math.abs(serverAbsoluteSeconds - localRef.current) > 1.25) {
      localRef.current = serverAbsoluteSeconds;
      setAbsolute(serverAbsoluteSeconds);
    }
  }, [serverAbsoluteSeconds, frozen]);

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
      if (prev != null && Date.now() - lastSeekAt.current > SEEK_LOCK_MS) {
        const dt = Math.min(0.08, Math.max(0, (ts - prev) / 1000));
        let next = localRef.current + dt;
        const err = serverRef.current - next;
        // Exponential pull toward server: ~e^(-CORRECT*dt) residual.
        next += err * (1 - Math.exp(-CORRECT_PER_SEC * dt));
        if (next < 0) next = 0;
        localRef.current = next;
        setAbsolute(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frozen, resetKey]);

  const seekAbsolute = (v: number, lockMs = SEEK_LOCK_MS) => {
    const clamped = Math.max(0, v);
    // A released scrub must remain authoritative until the engine has had a
    // chance to restage and publish its new transport position.  The old
    // fixed 450ms window was shorter than a busy native seek plus one WS
    // telemetry turn, so a stale live frame could visibly undo a valid drop.
    // Callers use the default for a live drag and request the longer window
    // only for its final committed position.
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
