import type { SongRow } from "../../lib/types";
import { EVENT_COLORS, EVENT_LANE_HEIGHT } from "./constants";

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
              const color = EVENT_COLORS[e.type] ?? "#8e8e93";
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
                    style={{ background: color + "aa" }}
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
