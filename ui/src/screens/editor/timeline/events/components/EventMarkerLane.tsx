/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { withHexAlpha } from "@/lib/theme/cssColor";
import type { SongRow } from "@/lib/state/types";
import { EVENT_LANE_HEIGHT } from "@/screens/editor/timeline/events/logic/constants";
import { getEventColor } from "@/screens/editor/timeline/events/logic/colors";

/** Events from every song, each at its song's absolute offset. */
export function EventMarkerLane({
  songs,
  songOffsets,
  pxPerSec,
  contentWidth,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  songs: SongRow[];
  songOffsets: number[];
  pxPerSec: number;
  contentWidth: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      className="relative shrink-0 border-b border-default/30 bg-surface/30 cursor-col-resize touch-none"
      style={{ height: EVENT_LANE_HEIGHT, width: contentWidth }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    >
      <div className="relative" style={{ width: contentWidth }}>
        {songs.flatMap((song, i) =>
          song.events
            .filter((e) => !e.triggerOnLoad)
            .map((e) => {
              const color = getEventColor(e.type);
              const left = (songOffsets[i] + e.timeSeconds) * pxPerSec - 5;
              return (
                <div
                  key={`${i}:${e.id}`}
                  className="absolute top-1 flex flex-col items-center"
                  style={{ left }}
                  title={`${song.name}: ${e.id} (${e.type}) @ ${e.timeSeconds.toFixed(2)}s`}
                >
                  <div
                    className="h-3 w-px"
                    style={{ background: withHexAlpha(color, "aa") }}
                  />
                  <div
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: color }}
                  />
                </div>
              );
            }),
        )}
      </div>
    </div>
  );
}
