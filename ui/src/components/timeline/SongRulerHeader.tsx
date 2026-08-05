import type { SongRow } from "../../lib/types";
import {
  RULER_BEAT_HEIGHT,
  RULER_CYCLE_HEIGHT,
  RULER_HEIGHT,
} from "./constants";
import { CycleStrip } from "./CycleStrip";
import { Ruler } from "./Ruler";
import type { CycleLocators } from "./useCycleState";

/**
 * Sticky two-tier bar ruler (Logic-style):
 *   upper = cycle create / move / toggle
 *   lower = beat ticks + playhead scrub
 */
export function SongRulerHeader({
  songs,
  songOffsets,
  songLengths,
  songIndex,
  pxPerSec,
  contentWidth,
  scrollState,
  playheadHandleRef,
  cycle,
  snapToGrid = false,
  onCycleToggle,
  onCycleSetRange,
  onCycleToggleSkip,
  onCycleDragEnd,
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
  cycle: CycleLocators;
  snapToGrid?: boolean;
  onCycleToggle: () => void;
  onCycleSetRange: (
    leftSec: number,
    rightSec: number,
    opts?: {
      activate?: boolean;
      skip?: boolean;
      dragging?: boolean;
      songIndex?: number;
      songLength?: number;
    },
  ) => void;
  onCycleToggleSkip: () => void;
  onCycleDragEnd?: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      className="sticky top-0 z-20 bg-background-secondary shrink-0 touch-none"
      style={{ width: contentWidth, height: RULER_HEIGHT }}
    >
      {songs.map((song, i) => {
        const left = Math.round(songOffsets[i] * pxPerSec);
        const w = Math.max(1, Math.round(songLengths[i] * pxPerSec));
        const isActive = i === songIndex;
        return (
          <div
            key={i}
            className="pointer-events-none absolute top-0 overflow-hidden"
            style={{ left, width: w, height: RULER_HEIGHT }}
          >
            {i > 0 && (
              <div className="absolute left-0 top-0 h-full w-px bg-default/40" />
            )}
            {/* Adaptive song badge: hide / compact when the song span is tight
                so neighbouring songs don't paint over each other at low zoom. */}
            {w >= 10 && (
              <div
                className={`pointer-events-none absolute z-40 truncate rounded-b font-bold uppercase tracking-wide ${
                  isActive
                    ? "bg-default text-foreground/70"
                    : "bg-default/30 text-foreground/50"
                }`}
                style={{
                  top: 1,
                  left: w < 28 ? 1 : 4,
                  maxWidth: Math.max(0, w - (w < 28 ? 2 : 8)),
                  padding: w < 40 ? "0 2px" : "0 4px",
                  fontSize: w < 40 ? 7 : 8,
                  lineHeight: "12px",
                }}
                title={song.name}
              >
                {w < 22
                  ? `${i + 1}`
                  : w < 48
                    ? `${i + 1}.`
                    : `${i + 1}. ${song.name}`}
              </div>
            )}
            {/* Stack: ticks → cycle fill → bar numbers (so digits never drown). */}
            <Ruler
              layer="backdrop"
              pxPerSec={pxPerSec}
              contentWidth={w}
              songLength={songLengths[i]}
              bpm={song.bpm}
              tsNum={song.tsNum}
              scrollLeft={Math.max(
                0,
                scrollState.scrollLeft - songOffsets[i] * pxPerSec,
              )}
              viewportWidth={scrollState.viewportWidth}
            />
            {/* Cycle upper tier on EVERY song: create/rebind here; the bar
                only paints when this song owns the project cycle. */}
            <CycleStrip
              songLength={songLengths[i]}
              pxPerSec={pxPerSec}
              cycle={cycle}
              ownsCycle={cycle.songIndex === i}
              bpm={song.bpm}
              tsNum={song.tsNum}
              snapToGrid={snapToGrid}
              onToggleActive={onCycleToggle}
              onSetRange={(l, r, opts) =>
                onCycleSetRange(l, r, {
                  ...opts,
                  songIndex: i,
                  songLength: songLengths[i] ?? 0,
                })
              }
              onToggleSkip={onCycleToggleSkip}
              onDragEnd={onCycleDragEnd}
            />
            <Ruler
              layer="labels"
              pxPerSec={pxPerSec}
              contentWidth={w}
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

      {/* Lower tier only: playhead scrub (does not compete with cycle). */}
      <div
        className="absolute inset-x-0 z-[15] cursor-col-resize"
        style={{ top: RULER_CYCLE_HEIGHT, height: RULER_BEAT_HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        title="Click / drag to seek"
      />

      {/* Playhead handle — lower beat tier only (never paints into cycle row). */}
      <div
        ref={playheadHandleRef}
        className="pointer-events-auto absolute z-30 w-0 -translate-x-1/2 cursor-col-resize select-none"
        style={{
          left: 0,
          top: RULER_CYCLE_HEIGHT,
          height: RULER_BEAT_HEIGHT,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
      >
        {/* Needle only through the beat tier; full arrangement line lives below. */}
        <div className="absolute inset-y-0 left-0 w-[1.5px] -translate-x-1/2 bg-[#fff] shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
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
