import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { Flag, ZoomIn, ZoomOut } from "lucide-react";
import { transport } from "../lib/api";
import type { PeaksResponse, SongEventRow, WebUiState } from "../lib/types";

// Multi-lane timeline for the current song: per-track peak-overview
// waveforms (data already computed natively -- see AudioEngine::
// trackPeaksAt()/rebuildTrackPeaks(), same source ClipTrimEditor/
// TimelineView.cpp render from), event markers, playhead, zoom, and
// click/drag-to-seek. Mirrors TimelineView.cpp's feature set (minus the
// song-section marker ruler and per-track trim handles, not ported yet).

const LABEL_WIDTH = 96;
const LANE_HEIGHT = 44;
const EVENT_LANE_HEIGHT = 22;
const MIN_PX_PER_SEC = 8;
const MAX_PX_PER_SEC = 240;
const SEEK_THROTTLE_MS = 90;

const TRACK_COLORS = [
  "#ff5a5f", "#ff9f43", "#feca57", "#1dd1a1", "#00d2d3",
  "#54a0ff", "#5f27cd", "#c56cf0", "#ff6b81", "#a4b0be",
];

function drawWaveform(canvas: HTMLCanvasElement, peaks: number[], width: number, height: number, color: string) {
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
  ctx.fillStyle = color;
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

function formatTimeShort(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

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
    if (canvasRef.current) drawWaveform(canvasRef.current, peaks, width, LANE_HEIGHT - 4, color);
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
      <div className="flex items-center bg-default/10" style={{ width, height: LANE_HEIGHT }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

export function Timeline({ state, peaks }: { state: WebUiState; peaks: PeaksResponse | null }) {
  const [pxPerSec, setPxPerSec] = useState(40);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastSeekAt = useRef(0);

  const song = state.songIndex >= 0 ? state.songs[state.songIndex] : undefined;
  const events: SongEventRow[] = song?.events ?? [];

  const songLength = useMemo(() => {
    let max = 0;
    for (const t of peaks?.tracks ?? []) max = Math.max(max, t.durationSeconds);
    for (const e of events) max = Math.max(max, e.timeSeconds);
    return Math.max(max, 1);
  }, [peaks, events]);

  const contentWidth = Math.max(1, Math.round(songLength * pxPerSec));

  const seekFromClientX = (clientX: number, commit: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left - LABEL_WIDTH + el.scrollLeft;
    const seconds = Math.max(0, Math.min(songLength, x / pxPerSec));
    const now = Date.now();
    if (commit || now - lastSeekAt.current >= SEEK_THROTTLE_MS) {
      lastSeekAt.current = now;
      void transport.seek(seconds);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
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

  const rulerStep = pxPerSec >= 80 ? 5 : pxPerSec >= 30 ? 10 : pxPerSec >= 12 ? 30 : 60;
  const rulerMarks: number[] = [];
  for (let t = 0; t <= songLength; t += rulerStep) rulerMarks.push(t);

  const peaksById = new Map((peaks?.tracks ?? []).map((t) => [t.id, t.peaks]));

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-default/30 bg-surface/60">
      <div className="flex items-center justify-between border-b border-default/30 px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground/40">Timeline</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" isIconOnly aria-label="Zoom out" onPress={() => setPxPerSec((p) => Math.max(MIN_PX_PER_SEC, p / 1.5))}>
            <ZoomOut size={14} />
          </Button>
          <Button size="sm" variant="outline" isIconOnly aria-label="Zoom in" onPress={() => setPxPerSec((p) => Math.min(MAX_PX_PER_SEC, p * 1.5))}>
            <ZoomIn size={14} />
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="overflow-x-auto">
        <div style={{ width: LABEL_WIDTH + contentWidth, position: "relative" }}>
          {/* Ruler */}
          <div className="relative flex border-b border-default/30" style={{ height: 20 }}>
            <div className="shrink-0 border-r border-default/30 bg-surface" style={{ width: LABEL_WIDTH }} />
            <div className="relative" style={{ width: contentWidth }}>
              {rulerMarks.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 h-full border-l border-default/20 pl-1 text-[10px] text-foreground/40"
                  style={{ left: t * pxPerSec }}
                >
                  {formatTimeShort(t)}
                </div>
              ))}
            </div>
          </div>

          {/* Event marker lane */}
          <div className="flex border-b border-default/30" style={{ height: EVENT_LANE_HEIGHT }}>
            <div className="shrink-0 border-r border-default/30 bg-surface" style={{ width: LABEL_WIDTH }} />
            <div className="relative" style={{ width: contentWidth }}>
              {events.map((e) => (
                <div
                  key={e.id}
                  className="absolute top-0.5 text-warning"
                  style={{ left: e.timeSeconds * pxPerSec - 5 }}
                  title={`${e.id} (${e.type}) @ ${e.timeSeconds.toFixed(2)}s`}
                >
                  <Flag size={12} fill="currentColor" />
                </div>
              ))}
            </div>
          </div>

          {/* Track lanes + seek overlay */}
          <div
            className="relative cursor-pointer touch-none select-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            {state.tracks.length === 0 ? (
              <div className="p-6 text-sm text-foreground/50">No tracks in this song.</div>
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

            {/* Playhead */}
            <div
              className="pointer-events-none absolute top-0 z-10 w-px bg-danger"
              style={{
                left: LABEL_WIDTH + state.playheadSeconds * pxPerSec,
                height: Math.max(state.tracks.length, 1) * LANE_HEIGHT,
              }}
            >
              <div className="absolute -left-[3px] -top-1 h-2 w-2 rotate-45 bg-danger" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
