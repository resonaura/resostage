/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useSyncExternalStore } from "react";
import {
  channelClipHoldKey,
  clearChannelClipHold,
  getChannelPeakHold,
  getChannelClipHoldSnapshot,
  subscribeChannelClipHold,
} from "@/lib/audio/channelClipHold";
import { currentProjectCommandIdentity } from "@/lib/state/api";

/**
 * Read the project-scoped clip latch shared by every view of one stable strip.
 * Telemetry owns sampling; components only subscribe to meaningful latch
 * changes, so strips do not rerender on every meter frame.
 */
export function useChannelClipHold(identity?: string): {
  clipped: boolean;
  getHeldPeakDb: () => number;
  getHeldPeakDbL: () => number;
  getHeldPeakDbR: () => number;
  clear: () => void;
} {
  const projectIdentity = currentProjectCommandIdentity();
  const key = identity ? channelClipHoldKey(identity, projectIdentity) : "";
  const subscribe = useCallback(
    (listener: () => void) => key
      ? subscribeChannelClipHold(key, listener)
      : () => {},
    [key],
  );
  const readSnapshot = useCallback(
    () => getChannelClipHoldSnapshot(key),
    [key],
  );
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  const getHeldPeakDb = useCallback(() => {
    const peak = getChannelPeakHold(key);
    return Math.max(peak.leftDb, peak.rightDb);
  }, [key]);
  const getHeldPeakDbL = useCallback(
    () => getChannelPeakHold(key).leftDb,
    [key],
  );
  const getHeldPeakDbR = useCallback(
    () => getChannelPeakHold(key).rightDb,
    [key],
  );
  const clear = useCallback(() => {
    if (key) clearChannelClipHold(key);
  }, [key]);

  return {
    ...snapshot,
    getHeldPeakDb,
    getHeldPeakDbL,
    getHeldPeakDbR,
    clear,
  };
}
