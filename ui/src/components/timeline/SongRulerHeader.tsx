import type { SongRow } from "../../lib/types";
import { RULER_HEIGHT } from "./constants";
import { Ruler } from "./Ruler";

/** Sticky per-song rulers + song name chips + playhead handle host. */
export function SongRulerHeader({
  songs,
  songOffsets,
  songLengths,
  songIndex,
  pxPerSec,
  contentWidth,
  scrollState,
  playheadHandleRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  songIndex: number;
  pxPerSec: number;
  contentWidth: number;
  scrollState: { scrollLeft: number; viewportWidth: number };
  playheadHandleRef: React.RefObject<HTMLDivElement | null>;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      className="sticky top-0 z-20 bg-background-secondary shrink-0 cursor-col-resize touch-none"
      // Explicit height: children are absolute; without it the sticky box
      // collapses to 0 and the ruler-band playhead (top/bottom:0) vanishes
      // under the opaque Ruler canvases ("рулер перекрывает плейхед").
      style={{ width: contentWidth, height: RULER_HEIGHT }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    >
      {songs.map((song, i) => {
        const left = Math.round(songOffsets[i] * pxPerSec);
        const isActive = i === songIndex;
        return (
          <div
            key={i}
            className="absolute top-0"
            style={{ left, height: RULER_HEIGHT }}
          >
            {i > 0 && (
              <div className="absolute left-0 top-0 h-full w-px bg-default/40" />
            )}
            <div
              className={`absolute -top-px left-1.5 z-10 truncate rounded-b px-1 text-[8px] font-bold uppercase tracking-wide ${
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "bg-default/30 text-foreground/50"
              }`}
              style={{
                maxWidth: Math.max(20, songLengths[i] * pxPerSec - 6),
              }}
              title={song.name}
            >
              {i + 1}. {song.name}
            </div>
            <Ruler
              pxPerSec={pxPerSec}
              contentWidth={Math.max(1, Math.round(songLengths[i] * pxPerSec))}
              songLength={songLengths[i]}
              bpm={song.bpm}
              tsNum={song.tsNum}
              scrollLeft={Math.max(
                0,
                scrollState.scrollLeft - songOffsets[i] * pxPerSec,
              )}
              viewportWidth={scrollState.viewportWidth}
            />
          </div>
        );
      })}
      {/* Playhead handle + ruler-band needle — AFTER song rulers so it paints
          on top of the opaque ruler canvases. Lives inside sticky so it
          sticks with the header; full-height lane needle is z-below sticky. */}
      <div
        ref={playheadHandleRef}
        className="pointer-events-auto absolute inset-y-0 z-30 w-0 -translate-x-1/2 cursor-col-resize select-none"
        style={{ left: 0 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
      >
        <div className="absolute top-0 bottom-0 left-0 w-[1.5px] -translate-x-1/2 bg-[#fff] shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
        <div
          className="absolute top-0 left-0 -translate-x-1/2"
          style={{
            width: 0,
            height: 0,
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderTop: "7px solid #fff",
            filter: "drop-shadow(0 0 2px rgba(255,255,255,0.5))",
          }}
        />
      </div>
    </div>
  );
}
