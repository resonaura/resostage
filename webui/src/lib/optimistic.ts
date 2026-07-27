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
// useOptimisticSeek(serverSeconds):
//   - Same idea but for the timeline playhead which is driven by transport.seek.

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
// We want an optimistic position after a seek that immediately moves the
// needle, then gracefully hands back control once the WS frame arrives.
export function useOptimisticSeek(
  serverSeconds: number,
  resetKey?: any,
): [number, (v: number) => void] {
  const [seconds, setSeconds] = useState(serverSeconds);
  const lastSeekAt = useRef(0);
  const targetSeekVal = useRef<number | null>(null);
  const prevKey = useRef(resetKey);
  const SEEK_LOCK_MS = 600;

  useEffect(() => {
    // Drop optimistic lock immediately when songIndex or project structure changes
    if (prevKey.current !== resetKey) {
      prevKey.current = resetKey;
      lastSeekAt.current = 0;
      targetSeekVal.current = null;
      setSeconds(serverSeconds);
      return;
    }

    const elapsed = Date.now() - lastSeekAt.current;
    if (elapsed > SEEK_LOCK_MS) {
      setSeconds(serverSeconds);
      targetSeekVal.current = null;
    } else if (targetSeekVal.current !== null && Math.abs(serverSeconds - targetSeekVal.current) < 0.8) {
      // Server caught up to seek target -- release lock early for smooth playback!
      lastSeekAt.current = 0;
      targetSeekVal.current = null;
      setSeconds(serverSeconds);
    }
  }, [serverSeconds, resetKey]);

  const seek = (v: number) => {
    lastSeekAt.current = Date.now();
    targetSeekVal.current = v;
    setSeconds(v);
  };

  return [seconds, seek];
}

