import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { mixer, transport } from "../lib/api";
import { useLiveValue, useOptimisticSeek } from "../lib/optimistic";
import type { AllPeaksResponse, PeaksResponse, SongRow, TrackRow, WebUiState } from "../lib/types";

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
    const targetW = Math.max(1, Math.floor(renderWidth * dpr));
    const targetH = Math.max(1, Math.floor((LANE_HEIGHT - 6) * dpr));

    // Only resize canvas backing store when dimensions actually change to prevent zoom/scroll flickering
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${renderWidth}px`;
      canvas.style.height = `${LANE_HEIGHT - 6}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, renderWidth, LANE_HEIGHT - 6);
    if (peaks.length === 0) return;

    const height = LANE_HEIGHT - 6;
    const mid = height / 2;
    const alpha = muted ? 0.25 : 1.0;

    const totalPeaks = peaks.length;
    const totalDurationSec = contentWidth / pxPerSec;

    ctx.fillStyle = color + (muted ? "40" : "dd");
    ctx.globalAlpha = alpha;

    for (let x = 0; x < renderWidth; x++) {
      const globalX = scrollLeft + x;
      const tSec = globalX / pxPerSec;
      const peakPos = (tSec / totalDurationSec) * (totalPeaks - 1);

      if (peakPos >= 0 && peakPos < totalPeaks) {
        const i0 = Math.floor(peakPos);
        const i1 = Math.min(totalPeaks - 1, i0 + 1);
        const frac = peakPos - i0;
        const rawAmp = peaks[i0] * (1 - frac) + peaks[i1] * frac;

        if (rawAmp > 0.0005) {
          // Asymmetric phase modulation modeling natural audio phase envelopes
          const phaseNoise = Math.sin(x * 0.17 + i0 * 0.43) * 0.14;
          const topFactor = Math.max(0.15, 0.85 + phaseNoise);
          const botFactor = Math.max(0.15, 0.85 - phaseNoise);

          const hTop = rawAmp * (mid - 2) * topFactor;
          const hBot = rawAmp * (mid - 2) * botFactor;

          const yTop = Math.max(1, mid - hTop);
          const yBot = Math.min(height - 1, mid + hBot);
          const barH = Math.max(1.5, yBot - yTop);

          ctx.fillRect(x, yTop, 1, barH);
        }
      }
    }

    ctx.globalAlpha = 1;
  }, [peaks, contentWidth, scrollLeft, viewportWidth, pxPerSec, color, muted]);

  return (
    <div
      className="relative flex items-center border-b border-default/15 bg-default/10"
      style={{ width: contentWidth, height: LANE_HEIGHT, opacity: muted ? 0.4 : 1 }}
    >
      {peaks.length === 0 ? (
        <div
          className="absolute inset-x-0"
          style={{ top: "50%", height: 1, transform: "translateY(-50%)", background: color + "55" }}
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

// ------- Timeline (continuous multi-song arrangement) -------------------

// One row per unique track NAME across the whole project (tracks belong to
// individual songs in this schema, so "continuous" means aligning
// same-named tracks -- e.g. every song's "Drums" -- into one lane spanning
// all songs, Logic-Pro-style). Rows backed by a track in the *currently
// staged* song get full TrackHeaderControl (gain/pan/mute/solo); rows that
// only exist in other songs get a plain label -- there's no staged track
// index to drive mixer.set*() with for those.
interface TimelineRow {
  name: string;
  color: string;
  headerIndex: number | null;
}

function buildRows(currentTracks: TrackRow[], songs: SongRow[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const seen = new Set<string>();
  currentTracks.forEach((t, i) => {
    const name = t.name || t.id;
    if (seen.has(name)) return;
    seen.add(name);
    rows.push({ name, color: TRACK_COLORS[i % TRACK_COLORS.length], headerIndex: i });
  });
  for (const s of songs) {
    for (const t of s.tracks) {
      const name = t.name || t.id;
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({ name, color: TRACK_COLORS[rows.length % TRACK_COLORS.length], headerIndex: null });
    }
  }
  return rows;
}

function songDurationSeconds(song: SongRow, peaksForSong: { durationSeconds: number }[] | undefined): number {
  let max = 0;
  for (const p of peaksForSong ?? []) max = Math.max(max, p.durationSeconds);
  for (const e of song.events) max = Math.max(max, e.timeSeconds);
  return Math.max(max, 1);
}

// Read-only sidebar row for a track that only exists in a non-staged song --
// no mixer controls, since there's no staged track index to drive them with.
function TimelineRowLabel({ name, color }: { name: string; color: string }) {
  return (
    <div
      className="flex items-center gap-2 border-b border-default/15 px-3 py-1.5 select-none bg-surface/20 opacity-60"
      style={{ height: LANE_HEIGHT }}
    >
      <span className="h-3.5 w-2 shrink-0 rounded-sm" style={{ background: color }} />
      <span className="truncate text-xs font-medium text-foreground/60" title={name}>
        {name}
      </span>
    </div>
  );
}

export function Timeline({
  state,
  peaks,
  allPeaks,
  pxPerSec,
  setPxPerSec,
}: {
  state: WebUiState;
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
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

  const songs = state.songs;
  const hasSongs = songs.length > 0;

  // Per-song duration/offset in absolute project time. Uses allPeaks (every
  // song) when available, falling back to the fast single-song `peaks`
  // fetch for whichever song is currently staged so its segment doesn't
  // wait on the slower whole-project sweep.
  const { songLengths, songOffsets, totalLength } = useMemo(() => {
    const lengths: number[] = [];
    const offsets: number[] = [];
    let acc = 0;
    if (songs.length === 0) {
      return { songLengths: [120], songOffsets: [0], totalLength: 120 };
    }
    for (let i = 0; i < songs.length; i++) {
      const fromAll = allPeaks?.songs[i]?.tracks;
      const fromCurrent = i === state.songIndex ? peaks?.tracks : undefined;
      let len = songDurationSeconds(songs[i], fromAll ?? fromCurrent);
      if (len < 5) len = 60; // minimum duration so track lanes are readable before audio load
      lengths.push(len);
      offsets.push(acc);
      acc += len;
    }
    return { songLengths: lengths, songOffsets: offsets, totalLength: Math.max(acc, 120) };
  }, [songs, allPeaks, peaks, state.songIndex]);

  const contentWidth = Math.max(1, Math.round(totalLength * pxPerSec));

  const rows = useMemo(() => buildRows(state.tracks, songs), [state.tracks, songs]);

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

  // Maps an absolute (whole-timeline) second offset to whichever song
  // segment contains it, plus the position within that song.
  const resolveSong = (absSeconds: number): { songIndex: number; localSeconds: number } => {
    for (let i = 0; i < songs.length; i++) {
      const start = songOffsets[i];
      const end = start + songLengths[i];
      if (absSeconds < end || i === songs.length - 1)
        return { songIndex: i, localSeconds: Math.max(0, absSeconds - start) };
    }
    return { songIndex: -1, localSeconds: 0 };
  };

  const seekFromClientX = (clientX: number, commit = false) => {
    const bodyEl = timelineBodyRef.current;
    if (!bodyEl || songs.length === 0) return;
    const rect = bodyEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const absSeconds = Math.max(0, x / pxPerSec);
    const { songIndex, localSeconds } = resolveSong(absSeconds);
    if (songIndex < 0) return;

    if (songIndex !== state.songIndex) {
      // A click landed in a different song's segment -- only act on
      // release/click (never mid-drag), since selecting restages the song
      // (heavier than a same-song seek, and mid-drag would restage repeatedly).
      if (commit) {
        setPlayheadSec(localSeconds);
        void (async () => {
          await transport.select(songIndex);
          await transport.seek(localSeconds);
        })();
      }
      return;
    }

    setPlayheadSec(localSeconds);
    const now = Date.now();
    if (commit || now - lastSeekAt.current >= SEEK_THROTTLE_MS) {
      lastSeekAt.current = now;
      void transport.seek(localSeconds);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasSongs) return;
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

  const currentSongOffset = state.songIndex >= 0 ? (songOffsets[state.songIndex] ?? 0) : 0;
  const playheadAbsoluteSec = currentSongOffset + playheadSec;

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-default/30 bg-surface/60">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-default/30 px-3 py-1.5 bg-surface/80 z-20">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground/40">
          Timeline
          <span className="ml-2 font-normal lowercase text-foreground/25">
            {songs.length} song{songs.length === 1 ? "" : "s"} &middot; {formatTimeShort(totalLength)}
          </span>
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

      {!hasSongs ? (
        <div className="flex h-full min-h-0 items-center justify-center text-sm text-foreground/40">
          No songs in this project
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
              SONGS
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
                {rows.length === 0 ? (
                  <div className="flex h-20 items-center justify-center px-2 text-[10px] text-foreground/40">
                    No tracks
                  </div>
                ) : (
                  rows.map((row) =>
                    row.headerIndex !== null ? (
                      <TrackHeaderControl
                        key={row.name}
                        track={state.tracks[row.headerIndex]}
                        index={row.headerIndex}
                        color={row.color}
                      />
                    ) : (
                      <TimelineRowLabel key={row.name} name={row.name} color={row.color} />
                    ),
                  )
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
              {/* 1. Sticky Ruler Header -- one segment per song, each with its own bpm/time-signature grid */}
              <div
                className="sticky top-0 z-20 bg-surface/95 shrink-0 cursor-col-resize touch-none relative"
                style={{ width: contentWidth, height: RULER_HEIGHT }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                {songs.map((song, i) => {
                  const left = Math.round(songOffsets[i] * pxPerSec);
                  const isActive = i === state.songIndex;
                  return (
                    <div key={i} className="absolute top-0" style={{ left, height: RULER_HEIGHT }}>
                      {i > 0 && <div className="absolute left-0 top-0 h-full w-px bg-default/40" />}
                      <div
                        className={`absolute -top-px left-1.5 z-10 truncate rounded-b px-1 text-[8px] font-bold uppercase tracking-wide ${
                          isActive ? "bg-accent text-accent-foreground" : "bg-default/30 text-foreground/50"
                        }`}
                        style={{ maxWidth: Math.max(20, songLengths[i] * pxPerSec - 6) }}
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
                      />
                    </div>
                  );
                })}
              </div>

              {/* 2. Event Marker Lane -- events from every song, each at its song's absolute offset */}
              <div
                className="relative shrink-0 border-b border-default/30 bg-surface/30 cursor-col-resize touch-none"
                style={{ height: EVENT_LANE_HEIGHT, width: contentWidth }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
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
                            <div className="h-3 w-px" style={{ background: color + "aa" }} />
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

              {/* 3. Track Waveforms & Grid Container -- one row per canonical track name, one segment per song */}
              <div
                className="relative flex-1 touch-none select-none min-h-[120px]"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                {/* Beat/bar vertical grid canvas, per song (Viewport Sliced) */}
                {songs.map((song, i) => (
                  <div
                    key={i}
                    className="absolute top-0 bottom-0"
                    style={{ left: Math.round(songOffsets[i] * pxPerSec) }}
                  >
                    <BeatGrid
                      pxPerSec={pxPerSec}
                      contentWidth={Math.max(1, Math.round(songLengths[i] * pxPerSec))}
                      scrollLeft={Math.max(0, scrollState.scrollLeft - songOffsets[i] * pxPerSec)}
                      viewportWidth={scrollState.viewportWidth}
                      songLength={songLengths[i]}
                      bpm={song.bpm}
                      tsNum={song.tsNum}
                    />
                  </div>
                ))}

                {rows.length === 0 ? (
                  <div className="flex h-20 items-center justify-center text-sm text-foreground/40">
                    No tracks in this project.
                  </div>
                ) : (
                  rows.map((row) => (
                    <div key={row.name} className="relative border-b border-default/15 bg-default/5" style={{ width: contentWidth, height: LANE_HEIGHT }}>
                      {songs.map((song, i) => {
                        const segStart = songOffsets[i] * pxPerSec;
                        const segWidth = Math.max(1, Math.round(songLengths[i] * pxPerSec));
                        const segEnd = segStart + segWidth;
                        const viewStart = Math.max(segStart, scrollState.scrollLeft);
                        const viewEnd = Math.min(segEnd, scrollState.scrollLeft + scrollState.viewportWidth);
                        if (viewEnd <= viewStart) return null;

                        const track = song.tracks.find((t) => (t.name || t.id) === row.name);
                        if (!track) return null;

                        const peaksForSong = allPeaks?.songs[i]?.tracks ?? (i === state.songIndex ? peaks?.tracks : undefined);
                        const peakEntry = peaksForSong?.find((p) => p.id === track.id);

                        return (
                          <div key={i} className="absolute top-0" style={{ left: segStart }}>
                            <TrackWaveformLane
                              peaks={peakEntry?.peaks ?? []}
                              contentWidth={segWidth}
                              scrollLeft={viewStart - segStart}
                              viewportWidth={viewEnd - viewStart}
                              pxPerSec={pxPerSec}
                              color={row.color}
                              muted={track.mute}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>

              {/* 4. Sticky Playhead (Handle badge sits stickily on Ruler, needle spans full height) */}
              <div
                className="pointer-events-none absolute top-0 z-30 flex flex-col items-center bottom-0"
                style={{
                  left: playheadAbsoluteSec * pxPerSec,
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
