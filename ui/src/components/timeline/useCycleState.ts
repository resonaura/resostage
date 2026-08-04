import { useCallback, useEffect, useRef, useState } from "react";
import { builder } from "../../lib/api";
import type { ProjectCycleRow } from "../../lib/types";

/**
 * Single project-wide Logic-style cycle (song-local seconds on songIndex).
 * Not per-song: creating/moving rebinds the one zone to the active song.
 * Cross-song spans are unsupported.
 */

export interface CycleLocators {
  active: boolean;
  skip: boolean;
  leftSec: number;
  rightSec: number;
  songIndex: number;
}

const DEFAULT_RANGE = { leftSec: 0, rightSec: 4 };

function clampPair(
  left: number,
  right: number,
  songLen: number,
): { leftSec: number; rightSec: number } {
  const span = Math.max(0, songLen);
  // Normalize order FIRST so drag-left create (end < start) works.
  let a = Math.max(0, Math.min(span, left));
  let b = Math.max(0, Math.min(span, right));
  if (a > b) {
    const t = a;
    a = b;
    b = t;
  }
  if (b - a < 0.05) {
    const mid = (a + b) / 2;
    return {
      leftSec: Math.max(0, mid - 0.05),
      rightSec: Math.min(span || 0.1, mid + 0.05),
    };
  }
  return { leftSec: a, rightSec: b };
}

function fromServer(
  server: ProjectCycleRow | undefined,
  fallbackSongIndex: number,
  songLen: number,
): CycleLocators {
  const pair = clampPair(
    server?.leftSec ?? DEFAULT_RANGE.leftSec,
    server?.rightSec ?? DEFAULT_RANGE.rightSec,
    songLen > 0 ? songLen : Math.max(server?.rightSec ?? 4, 4),
  );
  const si =
    typeof server?.songIndex === "number" && server.songIndex >= 0
      ? server.songIndex
      : fallbackSongIndex;
  return {
    active: Boolean(server?.active),
    skip: Boolean(server?.skip),
    ...pair,
    songIndex: si,
  };
}

export function useCycleState(
  activeSongIndex: number,
  /** Length of the song the cycle currently belongs to (for clamp). */
  cycleSongLength: number,
  serverCycle: ProjectCycleRow | undefined,
) {
  const [cycle, setCycle] = useState<CycleLocators>(() =>
    fromServer(serverCycle, activeSongIndex, cycleSongLength),
  );
  const draggingRef = useRef(false);
  const latestRef = useRef(cycle);
  latestRef.current = cycle;

  useEffect(() => {
    if (draggingRef.current) return;
    setCycle(fromServer(serverCycle, activeSongIndex, cycleSongLength));
  }, [
    activeSongIndex,
    cycleSongLength,
    serverCycle?.active,
    serverCycle?.skip,
    serverCycle?.leftSec,
    serverCycle?.rightSec,
    serverCycle?.songIndex,
  ]);

  const push = useCallback((next: CycleLocators, gestureId?: string) => {
    void builder.cycleUpdate({
      songIndex: next.songIndex,
      active: next.active,
      skip: next.skip,
      leftSec: next.leftSec,
      rightSec: next.rightSec,
      gestureId,
    });
  }, []);

  const toggleActive = useCallback(() => {
    setCycle((c) => {
      const next = {
        ...c,
        active: !c.active,
        // Keep existing songIndex; if unset, bind to active song.
        songIndex: c.songIndex >= 0 ? c.songIndex : activeSongIndex,
      };
      push(next);
      return next;
    });
  }, [activeSongIndex, push]);

  const setRange = useCallback(
    (
      leftSec: number,
      rightSec: number,
      opts?: {
        activate?: boolean;
        skip?: boolean;
        dragging?: boolean;
        /** Rebind zone to this song (default: active song). */
        songIndex?: number;
        /** Clamp using this length when rebinding (default: cycleSongLength). */
        songLength?: number;
      },
    ) => {
      if (opts?.dragging) draggingRef.current = true;
      const bindTo = opts?.songIndex ?? activeSongIndex;
      const len = opts?.songLength ?? cycleSongLength;
      setCycle((c) => {
        const pair = clampPair(leftSec, rightSec, len);
        const next: CycleLocators = {
          ...c,
          ...pair,
          songIndex: bindTo,
          active: opts?.activate ?? true,
          skip: opts?.skip ?? c.skip,
        };
        if (!opts?.dragging) push(next);
        return next;
      });
    },
    [activeSongIndex, cycleSongLength, push],
  );

  const toggleSkip = useCallback(() => {
    setCycle((c) => {
      const next = {
        ...c,
        skip: !c.skip,
        active: true,
        songIndex: c.songIndex >= 0 ? c.songIndex : activeSongIndex,
      };
      push(next);
      return next;
    });
  }, [activeSongIndex, push]);

  const commitDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const next = latestRef.current;
    push({
      ...next,
      songIndex: next.songIndex >= 0 ? next.songIndex : activeSongIndex,
    });
  }, [activeSongIndex, push]);

  return {
    cycle,
    setCycle,
    toggleActive,
    setRange,
    toggleSkip,
    commitDrag,
  };
}
