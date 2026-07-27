import { useEffect, useMemo, useRef } from "react";
import { Button } from "@heroui/react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { transport } from "../lib/api";
import { useLiveValue, useOptimisticSeek } from "../lib/optimistic";
import type { PeaksResponse, SongEventRow, WebUiState } from "../lib/types";

// Multi-lane timeline: ruler with major/minor tick marks (figmint-style
// graduated steps), per-track waveform canvases, event markers, playhead, zoom
// and click/drag-to-seek. Playhead position is updated optimistically so the
// needle moves instantly on scrub without waiting for the WS frame.

const LABEL_WIDTH = 96;
const LANE_HEIGHT = 44;
const EVENT_LANE_HEIGHT = 22;
const RULER_HEIGHT = 28;
const MIN_PX_PER_SEC = 8;
const MAX_PX_PER_SEC = 240;
const SEEK_THROTTLE_MS = 60; // faster feel during drag

const TRACK_COLORS = [
  "#ff5a5f", "#ff9f43", "#feca57", "#1dd1a1", "#00d2d3",
  "#54a0ff", "#5f27cd", "#c56cf0", "#ff6b81", "#a4b0be",
];

// ------- waveform -------------------------------------------------------

function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: number[],
  width: number,
  height: number,
  color: string,
) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (peaks.length === 0 || width <= 0) return;

  const mid = height / 2;
  // subtle gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, color + "cc");
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, color + "cc");
  ctx.fillStyle = grad;

  const binsPerPixel = peaks.length / width;
  for (let x = 0; x < width; x++) {
    const b0 = Math.floor(x * binsPerPixel);
    const b1 = Math.max(b0 + 1, Math.floor((x + 1) * binsPerPixel));
    let amp = 0;
    for (let b = b0; b < Math.min(b1, peaks.length); b++) if (peaks[b] > amp) amp = peaks[b];
    const h = Math.max(1, amp * (height - 6));
    ctx.fillRect(x, mid - h / 2, 1, h);
  }
}

// ------- ruler ----------------------------------------------------------

// Returns the major-step and minor-subdivisions for a given px/sec density.
// Mirrors figmint's graduated ruler: major labels every N seconds,
// 4 or 5 minor ticks in between.
function rulerConfig(pxPerSec: number): { majorStep: number; minorDiv: number } {
  if (pxPerSec >= 120) return { majorStep: 5, minorDiv: 5 };
  if (pxPerSec >= 60) return { majorStep: 10, minorDiv: 5 };
  if (pxPerSec >= 30) return { majorStep: 15, minorDiv: 5 };
  if (pxPerSec >= 12) return { majorStep: 30, minorDiv: 5 };
  if (pxPerSec >= 6) return { majorStep: 60, minorDiv: 4 };
  return { majorStep: 120, minorDiv: 4 };
}

function formatTimeShort(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Ruler({
  pxPerSec,
  contentWidth,
  songLength,
}: {
  pxPerSec: number;
  contentWidth: number;
  songLength: number;
}) {
  const { majorStep, minorDiv } = rulerConfig(pxPerSec);
  const minorStep = majorStep / minorDiv;

  const marks: { t: number; major: boolean }[] = [];
  const epsilon = minorStep * 0.01;
  for (let t = 0; t <= songLength + epsilon; t += minorStep) {
    const rounded = Math.round(t / minorStep) * minorStep;
    const isMajor = Math.abs(rounded % majorStep) < epsilon;
    marks.push({ t: rounded, major: isMajor });
  }

  return (
    <div
      className="relative select-none border-b border-default/30"
      style={{ height: RULER_HEIGHT, width: LABEL_WIDTH + contentWidth }}
    >
      {/* label column filler */}
      <div
        className="absolute left-0 top-0 h-full border-r border-default/30 bg-surface"
        style={{ width: LABEL_WIDTH }}
      />
      {marks.map(({ t, major }) => (
        <div
          key={t}
          className="absolute bottom-0"
          style={{ left: LABEL_WIDTH + t * pxPerSec }}
        >
          {/* tick */}
          <div
            className={major ? "bg-foreground/30" : "bg-foreground/15"}
            style={{
              width: 1,
              height: major ? 10 : 5,
              position: "absolute",
              bottom: 0,
              left: 0,
            }}
          />
          {/* label (major only) */}
          {major && (
            <div
              className="absolute whitespace-nowrap pl-1 text-[9px] leading-none text-foreground/40"
              style={{ bottom: 11, left: 0 }}
            >
              {formatTimeShort(t)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------- TrackLane ------------------------------------------------------

function TrackLane({
  name,
  color,
  peaks,
  width,
}: {
  name: string;
  color: string;
  peaks: number[];
  width: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current) drawWaveform(canvasRef.current, peaks, width, LANE_HEIGHT - 6, color);
  }, [peaks, width, color]);

  return (
    <div className="flex" style={{ height: LANE_HEIGHT }}>
      <div
        className="flex shrink-0 items-center truncate border-r border-default/30 bg-surface px-2 text-xs font-medium"
        style={{ width: LABEL_WIDTH }}
        title={name}
      >
        <span className="mr-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate">{name}</span>
      </div>
      <div
        className="flex items-center bg-default/10"
        style={{ width, height: LANE_HEIGHT, overflow: "hidden" }}
      >
        {peaks.length === 0 ? (
          // Loading placeholder — subtle pulsing bar while peaks build
          <div
            className="animate-pulse rounded-sm bg-default/20"
            style={{ width: "100%", height: 6, margin: "auto 0" }}
          />
        ) : (
          <canvas ref={canvasRef} />
        )}
      </div>
    </div>
  );
}

// ------- Timeline -------------------------------------------------------

export function Timeline({
  state,
  peaks,
  pxPerSec,
  setPxPerSec,
}: {
  state: WebUiState;
  peaks: PeaksResponse | null;
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastSeekAt = useRef(0);

  // Optimistic playhead: moves instantly on drag, syncs back after server ack
  const [playheadSec, setPlayheadSec] = useOptimisticSeek(state.playheadSeconds);

  // Zoom: persist in parent so it survives re-renders
  const [, handleZoom] = useLiveValue(pxPerSec, setPxPerSec);
  void handleZoom; // we use setPxPerSec directly; this just satisfies the import

  const hasSong = state.songIndex >= 0;
  const song = hasSong ? state.songs[state.songIndex] : undefined;
  const events: SongEventRow[] = song?.events ?? [];

  const songLength = useMemo(() => {
    let max = 0;
    for (const t of peaks?.tracks ?? []) max = Math.max(max, t.durationSeconds);
    for (const e of events) max = Math.max(max, e.timeSeconds);
    return Math.max(max, hasSong ? 1 : 0);
  }, [peaks, events, hasSong]);

  const contentWidth = Math.max(1, Math.round(songLength * pxPerSec));

  // Auto-scroll playhead into view while playing
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !state.playing) return;
    const needle = LABEL_WIDTH + playheadSec * pxPerSec;
    const { scrollLeft, clientWidth } = el;
    const margin = clientWidth * 0.15;
    if (needle < scrollLeft + margin || needle > scrollLeft + clientWidth - margin) {
      el.scrollTo({ left: needle - clientWidth / 2, behavior: "smooth" });
    }
  }, [playheadSec, pxPerSec, state.playing]);

  const seekFromClientX = (clientX: number, commit: boolean) => {
    const el = scrollRef.current;
    if (!el || !hasSong) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left - LABEL_WIDTH + el.scrollLeft;
    const seconds = Math.max(0, Math.min(songLength, x / pxPerSec));
    setPlayheadSec(seconds); // optimistic
    const now = Date.now();
    if (commit || now - lastSeekAt.current >= SEEK_THROTTLE_MS) {
      lastSeekAt.current = now;
      void transport.seek(seconds);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasSong) return;
    dragging.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX, true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    seekFromClientX(e.clientX, false);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    seekFromClientX(e.clientX, true);
  };

  const peaksById = new Map((peaks?.tracks ?? []).map((t) => [t.id, t.peaks]));

  const trackCount = state.tracks.length;
  const playheadHeight =
    RULER_HEIGHT + EVENT_LANE_HEIGHT + Math.max(trackCount, hasSong ? 1 : 0) * LANE_HEIGHT;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-default/30 bg-surface/60">
      {/* toolbar */}
      <div className="flex items-center justify-between border-b border-default/30 px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground/40">
          Timeline
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Zoom out"
            onPress={() => setPxPerSec((p) => Math.max(MIN_PX_PER_SEC, p / 1.5))}
          >
            <ZoomOut size={14} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Zoom in"
            onPress={() => setPxPerSec((p) => Math.min(MAX_PX_PER_SEC, p * 1.5))}
          >
            <ZoomIn size={14} />
          </Button>
        </div>
      </div>

      {/* empty state */}
      {!hasSong ? (
        <div className="flex h-20 items-center justify-center text-sm text-foreground/40">
          No song selected
        </div>
      ) : (
        <div ref={scrollRef} className="overflow-x-auto">
          <div style={{ width: LABEL_WIDTH + contentWidth, position: "relative" }}>
            {/* Ruler with major + minor steps */}
            <Ruler pxPerSec={pxPerSec} contentWidth={contentWidth} songLength={songLength} />

            {/* Event marker lane */}
            <div className="flex border-b border-default/30" style={{ height: EVENT_LANE_HEIGHT }}>
              <div
                className="shrink-0 border-r border-default/30 bg-surface"
                style={{ width: LABEL_WIDTH }}
              />
              <div className="relative" style={{ width: contentWidth }}>
                {events.map((e) => (
                  <div
                    key={e.id}
                    className="absolute top-0.5 flex flex-col items-center text-warning"
                    style={{ left: e.timeSeconds * pxPerSec - 5 }}
                    title={`${e.id} (${e.type}) @ ${e.timeSeconds.toFixed(2)}s`}
                  >
                    {/* flag stem */}
                    <div className="h-3 w-px bg-warning/70" />
                    <div className="h-1.5 w-1.5 rounded-full bg-warning" />
                  </div>
                ))}
              </div>
            </div>

            {/* Track lanes + seek overlay */}
            <div
              className={`relative touch-none select-none ${hasSong ? "cursor-col-resize" : ""}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {trackCount === 0 ? (
                <div className="flex h-16 items-center pl-4 text-sm text-foreground/50">
                  No tracks in this song.
                </div>
              ) : (
                state.tracks.map((t, i) => (
                  <TrackLane
                    key={t.id}
                    name={t.name || t.id}
                    color={TRACK_COLORS[i % TRACK_COLORS.length]}
                    peaks={peaksById.get(t.id) ?? []}
                    width={contentWidth}
                  />
                ))
              )}

              {/* Playhead needle */}
              <div
                className="pointer-events-none absolute top-0 z-10 w-px bg-danger"
                style={{
                  left: LABEL_WIDTH + playheadSec * pxPerSec,
                  height: playheadHeight,
                }}
              >
                {/* diamond head */}
                <div className="absolute -left-[4px] -top-[5px] h-2.5 w-2.5 rotate-45 bg-danger shadow-sm" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
