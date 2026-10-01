/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useState, type MouseEvent } from "react";
import { mixer } from "@/lib/state/api";
import { useLiveValue } from "@/lib/state/optimistic";
import type { TrackRow } from "@/lib/state/types";
import { TRACK_PAN_LAWS, formatPan } from "@/components/daw/logic/panLaw";

/** Owns live pan state and pan-law menu actions for the timeline track header. */
export function useTrackPanControl(track: TrackRow, index: number) {
  const [value, setValue] = useLiveValue(track.pan ?? 0, (next) =>
    mixer.setTrackPan(index, next),
  );
  const [menuPosition, setMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const onSelectPanLaw = (lawId: number) => {
    void mixer.setTrackPanLaw(index, lawId);
    setMenuPosition(null);
  };

  return {
    value,
    setValue,
    valueLabel: formatPan(value),
    activePanLaw: track.panLaw ?? TRACK_PAN_LAWS[0].value,
    panLaws: TRACK_PAN_LAWS,
    menuPosition,
    onContextMenu,
    onCloseMenu: () => setMenuPosition(null),
    onSelectPanLaw,
  };
}
