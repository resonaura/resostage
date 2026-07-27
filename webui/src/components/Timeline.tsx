import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { mixer, transport } from "../lib/api";
import { useLiveValue, useOptimisticSeek } from "../lib/optimistic";
import type { PeaksResponse, SongEventRow, TrackRow, WebUiState } from "../lib/types";

const SIDEBAR_WIDTH = 240;
const LANE_HEIGHT = 56;
const EVENT_LANE_HEIGHT = 24;
const RULER_HEIGHT = 32;
const MIN_PX_PER_SEC = 4;
const MAX_PX_PER_SEC = 400;
const SEEK_THROTTLE_MS = 60;

const TRACK_COLORS = [
  "#0091ff", "#30d158", "#ff9230", "#db34f2", "#ff375f",
  "#00d2e0", "#ff4245", "#6d7cff", "#00dac3", "#3cd3fe",
  "#ffd600", "#b78a66",
];

const EVENT_COLORS: Record<string, string> = {
  programChange: "#30d158",
  noteOn:        "#30d158",
  noteOff:       "#30d158",
  cc:            "#0091ff",
  http:          "#ff9230",
  dmx:           "#db34f2",
};

// ------- Rotary Knob (Mixer Parity) -------------------------------------

function Knob({
  value,
  min,
  max,
  defaultValue = 0,
  accent = "var(--accent, #0091ff)",
  onCommit,
  size = 20,
  title,
}: {
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  accent?: string;
  onCommit: (v: number) => void;
  size?: number;
  title?: string;
}) {
  const [localValue, setLocalValue] = useState(value);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startValue = useRef(0);
  const rafId = useRef<number | null>(null);
  const pendingCommit = useRef<number | null>(null);

  if (!dragging.current && localValue !== value) setLocalValue(value);

  const angleFor = (v: number) => {
    const t = (v - min) / (max - min);
    return -135 + t * 270;
  };

  const scheduleCommit = (v: number) => {
    pendingCommit.current = v;
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        if (pendingCommit.current != null) {
          onCommit(pendingCommit.current);
          pendingCommit.current = null;
        }
      });
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    startY.current = e.clientY;
    startValue.current = localValue;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const dy = startY.current - e.clientY;
    const range = max - min;
    const next = Math.round(Math.max(min, Math.min(max, startValue.current + (dy / 100) * range)) * 100) / 100;
    setLocalValue(next);
    scheduleCommit(next);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    if (pendingCommit.current != null) {
      onCommit(pendingCommit.current);
      pendingCommit.current = null;
    }
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      role="slider"
      aria-label={title}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={localValue}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => { setLocalValue(defaultValue); onCommit(defaultValue); }}
      className="relative shrink-0 cursor-ns-resize touch-none select-none rounded-full border border-default/60 bg-default/20 hover:border-default hover:bg-default/35 transition-colors"
      style={{ width: size, height: size }}
    >
      <div
        className="absolute left-1/2 top-1/2 w-[2px] -translate-x-1/2 -translate-y-full rounded-full"
        style={{
          height: size * 0.4,
          backgroundColor: accent,
          transformOrigin: "bottom center",
          transform: `translateX(-50%) rotate(${angleFor(localValue)}deg)`,
        }}
      />
    </div>
  );
}

// ------- Mini Track Slider (Track Color Accent) --------------------------

function MiniSlider({
  value,
  min,
  max,
  step = 0.5,
  accent,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  accent: string;
  onChange: (v: number) => void;
}) {
  const percent = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  return (
    <div className="relative flex-1 flex items-center h-3 select-none touch-none">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
      />
      {/* Track Background */}
      <div className="w-full h-1 rounded-full bg-default/20 overflow-hidden relative">
        {/* Accent Filled Track */}
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${percent}%`, backgroundColor: accent }}
        />
      </div>
      {/* HeroUI-Style Rounded Pill Thumb */}
      <div
        className="absolute h-2.5 w-3.5 rounded-full border border-background shadow-md pointer-events-none -translate-x-1/2"
        style={{ left: `${percent}%`, backgroundColor: accent }}
      />
    </div>
  );
}

// ------- TrackHeaderControl (Mixer Parity in Timeline Sidebar) ----------

function TrackHeaderControl({
  track,
  index,
  color,
}: {
  track: TrackRow;
  index: number;
  color: string;
}) {
  const [gain, setGain] = useLiveValue(track.gainDb ?? 0, (v) => mixer.setTrackGain(index, v));
  const [pan, setPan] = useLiveValue(track.pan ?? 0, (v) => mixer.setTrackPan(index, v));

  const formatPan = (p: number) => {
    if (Math.abs(p) < 0.05) return "C";
    if (p < 0) return `L${Math.round(-p * 100)}`;
    return `R${Math.round(p * 100)}`;
  };

  return (
    <div
      className="flex flex-col justify-between border-b border-default/15 px-3 py-1.5 select-none bg-surface/40 hover:bg-surface/70 transition-colors"
      style={{ height: LANE_HEIGHT }}
    >
      {/* Top Row: Color indicator, Track Name, Pan Knob & Value, Mute & Solo */}
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="h-3.5 w-2 shrink-0 rounded-sm"
          style={{ background: color, opacity: track.mute ? 0.35 : 1 }}
        />
        <span
          className={`truncate text-xs font-semibold text-foreground/90 ${
            track.mute ? "line-through opacity-40" : ""
          }`}
          title={track.name || track.id}
        >
          {track.name || track.id}
        </span>

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {/* Rotary Knob for Pan Balance */}
          <div className="flex items-center gap-1" title={`Pan: ${formatPan(pan)}`}>
            <Knob
              value={pan}
              min={-1}
              max={1}
              defaultValue={0}
              size={20}
              accent={color}
              onCommit={(v) => setPan(v)}
            />
            <span className="w-5 text-[8px] font-mono text-foreground/50 text-center font-medium">
              {formatPan(pan)}
            </span>
          </div>

          {/* Mute Button */}
          <button
            type="button"
            onClick={() => mixer.setTrackMute(index, !track.mute)}
            className={`h-5.5 w-5.5 rounded text-[10px] font-bold transition-all shadow-sm ${
              track.mute
                ? "bg-danger text-white scale-105"
                : "bg-default/20 text-foreground/50 hover:bg-default/35 hover:text-foreground"
            }`}
            title="Mute"
          >
            M
          </button>

          {/* Solo Button */}
          <button
            type="button"
            onClick={() => mixer.setTrackSolo(index, !track.solo)}
            className={`h-5.5 w-5.5 rounded text-[10px] font-bold transition-all shadow-sm ${
              track.solo
                ? "bg-warning text-black scale-105"
                : "bg-default/20 text-foreground/50 hover:bg-default/35 hover:text-foreground"
            }`}
            title="Solo"
          >
            S
          </button>
        </div>
      </div>

      {/* Bottom Row: Mini Slider for Volume matching Track Color */}
      <div className="flex items-center gap-2 text-[9px] font-mono text-foreground/60">
        <span className="shrink-0 text-foreground/40 text-[8px] uppercase tracking-wider font-semibold">Vol</span>
        <MiniSlider
          value={gain}
          min={-60}
          max={12}
          step={0.5}
          accent={color}
          onChange={(v) => setGain(v)}
        />
        <span className="w-8 shrink-0 text-right font-medium text-[9px] tabular-nums">
          {gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1)}
        </span>
      </div>
    </div>
  );
}

// ------- Dynamic Ruler Tick Configuration -------------------------------

function getTickConfig(pxPerSec: number, bpm: number, tsNum: number) {
  const minPxPerLabel = 70;
  if (bpm > 1) {
    const beatSec = 60 / bpm;
    const barSec = beatSec * Math.max(1, tsNum);
    const barsList = [1, 2, 4, 8, 16, 32, 64];
    const majorBarStep = barsList.find((b) => b * barSec * pxPerSec >= minPxPerLabel) ?? 64;
    const majorStepSec = majorBarStep * barSec;
    const minorStepSec = majorBarStep === 1 ? beatSec : barSec;
    return { majorStepSec, minorStepSec, isBeatGrid: true, barSec, beatSec };
  } else {
    const secList = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const majorStepSec = secList.find((s) => s * pxPerSec >= minPxPerLabel) ?? 300;
    const minorStepSec = majorStepSec >= 60 ? 10 : majorStepSec >= 5 ? 1 : majorStepSec / 5;
    return { majorStepSec, minorStepSec, isBeatGrid: false, barSec: 0, beatSec: 0 };
  }
}

function formatTimeShort(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

function Ruler({
  pxPerSec,
  contentWidth,
  songLength,
  bpm,
  tsNum,
}: {
  pxPerSec: number;
  contentWidth: number;
  songLength: number;
  bpm: number;
  tsNum: number;
}) {
  const { majorStepSec, minorStepSec, isBeatGrid, barSec } = useMemo(
    () => getTickConfig(pxPerSec, bpm, tsNum),
    [pxPerSec, bpm, tsNum]
  );

  const marks = useMemo(() => {
    const list: { x: number; major: boolean; label?: string }[] = [];
    const limit = songLength + majorStepSec;

    for (let t = 0; t <= limit; t += minorStepSec) {
      const rounded = Math.round(t / minorStepSec) * minorStepSec;
      const x = Math.round(rounded * pxPerSec);
      if (x > contentWidth + 8) break;

      const isMajor = Math.abs((rounded % majorStepSec) / majorStepSec) < 0.02 ||
                      Math.abs(((rounded % majorStepSec) - majorStepSec) / majorStepSec) < 0.02;

      let label: string | undefined;
      if (isMajor) {
        if (isBeatGrid && barSec > 0) {
          const barNum = Math.round(rounded / barSec) + 1;
          label = `${barNum}`;
        } else {
          label = formatTimeShort(rounded);
        }
      }
      list.push({ x, major: isMajor, label });
    }
    return list;
  }, [pxPerSec, contentWidth, songLength, majorStepSec, minorStepSec, isBeatGrid, barSec]);

  return (
    <div
      className="relative select-none border-b border-default/30 bg-surface/95 shrink-0"
      style={{ height: RULER_HEIGHT, width: contentWidth }}
    >
      {marks.map(({ x, major, label }, idx) => (
        <div key={idx} className="absolute bottom-0" style={{ left: x }}>
          <div
            style={{
              width: 1,
              height: major ? 14 : 6,
              position: "absolute",
              bottom: 0,
              left: 0,
              background: major ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.12)",
            }}
          />
          {label && (
            <div
              style={{
                position: "absolute",
                bottom: 14,
                left: 3,
                fontSize: 9,
                fontWeight: 600,
                lineHeight: 1,
                whiteSpace: "nowrap",
                color: major ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.3)",
              }}
            >
              {label}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------- Viewport-based Hardware-Accelerated Smooth Waveform Canvas -----------

function TrackWaveformLane({
  peaks,
  contentWidth,
  scrollLeft,
  viewportWidth,
  pxPerSec,
  color,
  muted,
}: {
  peaks: number[];
  contentWidth: number;
  scrollLeft: number;
  viewportWidth: number;
  pxPerSec: number;
  color: string;
  muted: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportWidth <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const renderWidth = Math.min(viewportWidth, contentWidth);
    canvas.width = Math.max(1, Math.floor(renderWidth * dpr));
    canvas.height = Math.max(1, Math.floor((LANE_HEIGHT - 6) * dpr));
    canvas.style.width = `${renderWidth}px`;
    canvas.style.height = `${LANE_HEIGHT - 6}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, renderWidth, LANE_HEIGHT - 6);
    if (peaks.length === 0) return;

    const height = LANE_HEIGHT - 6;
    const mid = height / 2;
    const alpha = muted ? 0.18 : 1.0;

    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, color + (muted ? "2e" : "bb"));
    grad.addColorStop(0.5, color + (muted ? "30" : "ff"));
    grad.addColorStop(1, color + (muted ? "2e" : "bb"));
    ctx.fillStyle = grad;
    ctx.globalAlpha = alpha;

    const totalPeaks = peaks.length;
    const totalDurationSec = contentWidth / pxPerSec;
    const amps = new Float32Array(renderWidth);

    for (let x = 0; x < renderWidth; x++) {
      const globalX = scrollLeft + x;
      const tSec = globalX / pxPerSec;
      const peakPos = (tSec / totalDurationSec) * (totalPeaks - 1);
      if (peakPos >= 0 && peakPos < totalPeaks) {
        const i0 = Math.floor(peakPos);
        const i1 = Math.min(totalPeaks - 1, i0 + 1);
        const frac = peakPos - i0;
        amps[x] = peaks[i0] * (1 - frac) + peaks[i1] * frac;
      } else {
        amps[x] = 0;
      }
    }

    // Build upper & lower continuous smooth path
    ctx.beginPath();
    let started = false;
    for (let x = 0; x < renderWidth; x++) {
      const amp = amps[x];
      const h = Math.max(1.5, amp * (height - 4));
      const yTop = mid - h / 2;
      if (!started) {
        ctx.moveTo(x, yTop);
        started = true;
      } else {
        ctx.lineTo(x, yTop);
      }
    }
    for (let x = renderWidth - 1; x >= 0; x--) {
      const amp = amps[x];
      const h = Math.max(1.5, amp * (height - 4));
      const yBottom = mid + h / 2;
      ctx.lineTo(x, yBottom);
    }
    ctx.closePath();
    ctx.fill();

    // High resolution anti-aliased stroke outline
    ctx.lineWidth = 1;
    ctx.strokeStyle = color + (muted ? "40" : "dd");
    ctx.stroke();

    ctx.globalAlpha = 1;
  }, [peaks, contentWidth, scrollLeft, viewportWidth, pxPerSec, color, muted]);

  return (
    <div
      className="relative flex items-center border-b border-default/15 bg-default/10"
      style={{ width: contentWidth, height: LANE_HEIGHT, opacity: muted ? 0.4 : 1 }}
    >
      {peaks.length === 0 ? (
        <div
          className="animate-pulse rounded-sm bg-default/20"
          style={{ width: "100%", height: 6, margin: "auto 0" }}
        />
      ) : (
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute top-1"
          style={{ left: scrollLeft }}
        />
      )}
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
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastSeekAt = useRef(0);
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;
  const pendingScrollLeftRef = useRef<number | null>(null);

  const [scrollTopY, setScrollTopY] = useState(0);
  const [scrollState, setScrollState] = useState({ scrollLeft: 0, viewportWidth: 1000 });

  const [playheadSec, setPlayheadSec] = useOptimisticSeek(state.playheadSeconds);

  const hasSong = state.songIndex >= 0;
  const song = hasSong ? state.songs[state.songIndex] : undefined;
  const events: SongEventRow[] = song?.events ?? [];
  const bpm = song?.bpm ?? 0;
  const tsNum = song?.tsNum ?? 4;

  const songLength = useMemo(() => {
    let max = 0;
    for (const t of peaks?.tracks ?? []) max = Math.max(max, t.durationSeconds);
    for (const e of events) max = Math.max(max, e.timeSeconds);
    return Math.max(max, hasSong ? 1 : 0);
  }, [peaks, events, hasSong]);

  const contentWidth = Math.max(1, Math.round(songLength * pxPerSec));

  const applyZoomAt = (nextPxPerSec: number, focusClientX?: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const oldPx = pxPerSecRef.current;
    const clampedNext = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, nextPxPerSec));
    if (Math.abs(clampedNext - oldPx) < 0.001) return;

    const k = clampedNext / oldPx;
    const rect = scroller.getBoundingClientRect();

    let focusX = typeof focusClientX === "number" ? focusClientX - rect.left : rect.width / 2;
    if (focusX < 0 || focusX > rect.width) focusX = rect.width / 2;

    const currentScrollLeft = pendingScrollLeftRef.current !== null
      ? pendingScrollLeftRef.current
      : scroller.scrollLeft;

    const newScrollLeftWanted = k * (currentScrollLeft + focusX) - focusX;

    pxPerSecRef.current = clampedNext;
    pendingScrollLeftRef.current = Math.max(0, newScrollLeftWanted);

    setPxPerSec(clampedNext);
  };

  // Synchronize scroll position BEFORE browser paint to prevent 1-frame jitter or jumping
  useLayoutEffect(() => {
    if (scrollRef.current) {
      const scroller = scrollRef.current;
      if (pendingScrollLeftRef.current !== null) {
        const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        const targetScrollLeft = Math.max(0, Math.min(maxLeft, pendingScrollLeftRef.current));
        scroller.scrollLeft = targetScrollLeft;
        setScrollState({
          scrollLeft: targetScrollLeft,
          viewportWidth: scroller.clientWidth || 1000,
        });
        pendingScrollLeftRef.current = null;
      } else {
        setScrollState({
          scrollLeft: scroller.scrollLeft,
          viewportWidth: scroller.clientWidth || 1000,
        });
      }
    }
  }, [pxPerSec]);

  // Non-passive wheel & gesture event listeners attached to root container (always present)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.style.touchAction = "none";
    el.style.overscrollBehavior = "contain";

    let lastScale = 1.0;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        e.stopPropagation();

        const base = 2;
        const speed = e.deltaMode === 1 ? 0.14 : 0.0065;
        let factor = Math.pow(base, -e.deltaY * speed * 4);
        factor = Math.max(0.2, Math.min(5, factor));

        applyZoomAt(pxPerSecRef.current * factor, e.clientX);
      }
    };

    const handleGestureStart = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      lastScale = 1.0;
    };

    const handleGestureChange = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.scale === "number" && e.scale > 0) {
        const deltaScale = e.scale / lastScale;
        lastScale = e.scale;
        applyZoomAt(pxPerSecRef.current * deltaScale, e.clientX);
      }
    };

    const handleGestureEnd = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      lastScale = 1.0;
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    el.addEventListener("gesturestart", handleGestureStart as any, { capture: true, passive: false });
    el.addEventListener("gesturechange", handleGestureChange as any, { capture: true, passive: false });
    el.addEventListener("gestureend", handleGestureEnd as any, { capture: true, passive: false });

    return () => {
      el.removeEventListener("wheel", handleWheel, { capture: true });
      el.removeEventListener("gesturestart", handleGestureStart as any, { capture: true });
      el.removeEventListener("gesturechange", handleGestureChange as any, { capture: true });
      el.removeEventListener("gestureend", handleGestureEnd as any, { capture: true });
    };
  }, []);

  const seekFromClientX = (clientX: number, commit = false) => {
    const bodyEl = timelineBodyRef.current;
    if (!bodyEl) return;
    const rect = bodyEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const seconds = Math.max(0, x / pxPerSec);
    setPlayheadSec(seconds);

    const now = Date.now();
    if (commit || now - lastSeekAt.current >= SEEK_THROTTLE_MS) {
      lastSeekAt.current = now;
      void transport.seek(seconds);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasSong) return;
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
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

  const onScrollSync = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTopY(e.currentTarget.scrollTop);
    setScrollState({
      scrollLeft: e.currentTarget.scrollLeft,
      viewportWidth: e.currentTarget.clientWidth,
    });
  };

  const peaksById = new Map((peaks?.tracks ?? []).map((t) => [t.id, t.peaks]));
  const trackCount = state.tracks.length;

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-default/30 bg-surface/60">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-default/30 px-3 py-1.5 bg-surface/80 z-20">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground/40">
          Timeline
          {song && (
            <span className="ml-2 font-normal lowercase text-foreground/25">
              {bpm.toFixed(1)} bpm · {tsNum}/{song.tsDen}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Zoom out"
            onPress={() => applyZoomAt(pxPerSec / 1.5)}
          >
            <ZoomOut size={14} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Zoom in"
            onPress={() => applyZoomAt(pxPerSec * 1.5)}
          >
            <ZoomIn size={14} />
          </Button>
        </div>
      </div>

      {!hasSong ? (
        <div className="flex h-full min-h-0 items-center justify-center text-sm text-foreground/40">
          No song selected
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Fixed Left Sidebar with Track Controls */}
          <div
            className="shrink-0 flex flex-col border-r border-default/30 bg-surface z-20 select-none"
            style={{ width: SIDEBAR_WIDTH }}
          >
            {/* Ruler spacer header */}
            <div
              className="shrink-0 border-b border-default/30 px-2.5 text-[10px] font-bold uppercase tracking-wider text-foreground/40 flex items-center bg-surface"
              style={{ height: RULER_HEIGHT }}
            >
              {bpm > 1 ? "BARS" : "TIME"}
            </div>
            {/* Event lane spacer */}
            <div
              className="shrink-0 border-b border-default/30 px-2.5 text-[9px] font-bold uppercase text-foreground/25 flex items-center bg-surface/40"
              style={{ height: EVENT_LANE_HEIGHT }}
            >
              Events
            </div>
            {/* Track controls list (scrolls vertically in sync with right timeline) */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <div style={{ transform: `translateY(-${scrollTopY}px)` }}>
                {trackCount === 0 ? (
                  <div className="flex h-20 items-center justify-center px-2 text-[10px] text-foreground/40">
                    No tracks
                  </div>
                ) : (
                  state.tracks.map((t, i) => (
                    <TrackHeaderControl
                      key={t.id}
                      track={t}
                      index={i}
                      color={TRACK_COLORS[i % TRACK_COLORS.length]}
                    />
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right Scrollable Timeline View (Horizontally & Vertically) */}
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-auto relative select-none cursor-col-resize focus:outline-none"
            onScroll={onScrollSync}
          >
            <div
              ref={timelineBodyRef}
              className="relative flex min-h-0 flex-col"
              style={{ width: contentWidth, minHeight: "100%" }}
            >
              {/* 1. Sticky Ruler Header (Stays fixed at top: 0 when scrolling tracks vertically) */}
              <div className="sticky top-0 z-20 bg-surface/95 shrink-0">
                <Ruler
                  pxPerSec={pxPerSec}
                  contentWidth={contentWidth}
                  songLength={songLength}
                  bpm={bpm}
                  tsNum={tsNum}
                />
              </div>

              {/* 2. Event Marker Lane */}
              <div
                className="relative shrink-0 border-b border-default/30 bg-surface/30"
                style={{ height: EVENT_LANE_HEIGHT }}
              >
                <div className="relative" style={{ width: contentWidth }}>
                  {events
                    .filter((e) => !e.triggerOnLoad)
                    .map((e) => {
                      const color = EVENT_COLORS[e.type] ?? "#8e8e93";
                      return (
                        <div
                          key={e.id}
                          className="absolute top-1 flex flex-col items-center"
                          style={{ left: e.timeSeconds * pxPerSec - 5 }}
                          title={`${e.id} (${e.type}) @ ${e.timeSeconds.toFixed(2)}s`}
                        >
                          <div className="h-3 w-px" style={{ background: color + "aa" }} />
                          <div
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: color }}
                          />
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* 3. Track Waveforms & Grid Container */}
              <div
                className="relative flex-1 touch-none select-none min-h-[120px]"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                {/* Beat/bar vertical grid canvas (Viewport Sliced) */}
                <BeatGrid
                  pxPerSec={pxPerSec}
                  contentWidth={contentWidth}
                  scrollLeft={scrollState.scrollLeft}
                  viewportWidth={scrollState.viewportWidth}
                  songLength={songLength}
                  bpm={bpm}
                  tsNum={tsNum}
                />

                {trackCount === 0 ? (
                  <div className="flex h-20 items-center justify-center text-sm text-foreground/40">
                    No tracks in this song.
                  </div>
                ) : (
                  state.tracks.map((t, i) => (
                    <TrackWaveformLane
                      key={t.id}
                      peaks={peaksById.get(t.id) ?? []}
                      contentWidth={contentWidth}
                      scrollLeft={scrollState.scrollLeft}
                      viewportWidth={scrollState.viewportWidth}
                      pxPerSec={pxPerSec}
                      color={TRACK_COLORS[i % TRACK_COLORS.length]}
                      muted={t.mute}
                    />
                  ))
                )}
              </div>

              {/* 4. Sticky Playhead (Handle badge sits stickily on Ruler, needle spans full height) */}
              <div
                className="pointer-events-none absolute top-0 z-30 flex flex-col items-center bottom-0"
                style={{
                  left: playheadSec * pxPerSec,
                  transform: "translateX(-50%)",
                }}
              >
                {/* Sticky Playhead Handle badge resting on Ruler */}
                <div
                  className="sticky top-0 z-30 pointer-events-auto flex flex-col items-center cursor-col-resize select-none -mt-0.5"
                  onPointerDown={onPointerDown}
                >
                  <div className="flex items-center justify-center rounded bg-danger px-1 py-0.5 text-[9px] font-mono font-bold text-white shadow-md">
                    {formatTimeShort(playheadSec)}
                  </div>
                  <div className="-mt-[3px] h-2 w-2 rotate-45 bg-danger" />
                </div>

                {/* Red playhead needle extending through the entire height */}
                <div className="flex-1 w-[1.5px] bg-danger shadow-[0_0_4px_rgba(255,59,48,0.6)]" />
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Beat/bar vertical grid lines drawn on a viewport-sliced canvas
function BeatGrid({
  pxPerSec,
  contentWidth,
  scrollLeft,
  viewportWidth,
  songLength,
  bpm,
  tsNum,
}: {
  pxPerSec: number;
  contentWidth: number;
  scrollLeft: number;
  viewportWidth: number;
  songLength: number;
  bpm: number;
  tsNum: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportWidth <= 0) return;
    const parent = canvas.parentElement;
    const height = parent ? parent.clientHeight : 300;

    const dpr = window.devicePixelRatio || 1;
    const renderWidth = Math.min(viewportWidth, contentWidth);
    canvas.width = Math.max(1, Math.floor(renderWidth * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${renderWidth}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, renderWidth, height);

    if (bpm > 1) {
      const beatSec = 60 / bpm;
      const barSec = beatSec * Math.max(1, tsNum);
      const eps = beatSec * 0.01;

      const startTime = Math.max(0, scrollLeft / pxPerSec);
      const endTime = Math.min(songLength + beatSec, (scrollLeft + viewportWidth) / pxPerSec);
      const startBeat = Math.floor(startTime / beatSec) * beatSec;

      for (let t = startBeat; t <= endTime; t += beatSec) {
        const globalX = Math.round(t * pxPerSec);
        const canvasX = globalX - scrollLeft;
        if (canvasX < 0 || canvasX > renderWidth) continue;

        const isBar =
          Math.abs(((t % barSec) + barSec) % barSec) < eps ||
          Math.abs(((t % barSec) + barSec) % barSec - barSec) < eps;
        ctx.strokeStyle = isBar ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(canvasX, 0);
        ctx.lineTo(canvasX, height);
        ctx.stroke();
      }
    }
  }, [pxPerSec, contentWidth, scrollLeft, viewportWidth, songLength, bpm, tsNum]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute top-0 z-0"
      style={{ left: scrollLeft }}
    />
  );
}
