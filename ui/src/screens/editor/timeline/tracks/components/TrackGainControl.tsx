/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { memo } from "react";
import { getTrackLiveLevel } from "@/lib/audio/liveLevels";
import type { TrackRow } from "@/lib/state/types";
import { MeterFader } from "@/components/daw";

/** Timeline-only gain and meter row; state and gesture ownership live in hooks. */
export const TrackGainControl = memo(function TrackGainControl({
  track,
  gain,
  color,
  nameSize,
  faderHeight,
  onGainChange,
  onReadoutPointerDown,
  onReadoutDoubleClick,
}: {
  track: TrackRow;
  gain: number;
  color: string;
  nameSize: number;
  faderHeight: number;
  onGainChange: (value: number) => void;
  onReadoutPointerDown: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onReadoutDoubleClick: (event: React.MouseEvent<HTMLSpanElement>) => void;
}) {
  const trackName = track.name || track.id;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <MeterFader
        value={gain}
        min={-60}
        max={12}
        step={0.5}
        onChange={onGainChange}
        dbL={track.peakDbL ?? track.peakDb ?? -100}
        dbR={track.peakDbR ?? track.peakDb ?? -100}
        getLiveDbL={() => getTrackLiveLevel(track.id)?.peakDbL ?? -144}
        getLiveDbR={() => getTrackLiveLevel(track.id)?.peakDbR ?? -144}
        accent={color}
        height={faderHeight}
        aria-label={`${trackName} volume`}
      />
      <span
        className="w-7 shrink-0 cursor-ns-resize select-none text-right font-mono font-medium tabular-nums text-foreground/60 transition-colors hover:text-foreground"
        style={{ fontSize: Math.max(8, nameSize - 2) }}
        title="Track volume (Drag up/down to adjust, double-click for 0 dB)"
        onPointerDown={onReadoutPointerDown}
        onDoubleClick={onReadoutDoubleClick}
      >
        {gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1)}
      </span>
    </div>
  );
});
