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
export function useOptimisticSeek(serverSeconds: number): [number, (v: number) => void] {
  const [seconds, setSeconds] = useState(serverSeconds);
  const lastSeekAt = useRef(0);
  const SEEK_LOCK_MS = 600; // a bit longer -- server may restage

  useEffect(() => {
    if (Date.now() - lastSeekAt.current > SEEK_LOCK_MS) setSeconds(serverSeconds);
  }, [serverSeconds]);

  const seek = (v: number) => {
    lastSeekAt.current = Date.now();
    setSeconds(v);
  };

  return [seconds, seek];
}
