// Optimistic UI helper.
//
// useLiveValue(serverValue, commit):
//   - Returns [displayValue, handleChange]
//   - On handleChange(v): immediately sets local value AND fires commit(v) for
//     the server. The local value stays "owned" for `lockMs` after the last
//     edit so rapid changes (fader drags, scroll) don't stutter waiting for
//     the round-trip. After the lock expires the next server snapshot takes
//     back over, which keeps remote clients visible.
//
// useOptimisticSeek(serverSeconds, resetKey, playing):
//   - Timeline playhead. While playing, advances locally at 1x via rAF so the
//     needle doesn't only jump when a ~30 Hz WS frame arrives. Soft-corrects
//     toward the server. Seek sets the value immediately and locks briefly.

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

  // Accept server value only when no recent local edit is in flight.
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

// Playhead-specific: the server pushes updates ~30 Hz while playing.
// We want:
//   1. Optimistic seek that immediately moves the needle
//   2. Smooth 60fps advance while playing (don't wait for the next WS frame)
//   3. Soft resync to the server so we never drift far from the engine
export function useOptimisticSeek(
  serverSeconds: number,
  resetKey?: unknown,
  playing = false,
): [number, (v: number) => void] {
  const [seconds, setSeconds] = useState(serverSeconds);
  const lastSeekAt = useRef(0);
  const targetSeekVal = useRef<number | null>(null);
  const prevKey = useRef(resetKey);
  const localRef = useRef(serverSeconds);
  const serverRef = useRef(serverSeconds);
  const playingRef = useRef(playing);
  const lastFrameTs = useRef<number | null>(null);
  const SEEK_LOCK_MS = 600;
  // Max catch-up correction per second toward server (seconds of playhead).
  const CORRECT_RATE = 0.35;

  serverRef.current = serverSeconds;
  playingRef.current = playing;

  // Song / project change: hard snap, drop seek lock.
  useEffect(() => {
    if (prevKey.current !== resetKey) {
      prevKey.current = resetKey;
      lastSeekAt.current = 0;
      targetSeekVal.current = null;
      localRef.current = serverSeconds;
      setSeconds(serverSeconds);
      lastFrameTs.current = null;
    }
  }, [resetKey, serverSeconds]);

  // Server snapshot handling (seek lock + soft resync when not playing).
  useEffect(() => {
    const elapsed = Date.now() - lastSeekAt.current;
    if (elapsed <= SEEK_LOCK_MS) {
      if (
        targetSeekVal.current !== null &&
        Math.abs(serverSeconds - targetSeekVal.current) < 0.8
      ) {
        // Server caught up to seek target -- release lock early.
        lastSeekAt.current = 0;
        targetSeekVal.current = null;
        localRef.current = serverSeconds;
        setSeconds(serverSeconds);
      }
      return;
    }
    // Not seek-locked: if stopped, snap to server. If playing, the rAF loop
    // soft-corrects -- only hard-snap if we're wildly off (song jump, stall).
    if (!playingRef.current) {
      localRef.current = serverSeconds;
      setSeconds(serverSeconds);
      lastFrameTs.current = null;
    } else if (Math.abs(serverSeconds - localRef.current) > 1.5) {
      localRef.current = serverSeconds;
      setSeconds(serverSeconds);
    }
  }, [serverSeconds]);

  // 60fps local advance while playing.
  useEffect(() => {
    if (!playing) {
      lastFrameTs.current = null;
      return;
    }
    let raf = 0;
    const tick = (ts: number) => {
      const prev = lastFrameTs.current;
      lastFrameTs.current = ts;
      if (prev != null && Date.now() - lastSeekAt.current > SEEK_LOCK_MS) {
        const dt = Math.min(0.1, Math.max(0, (ts - prev) / 1000));
        let next = localRef.current + dt;
        // Soft-correct toward the latest server snapshot so we don't drift.
        const err = serverRef.current - next;
        next += err * Math.min(1, CORRECT_RATE * dt * 4);
        if (next < 0) next = 0;
        localRef.current = next;
        setSeconds(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, resetKey]);

  const seek = (v: number) => {
    lastSeekAt.current = Date.now();
    targetSeekVal.current = v;
    localRef.current = v;
    setSeconds(v);
    lastFrameTs.current = null;
  };

  return [seconds, seek];
}

// Global (whole-set) playhead mirror of useOptimisticSeek -- same rAF advance,
// keyed on project structure rather than song index so a song change does not
// zero the absolute clock.
export function useOptimisticGlobalPlayhead(
  serverGlobalSeconds: number,
  playing: boolean,
  resetKey?: unknown,
): number {
  const [seconds, setSeconds] = useState(serverGlobalSeconds);
  const localRef = useRef(serverGlobalSeconds);
  const serverRef = useRef(serverGlobalSeconds);
  const prevKey = useRef(resetKey);
  const lastFrameTs = useRef<number | null>(null);
  const CORRECT_RATE = 0.35;

  serverRef.current = serverGlobalSeconds;

  useEffect(() => {
    if (prevKey.current !== resetKey) {
      prevKey.current = resetKey;
      localRef.current = serverGlobalSeconds;
      setSeconds(serverGlobalSeconds);
      lastFrameTs.current = null;
      return;
    }
    if (!playing) {
      localRef.current = serverGlobalSeconds;
      setSeconds(serverGlobalSeconds);
      lastFrameTs.current = null;
    } else if (Math.abs(serverGlobalSeconds - localRef.current) > 1.5) {
      localRef.current = serverGlobalSeconds;
      setSeconds(serverGlobalSeconds);
    }
  }, [serverGlobalSeconds, playing, resetKey]);

  useEffect(() => {
    if (!playing) {
      lastFrameTs.current = null;
      return;
    }
    let raf = 0;
    const tick = (ts: number) => {
      const prev = lastFrameTs.current;
      lastFrameTs.current = ts;
      if (prev != null) {
        const dt = Math.min(0.1, Math.max(0, (ts - prev) / 1000));
        let next = localRef.current + dt;
        const err = serverRef.current - next;
        next += err * Math.min(1, CORRECT_RATE * dt * 4);
        if (next < 0) next = 0;
        localRef.current = next;
        setSeconds(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, resetKey]);

  return seconds;
}
