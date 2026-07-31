import { Button, Slider } from "@heroui/react";
import {
  Copy,
  Locate,
  LocateFixed,
  LocateOff,
  Magnet,
  MoveHorizontalIcon,
  MoveVerticalIcon,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  builder,
  fetchWaveformRaw,
  mixer,
  timelineHistory,
  transport,
} from "../lib/api";
import { useContinuousPlayhead, useLiveValue } from "../lib/optimistic";
import type {
  AllPeaksResponse,
  PeakLevelData,
  PeaksResponse,
  RegionRow,
  SectionRow,
  SongRow,
  TrackRow,
  WebUiState,
} from "../lib/types";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "./ContextMenu";
import { LevelMeterBar } from "./LevelMeterBar";

const SIDEBAR_WIDTH = 240;
const LANE_HEIGHT = 56;
const EVENT_LANE_HEIGHT = 24;
const SECTION_LANE_HEIGHT = 22;
const RULER_HEIGHT = 32;
const SECTION_PRESETS = ["Intro", "Verse", "Chorus", "Bridge", "Solo", "Outro"];
const MIN_PX_PER_SEC = 0.25; // allow zoom-out until whole set fits (no H-scroll)
const MAX_PX_PER_SEC = 400;
const TRACK_COLORS = [
  "#0091ff",
  "#30d158",
  "#ff9230",
  "#db34f2",
  "#ff375f",
  "#00d2e0",
  "#ff4245",
  "#6d7cff",
  "#00dac3",
  "#3cd3fe",
  "#ffd600",
  "#b78a66",
];

/** Edge hit zone width (fade / trim / loop / duration). */
const EDGE_PX = 12;

/** SVG fade triangle with curved edge driven by curve ∈ [-1, 1]. */
function FadeCurveOverlay({
  side,
  widthPx,
  heightPct,
  curve,
  color,
  readOnly,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  side: "in" | "out";
  widthPx: number;
  heightPct: number;
  curve: number;
  color: string;
  readOnly: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}) {
  const steps = 12;
  // Match engine: exp = 2^(-curve*2). +curve → ease-out, −curve → ease-in.
  const exp = Math.pow(2, -(curve || 0) * 2); // 4..0.25
  const pts: string[] = [];
  if (side === "in") {
    pts.push("0,100");
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const g = Math.pow(t, exp);
      pts.push(`${(t * 100).toFixed(1)},${(100 - g * 100).toFixed(1)}`);
    }
    pts.push("100,100");
  } else {
    pts.push("0,100");
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const g = Math.pow(1 - t, exp);
      pts.push(`${(t * 100).toFixed(1)},${(100 - g * 100).toFixed(1)}`);
    }
    pts.push("100,100");
  }
  return (
    <div
      className={`absolute top-0 bottom-0 ${side === "in" ? "left-0" : "right-0"} ${
        readOnly
          ? "pointer-events-none"
          : "pointer-events-auto cursor-ns-resize"
      }`}
      style={{ width: widthPx, height: `${heightPct}%` }}
      title={
        side === "in"
          ? "Drag vertically to reshape fade-in curve"
          : "Drag vertically to reshape fade-out curve"
      }
      onPointerDown={readOnly ? undefined : onPointerDown}
      onPointerMove={readOnly ? undefined : onPointerMove}
      onPointerUp={readOnly ? undefined : onPointerUp}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-full w-full pointer-events-none"
      >
        <polygon points={pts.join(" ")} fill={color} opacity={0.28} />
        <polyline
          points={pts.slice(1, -1).join(" ")}
          fill="none"
          stroke={color}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          opacity={0.85}
        />
      </svg>
    </div>
  );
}

// ── Region UI state (mute overlay; geometry lives in project RegionRow) ──
interface RegionUiState {
  muted: boolean;
}

/** Stable id for a project region block (selection + drag + mute). */
type RegionSelKey = string; // `${songIndex}:${regionId}`
const regionSelKey = (songIndex: number, regionId: string): RegionSelKey =>
  `${songIndex}:${regionId}`;

interface RegionClipboardEntry {
  songIndex: number;
  trackId: string;
  file: string;
  startSeconds: number;
  sourceOffsetSeconds: number;
  durationSeconds: number;
  gainDb: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}

function lookupRegion(
  songs: SongRow[],
  key: RegionSelKey,
): { songIndex: number; region: RegionRow } | null {
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const songIndex = Number(key.slice(0, colon));
  const regionId = key.slice(colon + 1);
  if (!Number.isFinite(songIndex) || songIndex < 0 || songIndex >= songs.length)
    return null;
  const region = songs[songIndex]?.regions?.find((r) => r.id === regionId);
  if (!region) return null;
  return { songIndex, region };
}

function allRegionSelKeys(songs: SongRow[]): RegionSelKey[] {
  const keys: RegionSelKey[] = [];
  songs.forEach((song, si) => {
    for (const r of song.regions ?? []) {
      if (r.file && r.id) keys.push(regionSelKey(si, r.id));
    }
  });
  return keys;
}

// ── Inline Toast ──────────────────────────────────────────────────────────
interface Toast {
  id: number;
  message: string;
}

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-default/40 bg-surface/95 backdrop-blur-md px-4 py-2.5 text-sm font-medium text-foreground shadow-2xl"
          style={{ animation: "fadeInUp 0.2s ease-out" }}
          onClick={() => onDismiss(t.id)}
        >
          <span className="h-2 w-2 rounded-full bg-warning shrink-0" />
          {t.message}
        </div>
      ))}
    </div>
  );
}

const EVENT_COLORS: Record<string, string> = {
  programChange: "#30d158",
  noteOn: "#30d158",
  noteOff: "#30d158",
  cc: "#0091ff",
  http: "#ff9230",
  dmx: "#db34f2",
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
    const next =
      Math.round(
        Math.max(min, Math.min(max, startValue.current + (dy / 100) * range)) *
          100,
      ) / 100;
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
      onDoubleClick={() => {
        setLocalValue(defaultValue);
        onCommit(defaultValue);
      }}
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
  defaultValue = 0,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  accent: string;
  onChange: (v: number) => void;
  defaultValue?: number;
}) {
  const percent = Math.max(
    0,
    Math.min(100, ((value - min) / (max - min)) * 100),
  );

  return (
    <div
      className="relative flex-1 flex items-center h-3 select-none touch-none"
      title="Double-click to reset"
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(defaultValue);
      }}
    >
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
  verticalZoom,
  anySolo = false,
}: {
  track: TrackRow;
  index: number;
  color: string;
  verticalZoom: number;
  anySolo?: boolean;
}) {
  const [gain, setGain] = useLiveValue(track.gainDb ?? 0, (v) =>
    mixer.setTrackGain(index, v),
  );
  const [pan, setPan] = useLiveValue(track.pan ?? 0, (v) =>
    mixer.setTrackPan(index, v),
  );

  const formatPan = (p: number) => {
    if (Math.abs(p) < 0.05) return "C";
    if (p < 0) return `L${Math.round(-p * 100)}`;
    return `R${Math.round(p * 100)}`;
  };

  const isDimmed = anySolo && !track.solo;

  return (
    <div
      className={`flex flex-col justify-between border-b border-default/15 px-3 py-1.5 select-none transition-opacity duration-300 bg-surface/40 hover:bg-surface/70 ${
        isDimmed ? "opacity-35" : "opacity-100"
      }`}
      style={{ height: Math.max(28, LANE_HEIGHT * verticalZoom) }}
    >
      {/* Top Row: Color indicator, Track Name, Pan Knob & Value, Mute & Solo */}
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="h-3.5 w-2 shrink-0 rounded-sm"
          style={{ background: color, opacity: track.mute ? 0.35 : 1 }}
        />
        <span
          className={`truncate text-xs font-semibold text-foreground/90 flex-1 min-w-0 ${
            track.mute ? "line-through opacity-40" : ""
          }`}
          title={track.name || track.id}
        >
          {track.name || track.id}
        </span>
        <div className="h-8 w-3 shrink-0">
          <LevelMeterBar
            db={track.peakDb ?? -100}
            dbL={track.peakDbL ?? track.peakDb ?? -100}
            dbR={track.peakDbR ?? track.peakDb ?? -100}
            accent={color}
            vertical
            showValue={false}
            barClassName="h-full w-1"
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {/* Rotary Knob for Pan Balance */}
          <div
            className="flex items-center gap-1"
            title={`Pan: ${formatPan(pan)}`}
          >
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

          {/* Mute Button -- blinks when soloed-out (same as mixer) */}
          <button
            type="button"
            onClick={() => mixer.setTrackMute(index, !track.mute)}
            className={`h-5.5 w-5.5 rounded text-[10px] font-bold transition-all shadow-sm ${
              track.mute
                ? "bg-danger text-white scale-105"
                : isDimmed
                  ? "bg-danger/80 text-white animate-pulse"
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
        <span className="shrink-0 text-foreground/40 text-[8px] uppercase tracking-wider font-semibold">
          Vol
        </span>
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
  // Majors: labels stay readable (~70px). Minors: denser grid as long as
  // strokes are ≥ ~4px apart — never collapse to majors-only until zoom-out
  // is extreme enough that even major/4 is too tight.
  const minPxPerLabel = 70;
  const minPxPerMinor = 4;

  /** Densest candidate ≤ major that still clears minPxPerMinor. */
  const pickMinor = (major: number, candidates: number[]) => {
    const sorted = [...candidates]
      .filter((s) => s > 0 && s <= major + 1e-12)
      .sort((a, b) => a - b);
    for (const c of sorted) {
      if (c * pxPerSec >= minPxPerMinor) return c;
    }
    return major;
  };

  if (bpm > 1) {
    const beatSec = 60 / bpm;
    const barSec = beatSec * Math.max(1, tsNum);
    let majorBarStep = 1;
    while (
      majorBarStep < 1_000_000 &&
      majorBarStep * barSec * pxPerSec < minPxPerLabel
    ) {
      majorBarStep *= 2;
    }
    const majorStepSec = majorBarStep * barSec;
    // Intermediate levels: beats, bars, 1/8…1/2 of major (always have mid lines).
    const minorStepSec = pickMinor(majorStepSec, [
      beatSec,
      barSec,
      majorStepSec / 8,
      majorStepSec / 4,
      majorStepSec / 2,
      majorStepSec,
    ]);
    return { majorStepSec, minorStepSec, isBeatGrid: true, barSec, beatSec };
  }

  const secList = [
    0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
    7200, 14400,
  ];
  let majorStepSec =
    secList.find((s) => s * pxPerSec >= minPxPerLabel) ??
    (() => {
      let s = 14400;
      while (s * pxPerSec < minPxPerLabel && s < 1e9) s *= 2;
      return s;
    })();
  const minorStepSec = pickMinor(majorStepSec, [
    majorStepSec / 10,
    majorStepSec / 8,
    majorStepSec / 6,
    majorStepSec / 5,
    majorStepSec / 4,
    majorStepSec / 2,
    majorStepSec,
  ]);
  return {
    majorStepSec,
    minorStepSec,
    isBeatGrid: false,
    barSec: 0,
    beatSec: 0,
  };
}

function getSnapInterval(pxPerSec: number, bpm: number, tsNum: number): number {
  if (bpm <= 0) return 1.0;
  const tc = getTickConfig(pxPerSec, bpm, tsNum);
  return tc.minorStepSec > 0 ? tc.minorStepSec : (60 / bpm);
}

function snapToGridSec(
  sec: number,
  pxPerSec: number,
  bpm: number,
  tsNum: number,
  snapEnabled: boolean,
): number {
  if (!snapEnabled || bpm <= 0) return sec;
  const interval = getSnapInterval(pxPerSec, bpm, tsNum);
  return Math.round(sec / interval) * interval;
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
  scrollLeft = 0,
  viewportWidth,
}: {
  pxPerSec: number;
  contentWidth: number;
  songLength: number;
  bpm: number;
  tsNum: number;
  /** Viewport-slice the tick loop the same way BeatGrid does -- without
   * this, generating marks from t=0 through the whole song, capped at a
   * fixed mark count, means a long song zoomed in far enough (minorStepSec
   * shrinks, so far more ticks are needed to reach the same song length)
   * exhausts the cap before ever reaching the marks that would fall to the
   * right of wherever the cap ran out -- the ruler and its labels just stop
   * rendering partway across. */
  scrollLeft?: number;
  viewportWidth?: number;
}) {
  const { majorStepSec, minorStepSec, isBeatGrid, barSec } = useMemo(
    () => getTickConfig(pxPerSec, bpm, tsNum),
    [pxPerSec, bpm, tsNum],
  );

  const marks = useMemo(() => {
    const list: { x: number; major: boolean; label?: string }[] = [];
    if (minorStepSec <= 0 || majorStepSec <= 0) return list;

    const startTime = Math.max(0, scrollLeft / pxPerSec);
    const endTime = Math.min(
      songLength + majorStepSec,
      viewportWidth != null
        ? (scrollLeft + viewportWidth) / pxPerSec + minorStepSec
        : songLength + majorStepSec,
    );
    const startTick = Math.floor(startTime / minorStepSec) * minorStepSec;

    // Hard cap so a bad step never floods the DOM -- viewport-slicing above
    // already bounds this to roughly one screen's worth of ticks, this is
    // just a safety net for a pathologically wide viewport.
    const maxMarks = 2000;
    let n = 0;

    for (let t = startTick; t <= endTime && n < maxMarks; t += minorStepSec) {
      const rounded = Math.round(t / minorStepSec) * minorStepSec;
      if (rounded < 0) continue;
      const x = Math.round(rounded * pxPerSec);
      if (x > contentWidth + 8) break;

      const phase = ((rounded % majorStepSec) + majorStepSec) % majorStepSec;
      const isMajor =
        phase < majorStepSec * 0.02 || phase > majorStepSec * 0.98;

      let label: string | undefined;
      if (isMajor) {
        if (isBeatGrid && barSec > 0) {
          const barNum = Math.round(rounded / barSec) + 1;
          // At coarse zoom majorStep is many bars — show bar number, not every bar.
          label = `${barNum}`;
        } else {
          label = formatTimeShort(rounded);
        }
      }
      list.push({ x, major: isMajor, label });
      n += 1;
    }
    return list;
  }, [
    pxPerSec,
    contentWidth,
    songLength,
    majorStepSec,
    minorStepSec,
    isBeatGrid,
    barSec,
    scrollLeft,
    viewportWidth,
  ]);

  return (
    <div
      className="relative select-none border-b border-default/30 bg-background-tertiary shrink-0"
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
              background: major
                ? "rgba(255,255,255,0.18)"
                : "rgba(255,255,255,0.06)",
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
                color: major
                  ? "rgba(255,255,255,0.38)"
                  : "rgba(255,255,255,0.18)",
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

// ------- Song Section Markers (Intro/Verse/Chorus/.../custom) -----------
//
// Point markers, not ranges -- the segment a marker covers is implicitly
// "from here to the next marker (or song end)", same convention as the
// native TimelineView.cpp's section-marker ruler this mirrors. Right-click
// empty lane space to add one at that time; right-click an existing marker
// to rename/delete it; drag a marker to reposition it (commits on release).

interface SectionMenuState {
  x: number;
  y: number;
  songIndex: number;
  startSeconds: number;
  /** Present only when the menu was opened on an existing marker. */
  sectionId?: string;
}

function SectionMarkerLane({
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  contentWidth,
  readOnly,
  snapToGrid = false,
}: {
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  contentWidth: number;
  readOnly: boolean;
  snapToGrid?: boolean;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<SectionMenuState | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // Drag bookkeeping (startX/origStart) lives in a ref -- doesn't need to
  // trigger renders. The live dragged position is state so the marker's
  // on-screen position actually updates as the pointer moves.
  const dragMetaRef = useRef<{
    songIndex: number;
    sectionId: string;
    startX: number;
    origStart: number;
  } | null>(null);
  const [liveDrag, setLiveDrag] = useState<{
    songIndex: number;
    sectionId: string;
    value: number;
  } | null>(null);

  const resolveSongAt = (
    absSeconds: number,
  ): { songIndex: number; localSeconds: number } => {
    for (let i = 0; i < songOffsets.length; i++) {
      const start = songOffsets[i];
      const end = start + songLengths[i];
      if (absSeconds < end || i === songOffsets.length - 1)
        return { songIndex: i, localSeconds: Math.max(0, absSeconds - start) };
    }
    return { songIndex: -1, localSeconds: 0 };
  };

  const openMenuAt = (
    e: React.MouseEvent,
    existing?: { songIndex: number; sectionId: string },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (readOnly) return;
    if (existing) {
      setMenu({
        x: e.clientX,
        y: e.clientY,
        songIndex: existing.songIndex,
        startSeconds: 0,
        sectionId: existing.sectionId,
      });
      return;
    }
    const rect = laneRef.current?.getBoundingClientRect();
    const absSeconds = rect
      ? Math.max(0, (e.clientX - rect.left) / pxPerSec)
      : 0;
    const { songIndex, localSeconds } = resolveSongAt(absSeconds);
    if (songIndex < 0) return;
    const song = songs[songIndex];
    const bpm = song?.bpm ?? 120;
    const tsNum = song?.tsNum ?? 4;
    const snappedLocal = snapToGridSec(localSeconds, pxPerSec, bpm, tsNum, snapToGrid);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      songIndex,
      startSeconds: snappedLocal,
    });
  };

  const closeMenu = () => {
    setMenu(null);
    setRenaming(false);
    setNameDraft("");
  };

  const applyPreset = (name: string) => {
    if (!menu) return;
    if (menu.sectionId) {
      void builder.sectionUpdate({
        songIndex: menu.songIndex,
        sectionId: menu.sectionId,
        name,
      });
    } else {
      void builder.sectionAdd(menu.songIndex, menu.startSeconds, name);
    }
    closeMenu();
  };

  const commitCustomName = () => {
    const name = nameDraft.trim();
    if (name.length > 0) applyPreset(name);
    else closeMenu();
  };

  const removeMarker = () => {
    if (!menu?.sectionId) return;
    void builder.sectionRemove(menu.songIndex, menu.sectionId);
    closeMenu();
  };

  const beginDrag = (
    e: React.PointerEvent,
    songIndex: number,
    sectionId: string,
    origStart: number,
  ) => {
    if (readOnly) return;
    e.stopPropagation();
    dragMetaRef.current = {
      songIndex,
      sectionId,
      startX: e.clientX,
      origStart,
    };
    setLiveDrag({ songIndex, sectionId, value: origStart });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const meta = dragMetaRef.current;
    if (!meta) return;
    const dSec = (e.clientX - meta.startX) / pxPerSec;
    const songLen = songLengths[meta.songIndex] ?? 0;
    const rawValue = Math.max(0, Math.min(songLen, meta.origStart + dSec));
    const song = songs[meta.songIndex];
    const bpm = song?.bpm ?? 120;
    const tsNum = song?.tsNum ?? 4;
    const value = snapToGridSec(rawValue, pxPerSec, bpm, tsNum, snapToGrid);
    setLiveDrag({
      songIndex: meta.songIndex,
      sectionId: meta.sectionId,
      value,
    });
  };
  const onDragEnd = (e: React.PointerEvent) => {
    const meta = dragMetaRef.current;
    dragMetaRef.current = null;
    if (!meta) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const finalValue = liveDrag?.value ?? meta.origStart;
    setLiveDrag(null);
    void builder.sectionUpdate({
      songIndex: meta.songIndex,
      sectionId: meta.sectionId,
      startSeconds: finalValue,
    });
  };

  return (
    <div
      ref={laneRef}
      className={`relative shrink-0 border-b border-default/30 bg-surface/20 touch-none ${
        readOnly ? "" : "cursor-context-menu"
      }`}
      style={{ height: SECTION_LANE_HEIGHT, width: contentWidth }}
      onContextMenu={(e) => openMenuAt(e)}
    >
      {songs.map((song, i) =>
        (song.sections ?? []).map((sec: SectionRow) => {
          const isDragging =
            liveDrag?.songIndex === i && liveDrag?.sectionId === sec.id;
          const startSeconds = isDragging ? liveDrag!.value : sec.startSeconds;
          const left = (songOffsets[i] + startSeconds) * pxPerSec;
          const color = TRACK_COLORS[sec.colorIndex % TRACK_COLORS.length];
          return (
            <div
              key={`${i}:${sec.id}`}
              className="absolute top-0 bottom-0 flex items-center"
              style={{ left, cursor: readOnly ? "default" : "ew-resize" }}
              title={`${sec.name} @ ${formatTimeShort(sec.startSeconds)}${readOnly ? "" : " (drag to move, right-click to edit)"}`}
              onPointerDown={(e) => beginDrag(e, i, sec.id, sec.startSeconds)}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onContextMenu={(e) =>
                openMenuAt(e, { songIndex: i, sectionId: sec.id })
              }
            >
              <div className="h-full w-px" style={{ background: color }} />
              <div
                className="ml-0.5 truncate rounded px-1 py-0.5 text-[9px] font-semibold leading-none"
                style={{ background: color + "33", color }}
              >
                {sec.name}
              </div>
            </div>
          );
        }),
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} width={168} onClose={closeMenu}>
          {renaming ? (
            <form
              className="px-2 py-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                commitCustomName();
              }}
            >
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeMenu();
                }}
                placeholder="Section name"
                className="w-full rounded border border-default/40 bg-default/20 px-1.5 py-1 text-xs text-foreground focus:outline-none"
              />
            </form>
          ) : (
            <>
              {SECTION_PRESETS.map((p) => (
                <ContextMenuItem key={p} onClick={() => applyPreset(p)}>
                  {p}
                </ContextMenuItem>
              ))}
              <ContextMenuItem
                onClick={() => {
                  setNameDraft("");
                  setRenaming(true);
                }}
              >
                Custom...
              </ContextMenuItem>
              {menu.sectionId && (
                <>
                  <ContextMenuDivider />
                  <ContextMenuItem danger onClick={removeMarker}>
                    Delete Marker
                  </ContextMenuItem>
                </>
              )}
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
}

// ------- Viewport-based Hardware-Accelerated Smooth Waveform Canvas -----------
//
// Reaper/Logic-style rendering: picks the pyramid level whose bin duration
// is the closest match to the current zoom (samples-per-pixel) and draws a
// filled min/max envelope with an RMS "loudness" band on top. Past the
// finest cached level (extreme zoom-in, where a pixel covers less time than
// one bin), switches to fetching the true raw sample window on demand and
// drawing a cubic-Hermite-interpolated curve through it -- see
// PeakOverview.h/api.ts's fetchWaveformRaw for why this isn't just another,
// finer pyramid level.

// Coarsest level whose bins are still <= one pixel's worth of time (most
// detail available without going finer than the zoom needs). Returns null
// when even the finest cached level is coarser than the zoom needs, which
// means the caller should fall back to a raw-sample fetch instead.
function pickLevelForZoom(
  levels: PeakLevelData[],
  durationSeconds: number,
  pxPerSec: number,
): PeakLevelData | null {
  if (levels.length === 0 || durationSeconds <= 0 || pxPerSec <= 0) return null;
  const pixelDurationSec = 1 / pxPerSec;
  const finestBins = levels[0].min.length || 1;
  if (durationSeconds / finestBins > pixelDurationSec) return null;
  let best = levels[0];
  for (const level of levels) {
    const bins = level.min.length || 1;
    if (durationSeconds / bins <= pixelDurationSec) best = level;
    else break;
  }
  return best;
}

function cubicHermite(
  y0: number,
  y1: number,
  y2: number,
  y3: number,
  mu: number,
): number {
  const mu2 = mu * mu;
  const a0 = y3 - y2 - y0 + y1;
  const a1 = y0 - y1 - a0;
  const a2 = y2 - y0;
  const a3 = y1;
  return a0 * mu * mu2 + a1 * mu2 + a2 * mu + a3;
}

function TrackWaveformLane({
  levels,
  durationSeconds,
  regionFile,
  gestureActive,
  verticalZoom,
  contentWidth,
  scrollLeft,
  viewportWidth,
  pxPerSec,
  color,
  muted,
  /** Offset into the source file (region trim / split). */
  sourceOffsetSec = 0,
  /** When true, no lane chrome — meant to sit inside a clipped region. */
  embedded = false,
  loop = false,
  loopLengthSec = 0,
}: {
  levels: PeakLevelData[];
  durationSeconds: number;
  regionFile?: string;
  gestureActive: boolean;
  verticalZoom: number;
  contentWidth: number;
  scrollLeft: number;
  viewportWidth: number;
  pxPerSec: number;
  color: string;
  muted: boolean;
  sourceOffsetSec?: number;
  embedded?: boolean;
  loop?: boolean;
  loopLengthSec?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rawWindow, setRawWindow] = useState<{
    sampleRate: number;
    startSec: number;
    samples: number[];
  } | null>(null);

  const needsRaw =
    pickLevelForZoom(levels, durationSeconds, pxPerSec) === null &&
    levels.length > 0;

  // Quantize the fetch range so panning by a pixel at a time doesn't refire
  // a network request every frame -- half-second buckets with a half-second
  // margin on each side comfortably cover a viewport's worth of scrolling
  // between refetches. Times are in *source file* seconds.
  const visibleStartSec = sourceOffsetSec + scrollLeft / pxPerSec;
  const visibleEndSec =
    sourceOffsetSec + (scrollLeft + viewportWidth) / pxPerSec;
  const quantStart = Math.max(0, Math.floor(visibleStartSec / 0.5) * 0.5 - 0.5);
  const quantEnd = Math.min(
    durationSeconds,
    Math.ceil(visibleEndSec / 0.5) * 0.5 + 0.5,
  );

  useEffect(() => {
    if (!needsRaw || !regionFile || gestureActive || quantEnd <= quantStart)
      return;
    let cancelled = false;
    const endSec = Math.min(quantEnd, quantStart + 9); // stay under the server's window cap
    fetchWaveformRaw(regionFile, quantStart, endSec)
      .then((res) => {
        if (!cancelled && res.samples.length > 0) setRawWindow(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRaw, regionFile, gestureActive, quantStart, quantEnd]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportWidth <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const renderWidth = Math.min(viewportWidth, contentWidth);
    const laneH = Math.max(20, Math.round(LANE_HEIGHT * verticalZoom));
    const targetW = Math.max(1, Math.floor(renderWidth * dpr));
    const targetH = Math.max(1, Math.floor((laneH - 6) * dpr));

    // Only resize canvas backing store when dimensions actually change to prevent zoom/scroll flickering
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${renderWidth}px`;
      canvas.style.height = `${laneH - 6}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, renderWidth, laneH - 6);
    if (levels.length === 0 || durationSeconds <= 0) return;

    const height = laneH - 6;
    const mid = height / 2;
    const halfH = Math.max(1, height / 2 - 2);
    const alpha = muted ? 0.35 : 1.0;
    ctx.globalAlpha = alpha;

    const isRawActive = needsRaw && rawWindow && rawWindow.samples.length > 1;
    const level =
      pickLevelForZoom(levels, durationSeconds, pxPerSec) ?? levels[0];

    if (level && !isRawActive) {
      const bins = level.min.length;
      const step = gestureActive
        ? Math.max(1, Math.floor(renderWidth / 200))
        : 1;

      // Build 1:1 aligned top and bottom vertices with range aggregation
      const topPoints: { x: number; y: number }[] = [];
      const botPoints: { x: number; y: number }[] = [];
      const rmsTopPoints: { x: number; y: number }[] = [];
      const rmsBotPoints: { x: number; y: number }[] = [];

      const availSec = Math.max(0.01, durationSeconds - sourceOffsetSec);
      const cycleSec = (loopLengthSec && loopLengthSec > 0)
        ? loopLengthSec
        : availSec;

      for (let x = 0; x <= renderWidth; x += step) {
        // Map lane-local time → source-file time (honours region trim/split & loop).
        const intoSecStart = (scrollLeft + x) / pxPerSec;
        const intoSecEnd = (scrollLeft + x + step) / pxPerSec;

        let tStartSec = sourceOffsetSec + intoSecStart;
        let tEndSec = sourceOffsetSec + intoSecEnd;

        if (loop && cycleSec > 0) {
          let mStart = intoSecStart % cycleSec;
          if (mStart < 0) mStart += cycleSec;
          tStartSec = sourceOffsetSec + mStart;

          let mEnd = intoSecEnd % cycleSec;
          if (mEnd < 0) mEnd += cycleSec;
          tEndSec = sourceOffsetSec + mEnd;
        }

        const startBin = Math.max(
          0,
          Math.min(bins - 1, Math.floor((tStartSec / durationSeconds) * bins)),
        );
        const endBin = Math.max(
          startBin,
          Math.min(bins - 1, Math.floor((tEndSec / durationSeconds) * bins)),
        );

        let maxV = -1;
        let minV = 1;
        let rmsV = 0;

        if (startBin === endBin) {
          maxV = level.max[startBin] ?? 0;
          minV = level.min[startBin] ?? 0;
          rmsV = level.rms[startBin] ?? 0;
        } else {
          for (let b = startBin; b <= endBin; ++b) {
            const mx = level.max[b] ?? 0;
            const mn = level.min[b] ?? 0;
            const rm = level.rms[b] ?? 0;
            if (maxV === -1 || mx > maxV) maxV = mx;
            if (minV === 1 || mn < minV) minV = mn;
            if (rm > rmsV) rmsV = rm;
          }
        }

        if (maxV === -1) maxV = 0;
        if (minV === 1) minV = 0;

        // Past the end of the source file (non-loop only): draw silence so trimmed tails stay flat.
        if (!loop && tStartSec >= durationSeconds) {
          maxV = 0;
          minV = 0;
          rmsV = 0;
        }

        const yTop = mid - maxV * halfH * verticalZoom;
        const yBot = mid - minV * halfH * verticalZoom;
        topPoints.push({ x, y: yTop });
        botPoints.push({ x, y: yBot });

        const rmsH = rmsV * halfH * verticalZoom;
        rmsTopPoints.push({ x, y: mid - rmsH });
        rmsBotPoints.push({ x, y: mid + rmsH });
      }

      // Outer Peak Envelope Path (continuous smooth contour)
      if (topPoints.length > 0) {
        ctx.beginPath();
        ctx.moveTo(topPoints[0].x, topPoints[0].y);
        for (let i = 1; i < topPoints.length; ++i) {
          ctx.lineTo(topPoints[i].x, topPoints[i].y);
        }
        for (let i = botPoints.length - 1; i >= 0; --i) {
          ctx.lineTo(botPoints[i].x, botPoints[i].y);
        }
        ctx.closePath();

        // Soft crisp gradient fill
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, color + "aa");
        grad.addColorStop(0.5, color + "77");
        grad.addColorStop(1, color + "aa");
        ctx.fillStyle = grad;
        ctx.fill();

        // Sharp outer contour line
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // RMS Core Fill
      if (rmsTopPoints.length > 0) {
        ctx.beginPath();
        ctx.moveTo(rmsTopPoints[0].x, rmsTopPoints[0].y);
        for (let i = 1; i < rmsTopPoints.length; ++i) {
          ctx.lineTo(rmsTopPoints[i].x, rmsTopPoints[i].y);
        }
        for (let i = rmsBotPoints.length - 1; i >= 0; --i) {
          ctx.lineTo(rmsBotPoints[i].x, rmsBotPoints[i].y);
        }
        ctx.closePath();
        ctx.fillStyle = color + "ee";
        ctx.fill();
      }
    }

    // Extreme zoom: true per-sample curve through the fetched raw window
    if (isRawActive && rawWindow) {
      const windowEndSec =
        rawWindow.startSec + rawWindow.samples.length / rawWindow.sampleRate;
      if (
        rawWindow.startSec <= visibleStartSec + 1e-6 &&
        windowEndSec >= visibleEndSec - 1e-6
      ) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        const { samples, sampleRate, startSec } = rawWindow;
        let first = true;
        for (let x = 0; x < renderWidth; ++x) {
          const tSec = sourceOffsetSec + (scrollLeft + x) / pxPerSec;
          const exactIdx = (tSec - startSec) * sampleRate;
          const baseIdx = Math.floor(exactIdx);
          const mu = exactIdx - baseIdx;
          const y0 = samples[baseIdx - 1] ?? samples[0] ?? 0;
          const y1 = samples[baseIdx] ?? 0;
          const y2 = samples[baseIdx + 1] ?? samples[samples.length - 1] ?? 0;
          const y3 = samples[baseIdx + 2] ?? samples[samples.length - 1] ?? 0;
          const v = cubicHermite(y0, y1, y2, y3, mu);
          const y = mid - v * halfH * verticalZoom;
          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
  }, [
    levels,
    durationSeconds,
    needsRaw,
    rawWindow,
    gestureActive,
    verticalZoom,
    contentWidth,
    scrollLeft,
    viewportWidth,
    pxPerSec,
    color,
    muted,
    sourceOffsetSec,
    visibleStartSec,
    visibleEndSec,
  ]);

  return (
    <div
      className={
        embedded
          ? "pointer-events-none absolute inset-0 flex items-center"
          : "relative flex items-center border-b border-default/15 bg-default/10"
      }
      style={
        embedded
          ? { opacity: muted ? 0.4 : 1 }
          : {
              width: contentWidth,
              height: LANE_HEIGHT * verticalZoom,
              opacity: muted ? 0.4 : 1,
            }
      }
    >
      {levels.length === 0 ? (
        <div
          className="absolute inset-x-0"
          style={{
            top: "50%",
            height: 1,
            transform: "translateY(-50%)",
            background: color + "55",
          }}
        />
      ) : (
        <canvas
          ref={canvasRef}
          className={
            embedded
              ? "pointer-events-none absolute transition-opacity duration-300 ease-out"
              : "pointer-events-none absolute top-1 transition-opacity duration-300 ease-out"
          }
          style={
            embedded
              ? {
                  left: scrollLeft,
                  top: "50%",
                  transform: "translateY(-50%)",
                }
              : { left: scrollLeft }
          }
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
  const trackIdToRowName = new Map<string, string>();
  currentTracks.forEach((t, i) => {
    const name = t.name || t.id;
    if (seen.has(name)) return;
    seen.add(name);
    trackIdToRowName.set(t.id, name);
    rows.push({
      name,
      color: TRACK_COLORS[i % TRACK_COLORS.length],
      headerIndex: i,
    });
  });
  for (const s of songs) {
    for (const r of s.regions ?? []) {
      const name = trackIdToRowName.get(r.trackId) ?? r.trackId;
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({
        name,
        color: TRACK_COLORS[rows.length % TRACK_COLORS.length],
        headerIndex: null,
      });
    }
  }
  return rows;
}

function songDurationSeconds(
  song: SongRow,
  peaksForSong:
    | { id: string; trackId?: string; durationSeconds: number }[]
    | undefined,
): number {
  let max = 0;
  for (const r of song.regions ?? []) {
    if (r.durationSeconds) max = Math.max(max, r.durationSeconds);
  }
  for (const p of peaksForSong ?? []) {
    if (p.durationSeconds) max = Math.max(max, p.durationSeconds);
  }
  for (const e of song.events) {
    if (e.timeSeconds) max = Math.max(max, e.timeSeconds);
  }
  return Math.max(max, 1);
}

// Read-only sidebar row for a track that only exists in a non-staged song --
// no mixer controls, since there's no staged track index to drive them with.
function TimelineRowLabel({
  name,
  color,
  verticalZoom,
}: {
  name: string;
  color: string;
  verticalZoom: number;
}) {
  return (
    <div
      className="flex items-center gap-2 border-b border-default/15 px-3 py-1.5 select-none bg-surface/20 opacity-60"
      style={{ height: LANE_HEIGHT * verticalZoom }}
    >
      <span
        className="h-3.5 w-2 shrink-0 rounded-sm"
        style={{ background: color }}
      />
      <span
        className="truncate text-xs font-medium text-foreground/60"
        title={name}
      >
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
  readOnly = false,
}: {
  state: WebUiState;
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
  /** Player: no track sidebar, no region trim/edit. */
  readOnly?: boolean;
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
  const [scrollState, setScrollState] = useState({
    scrollLeft: 0,
    viewportWidth: 1000,
  });

  // ONE continuous absolute clock for the whole project. Song-local time is
  // derived below -- never a second independent rAF loop keyed on songIndex
  // (that reset/fought across gapless boundaries and felt like two timelines).
  const [playheadAbsoluteSec, setPlayheadAbsoluteSec] = useContinuousPlayhead(
    state.globalPlayheadSeconds,
    state.playing,
    state.projectName,
  );

  // Snap-to-grid toggle
  const [snapToGrid, setSnapToGrid] = useState(true);

  // Playhead autofollow: off (never auto-scroll) / snap (jump once the
  // playhead nears the viewport edge -- the original, only prior behavior)
  // / smooth (continuously re-anchor every frame so the view glides along
  // with playback instead of jumping). Persisted across sessions since it's
  // a per-user viewing preference, not project data.
  type FollowMode = "off" | "snap" | "smooth";
  const [followMode, setFollowMode] = useState<FollowMode>(() => {
    try {
      const saved = localStorage.getItem("resostage.timeline.followMode");
      if (saved === "off" || saved === "snap" || saved === "smooth") return saved;
    } catch {
      // localStorage unavailable (e.g. private mode) -- fall through to default
    }
    return "snap";
  });
  useEffect(() => {
    try {
      localStorage.setItem("resostage.timeline.followMode", followMode);
    } catch {
      // best-effort persistence only
    }
  }, [followMode]);
  const cycleFollowMode = () =>
    setFollowMode((m) => (m === "off" ? "snap" : m === "snap" ? "smooth" : "off"));

  // Progressive rendering: track gesture activity for coarse→fine rendering
  const [gestureActive, setGestureActive] = useState(false);
  const gestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Plain ref, set SYNCHRONOUSLY in the same tick as the wheel/pinch handler
  // -- the smooth-follow rAF loop reads THIS, not a ref mirroring the
  // `gestureActive` React state below. That mirror only updates on the NEXT
  // render, and requestAnimationFrame callbacks are scheduled independently
  // of React's render/commit timing: if the loop's tick() ran in the single
  // frame between the wheel event firing and React's batched update
  // flushing, it would still see stale (false) and write scrollLeft for the
  // OLD playhead-anchor target at the exact moment applyZoomAt's own
  // zoom-focus effect was ALSO writing scrollLeft for the NEW zoom target --
  // a one-frame tug-of-war between the two, which is what made the playhead
  // visibly jump during a zoom gesture while autofollowing.
  const gestureActiveNowRef = useRef(false);
  const markGestureActiveRef = useRef(() => {
    gestureActiveNowRef.current = true;
    setGestureActive(true);
    if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
    gestureTimerRef.current = setTimeout(() => {
      gestureActiveNowRef.current = false;
      setGestureActive(false);
    }, 250);
  });
  // Set right before the auto-follow effect (or the zoom-focus effect)
  // writes scroller.scrollLeft programmatically -- onScrollSync checks this
  // to tell "we just scrolled ourselves" apart from a real user drag/wheel/
  // scrollbar interaction. Native `scroll` events fire for BOTH; without
  // this, continuous "smooth" auto-follow (writing scrollLeft every frame)
  // kept re-triggering markGestureActiveRef on its own scroll events, so its
  // 250ms settle timer never got a chance to fire and gestureActive was
  // permanently stuck true during autofollow -- pinning every waveform to
  // coarse/low-detail rendering (see WaveformLane's `gestureActive` checks)
  // AND making onScrollSync's own setScrollState fight the auto-follow
  // effect's synchronous one every frame (their async native-event timing
  // vs. the effect's synchronous write don't line up), both of which read as
  // constant waveform/playhead jitter.
  const programmaticScrollRef = useRef(false);

  // Vertical zoom (buttons, not gestures)
  const [verticalZoom, setVerticalZoom] = useState(1.0);

  // Toast notifications
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastCounterRef = useRef(0);
  const showToast = (message: string) => {
    const id = ++toastCounterRef.current;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      3500,
    );
  };

  // Region selection (editor only) for copy/delete/duplicate hotkeys.
  const [selectedRegionKeys, setSelectedRegionKeys] = useState<RegionSelKey[]>(
    [],
  );
  const clipboardRegions = useRef<RegionClipboardEntry[]>([]);

  const selectRegion = (
    key: RegionSelKey,
    e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ) => {
    if (e.metaKey || e.ctrlKey) {
      setSelectedRegionKeys((prev) =>
        prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key],
      );
      return;
    }
    if (e.shiftKey && selectedRegionKeys.length > 0) {
      const all = allRegionSelKeys(state.songs);
      const last = selectedRegionKeys[selectedRegionKeys.length - 1];
      const a = all.indexOf(last);
      const b = all.indexOf(key);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        setSelectedRegionKeys(all.slice(lo, hi + 1));
        return;
      }
    }
    setSelectedRegionKeys([key]);
  };

  const resolveSelectedRegions = (): RegionClipboardEntry[] => {
    const out: RegionClipboardEntry[] = [];
    for (const key of selectedRegionKeys) {
      const hit = lookupRegion(state.songs, key);
      if (!hit) continue;
      const r = hit.region;
      out.push({
        songIndex: hit.songIndex,
        trackId: r.trackId,
        file: r.file,
        startSeconds: r.startSeconds,
        sourceOffsetSeconds: r.sourceOffsetSeconds,
        durationSeconds: r.durationSeconds,
        gainDb: r.gainDb,
        fadeInSeconds: r.fadeInSeconds,
        fadeOutSeconds: r.fadeOutSeconds,
      });
    }
    return out;
  };

  const copySelectedRegions = () => {
    clipboardRegions.current = resolveSelectedRegions();
    if (clipboardRegions.current.length)
      showToast(`Copied ${clipboardRegions.current.length} region(s)`);
  };

  const deleteSelectedRegions = () => {
    if (selectedRegionKeys.length === 0) return;
    // Shared gestureId so the backend's undo history collapses this
    // multi-region delete into ONE undo step instead of N.
    const gestureId = crypto.randomUUID();
    for (const key of selectedRegionKeys) {
      const hit = lookupRegion(state.songs, key);
      if (hit) void builder.regionRemove(hit.songIndex, hit.region.id, gestureId);
    }
    setSelectedRegionKeys([]);
    showToast("Deleted region(s)");
  };

  const duplicateSelectedRegions = async () => {
    const entries = resolveSelectedRegions();
    const gestureId = crypto.randomUUID();
    for (const r of entries) {
      await builder.regionAdd({
        songIndex: r.songIndex,
        trackId: r.trackId,
        file: r.file,
        startSeconds: r.startSeconds,
        sourceOffsetSeconds: r.sourceOffsetSeconds,
        durationSeconds: r.durationSeconds,
        gainDb: r.gainDb,
        fadeInSeconds: r.fadeInSeconds,
        fadeOutSeconds: r.fadeOutSeconds,
        gestureId,
      });
    }
    if (entries.length) showToast(`Duplicated ${entries.length} region(s)`);
  };

  const pasteClipboardRegions = async () => {
    if (clipboardRegions.current.length === 0) return;
    const gestureId = crypto.randomUUID();
    for (const r of clipboardRegions.current) {
      await builder.regionAdd({
        songIndex: r.songIndex,
        trackId: r.trackId,
        file: r.file,
        startSeconds: r.startSeconds,
        sourceOffsetSeconds: r.sourceOffsetSeconds,
        durationSeconds: r.durationSeconds,
        gainDb: r.gainDb,
        fadeInSeconds: r.fadeInSeconds,
        fadeOutSeconds: r.fadeOutSeconds,
        gestureId,
      });
    }
    showToast(`Pasted ${clipboardRegions.current.length} region(s)`);
  };

  // Drop selection entries that no longer exist (delete / project reload).
  useEffect(() => {
    const valid = new Set(allRegionSelKeys(state.songs));
    setSelectedRegionKeys((prev) => {
      const next = prev.filter((k) => valid.has(k));
      return next.length === prev.length ? prev : next;
    });
  }, [state.songs]);

  // Region UI state (mute); geometry is project-owned
  const [regions, setRegions] = useState<Map<RegionSelKey, RegionUiState>>(
    new Map(),
  );

  const [regionContextMenu, setRegionContextMenu] = useState<{
    x: number;
    y: number;
    songIndex: number;
    regionId: string;
    selKey: RegionSelKey;
  } | null>(null);

  // Live geometry while dragging (committed to project on pointer up).
  // Kept until live state.songs catches up — REST returns before the
  // engine applies the update, so clearing the draft in .finally() caused
  // a one-frame snap-back to the old size.
  const [regionGeomDraft, setRegionGeomDraft] = useState<
    Record<
      RegionSelKey,
      {
        start: number;
        sourceOffset: number;
        duration: number;
        fadeIn?: number;
        fadeOut?: number;
        fadeInCurve?: number;
        fadeOutCurve?: number;
        loop?: boolean;
        loopLengthSeconds?: number;
      }
    >
  >({});
  const regionGeomDraftRef = useRef(regionGeomDraft);
  regionGeomDraftRef.current = regionGeomDraft;

  // Drop draft once project state reflects it (or the region vanished).
  useEffect(() => {
    const drafts = regionGeomDraftRef.current;
    const keys = Object.keys(drafts) as RegionSelKey[];
    if (keys.length === 0) return;
    const eps = 0.02;
    setRegionGeomDraft((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next) as RegionSelKey[]) {
        const d = next[key];
        const hit = lookupRegion(state.songs, key);
        if (!hit) {
          delete next[key];
          changed = true;
          continue;
        }
        const r = hit.region;
        const dur =
          r.durationSeconds > 0
            ? r.durationSeconds
            : Math.max(0.05, d.duration);
        const matches =
          Math.abs(r.startSeconds - d.start) < eps &&
          Math.abs(r.sourceOffsetSeconds - d.sourceOffset) < eps &&
          Math.abs(dur - d.duration) < eps &&
          (d.fadeIn === undefined ||
            Math.abs((r.fadeInSeconds ?? 0) - d.fadeIn) < eps) &&
          (d.fadeOut === undefined ||
            Math.abs((r.fadeOutSeconds ?? 0) - d.fadeOut) < eps) &&
          (d.fadeInCurve === undefined ||
            Math.abs((r.fadeInCurve ?? 0) - d.fadeInCurve) < 0.05) &&
          (d.fadeOutCurve === undefined ||
            Math.abs((r.fadeOutCurve ?? 0) - d.fadeOutCurve) < 0.05) &&
          (d.loop === undefined || Boolean(r.loop) === Boolean(d.loop));
        if (matches) {
          delete next[key];
          changed = true;
        }
      }
      if (!changed) return prev;
      regionGeomDraftRef.current = next;
      return next;
    });
  }, [state.songs]);

  // Region drag state — keyed by selection id, stores project geometry
  type RegionDragMode =
    | "move"
    | "trimStart" // left center/bottom: extend left into earlier source
    | "trimEnd" // right bottom: set timeline duration
    | "loopTrim" // right upper-middle: Logic Pro loop stretch handle
    | "fadeIn" // left top
    | "fadeOut" // right top
    | "fadeInCurve"
    | "fadeOutCurve";
  type RegionGeom = {
    start: number;
    sourceOffset: number;
    duration: number;
    fadeIn: number;
    fadeOut: number;
    fadeInCurve: number;
    fadeOutCurve: number;
    loop: boolean;
    loopLengthSeconds?: number;
  };
  const regionDragRef = useRef<{
    key: RegionSelKey;
    mode: RegionDragMode;
    startX: number;
    startY: number;
    songIndex: number;
    regionId: string;
    origStart: number;
    origSourceOffset: number;
    origDuration: number;
    origFadeIn: number;
    origFadeOut: number;
    origFadeInCurve: number;
    origFadeOutCurve: number;
    origLoop: boolean;
    origLoopLength: number;
    maxEnd: number; // song length
    /** Remaining source length from sourceOffset (fileDuration - offset). */
    maxSourceDur: number;
    /** Last live geometry during drag (committed on pointer up). */
    lastGeom: RegionGeom;
  } | null>(null);

  const writeGeomDraft = (key: RegionSelKey, geom: RegionGeom) => {
    // Sync ref immediately so pointer-up in the same frame sees the value
    // (setState alone would lag one render and drop the resize).
    const next = { ...regionGeomDraftRef.current, [key]: geom };
    regionGeomDraftRef.current = next;
    setRegionGeomDraft(next);
    if (regionDragRef.current?.key === key) {
      regionDragRef.current.lastGeom = geom;
    }
  };

  const getRegionUi = (key: RegionSelKey): RegionUiState =>
    regions.get(key) ?? { muted: false };

  const setRegionUi = (key: RegionSelKey, patch: Partial<RegionUiState>) => {
    setRegions((prev) => {
      const next = new Map(prev);
      next.set(key, { ...getRegionUi(key), ...patch });
      return next;
    });
  };

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
      // Use real authored duration for seek math. A fake 60s floor used to
      // skew songOffsets when peaks/regions weren't ready yet, so scrubbing
      // into song N landed at the wrong localSeconds.
      const len = Math.max(
        1,
        songDurationSeconds(songs[i], fromAll ?? fromCurrent),
      );
      lengths.push(len);
      offsets.push(acc);
      acc += len;
    }
    return {
      songLengths: lengths,
      songOffsets: offsets,
      totalLength: Math.max(acc, 120),
    };
  }, [songs, allPeaks, peaks, state.songIndex]);

  /** Split selected region(s) at the absolute playhead (Logic-style ⌘T). */
  const splitSelectedAtPlayhead = async () => {
    if (selectedRegionKeys.length === 0) {
      showToast("Select a region to trim");
      return;
    }
    let splitCount = 0;
    // Shared across every region split below (each split is itself a
    // regionUpdate + regionAdd pair) so the whole multi-region split
    // collapses into ONE undo step.
    const gestureId = crypto.randomUUID();
    for (const key of selectedRegionKeys) {
      const hit = lookupRegion(state.songs, key);
      if (!hit) continue;
      const { songIndex, region: r } = hit;
      const songStart = songOffsets[songIndex] ?? 0;
      const songLen = songLengths[songIndex] ?? 0;
      const localPlayhead = playheadAbsoluteSec - songStart;
      if (localPlayhead < 0 || (songLen > 0 && localPlayhead > songLen))
        continue;

      // Effective bounds: duration 0 means full remaining song length.
      const regionStart = r.startSeconds;
      const regionDur =
        r.durationSeconds > 0
          ? r.durationSeconds
          : Math.max(0.05, songLen - regionStart);
      const regionEnd = regionStart + regionDur;

      // Playhead must sit strictly inside the region (min stub ~50ms each side).
      if (
        localPlayhead <= regionStart + 0.05 ||
        localPlayhead >= regionEnd - 0.05
      )
        continue;

      const leftDur = localPlayhead - regionStart;
      const rightDur = regionEnd - localPlayhead;
      const rightSourceOffset = r.sourceOffsetSeconds + leftDur;

      await builder.regionUpdate({
        songIndex,
        regionId: r.id,
        durationSeconds: leftDur,
        fadeOutSeconds: 0,
        gestureId,
      });
      await builder.regionAdd({
        songIndex,
        trackId: r.trackId,
        file: r.file,
        startSeconds: localPlayhead,
        sourceOffsetSeconds: rightSourceOffset,
        durationSeconds: rightDur,
        gainDb: r.gainDb,
        fadeInSeconds: 0,
        fadeOutSeconds: r.fadeOutSeconds,
        gestureId,
      });
      splitCount += 1;
    }
    if (splitCount === 0) {
      showToast("Playhead is not inside the selected region");
    } else {
      showToast(
        splitCount === 1
          ? "Trimmed region at playhead"
          : `Trimmed ${splitCount} regions at playhead`,
      );
      setSelectedRegionKeys([]);
    }
  };

  const contentWidth = Math.max(1, Math.round(totalLength * pxPerSec));

  const rows = useMemo(
    () => buildRows(state.tracks, songs),
    [state.tracks, songs],
  );

  const applyZoomAt = (nextPxPerSec: number, focusClientX?: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const oldPx = pxPerSecRef.current;
    const clampedNext = Math.max(
      MIN_PX_PER_SEC,
      Math.min(MAX_PX_PER_SEC, nextPxPerSec),
    );
    if (Math.abs(clampedNext - oldPx) < 0.001) return;

    const k = clampedNext / oldPx;
    const rect = scroller.getBoundingClientRect();

    // While "smooth" autofollow is live and the transport is playing, anchor
    // the zoom at the playhead marker's CURRENT on-screen position instead of
    // the cursor / viewport center. Smooth follow re-pins the playhead at 25%
    // every frame, so a zoom focused anywhere else (cursor, center)
    // immediately re-anchors once the gesture ends and visibly jumps.
    // playheadScreenXRef is the marker's real screen X as written by the rAF
    // loop each tick (document position minus the actual scrollLeft) --
    // anchoring there keeps the playhead fixed at the same screen spot
    // through and after the zoom, and stays correct even while follow is
    // paused mid-gesture.
    let focusX: number;
    if (playingRef.current && followModeRef.current === "smooth") {
      const markerX = playheadScreenXRef.current;
      focusX =
        markerX !== null
          ? Math.max(0, Math.min(rect.width, markerX))
          : rect.width / 2;
    } else {
      focusX =
        typeof focusClientX === "number"
          ? focusClientX - rect.left
          : rect.width / 2;
      if (focusX < 0 || focusX > rect.width) focusX = rect.width / 2;
    }

    const currentScrollLeft =
      pendingScrollLeftRef.current !== null
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
        const maxLeft = Math.max(
          0,
          scroller.scrollWidth - scroller.clientWidth,
        );
        const targetScrollLeft = Math.max(
          0,
          Math.min(maxLeft, pendingScrollLeftRef.current),
        );
        programmaticScrollRef.current = true;
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
        markGestureActiveRef.current();

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
      markGestureActiveRef.current();
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

    el.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gesturestart", handleGestureStart as any, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gesturechange", handleGestureChange as any, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gestureend", handleGestureEnd as any, {
      capture: true,
      passive: false,
    });

    return () => {
      el.removeEventListener("wheel", handleWheel, { capture: true });
      el.removeEventListener("gesturestart", handleGestureStart as any, {
        capture: true,
      });
      el.removeEventListener("gesturechange", handleGestureChange as any, {
        capture: true,
      });
      el.removeEventListener("gestureend", handleGestureEnd as any, {
        capture: true,
      });
    };
  }, []);

  // Maps an absolute (whole-timeline) second offset to whichever song
  // segment contains it, plus the position within that song.
  const resolveSong = (
    absSeconds: number,
  ): { songIndex: number; localSeconds: number } => {
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
    // timelineBodyRef is the full-width content inside the scroller -- its
    // getBoundingClientRect().left already shifts with scrollLeft. Adding
    // scrollLeft again double-counted and scrub landed far from the cursor.
    const rect = bodyEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const absSeconds = Math.max(0, x / pxPerSecRef.current);
    const { songIndex, localSeconds } = resolveSong(absSeconds);
    if (songIndex < 0) return;

    const targetSong = songs[songIndex];
    const bpm = targetSong?.bpm ?? 120;
    const tsNum = targetSong?.tsNum ?? 4;
    const snappedLocal = snapToGridSec(localSeconds, pxPerSecRef.current, bpm, tsNum, snapToGrid);

    // Clamp into the resolved song's authored length so we never seek past EOF.
    const songLen = songLengths[songIndex] ?? 0;
    const songStart = songOffsets[songIndex] ?? 0;
    const clampedLocal =
      songLen > 0
        ? Math.min(snappedLocal, Math.max(0, songLen - 0.01))
        : snappedLocal;
    const clampedAbs = songStart + clampedLocal;

    // Optimistic absolute needle moves immediately (one continuous timeline).
    setPlayheadAbsoluteSec(clampedAbs);

    // Engine seeks only on commit (pointer up). Mid-drag same-song seeks used
    // to restage every 60ms and produced the "chirp then stop then play" glitch.
    if (!commit) return;

    if (songIndex !== state.songIndex) {
      void transport.seek(clampedLocal, songIndex);
      return;
    }
    lastSeekAt.current = Date.now();
    void transport.seek(clampedLocal);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasSongs) return;
    // Empty-lane click (regions stopPropagation) clears region selection.
    if (!readOnly) setSelectedRegionKeys([]);
    dragging.current = true;
    // Capture on currentTarget (the stable element the handler is bound to),
    // not e.target -- capturing a transient child (a region block, a ruler
    // tick) that later unmounts mid-drag silently ends the capture without
    // ever firing pointerup, leaving dragging.current stuck true so plain
    // mouse hover afterwards kept dragging the playhead.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // Optimistic needle only on down -- committing a full seek here AND on
    // pointerup caused a stop→play blip (audio for 1ms, silence, then play).
    seekFromClientX(e.clientX, false);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    // Defensive: if the button was released without us seeing pointerup
    // (lost capture, event swallowed elsewhere), stop dragging instead of
    // following mere hover.
    if (e.buttons === 0) {
      dragging.current = false;
      return;
    }
    seekFromClientX(e.clientX, false);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    // Single commit on release.
    seekFromClientX(e.clientX, true);
  };
  const onPointerCancelOrLost = () => {
    dragging.current = false;
  };

  const onScrollSync = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTopY(e.currentTarget.scrollTop);
    if (programmaticScrollRef.current) {
      // Echo of our own auto-follow/zoom-focus write -- that effect already
      // synced scrollState synchronously (see programmaticScrollRef's doc
      // comment). Re-applying it here from a possibly-delayed native event
      // could stomp a NEWER value the same effect already wrote on a later
      // frame; skip both the resync and the gesture-active mark.
      programmaticScrollRef.current = false;
      return;
    }
    markGestureActiveRef.current();
    setScrollState({
      scrollLeft: e.currentTarget.scrollLeft,
      viewportWidth: e.currentTarget.clientWidth,
    });
  };

  // Editor hotkeys: region copy / paste / delete / select-all.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "a") {
        e.preventDefault();
        setSelectedRegionKeys(allRegionSelKeys(state.songs));
      } else if (mod && e.key === "c") {
        e.preventDefault();
        copySelectedRegions();
      } else if (mod && e.key === "v") {
        e.preventDefault();
        void pasteClipboardRegions();
      } else if (mod && e.key === "d") {
        e.preventDefault();
        void duplicateSelectedRegions();
      } else if (mod && e.key === "t") {
        e.preventDefault();
        void splitSelectedAtPlayhead();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (selectedRegionKeys.length === 0) return;
        e.preventDefault();
        deleteSelectedRegions();
      } else if (e.key === "Escape") {
        setSelectedRegionKeys([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    readOnly,
    selectedRegionKeys,
    state.songs,
    playheadAbsoluteSec,
    songOffsets,
    songLengths,
  ]);

  const currentSongIdx = state.songIndex >= 0 ? state.songIndex : 0;

  const prevSongIdxRef = useRef(currentSongIdx);

  // Refs kept fresh on every render so the rAF loops below (both the
  // "smooth" scroll-follow and the playhead-marker display damping) always
  // read the LATEST value without needing to restart when it changes --
  // driving them from a dependency-array effect instead had them react to
  // playheadAbsoluteSec only once React actually re-renders/commits after
  // useContinuousPlayhead's OWN separate rAF loop calls setState, which
  // isn't guaranteed to land in the same frame every time. Two independent,
  // self-paced 60fps loops (this one and the hook's) stay visually in sync
  // far more reliably than chaining one through the other's render cycle.
  const playheadAbsoluteSecRef = useRef(playheadAbsoluteSec);
  playheadAbsoluteSecRef.current = playheadAbsoluteSec;
  const pxPerSecRefForFollow = useRef(pxPerSec);
  pxPerSecRefForFollow.current = pxPerSec;
  const contentWidthRef = useRef(contentWidth);
  contentWidthRef.current = contentWidth;
  const followModeRef = useRef(followMode);
  followModeRef.current = followMode;
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;
  const currentSongIdxRef = useRef(currentSongIdx);
  currentSongIdxRef.current = currentSongIdx;

  // Auto-scroll timeline to keep the playhead in view.
  //
  // This effect handles the "snap" follow mode: while actually playing and
  // followMode === "snap", jump the scroll once the playhead nears the
  // viewport edge (the original behavior). It deliberately bails out of
  // "smooth" mode -- that one is driven by its own dedicated rAF loop below,
  // fully decoupled from React's render cycle so it can't inherit any
  // cross-render timing jitter.
  //
  // Playhead REVEALS on discrete events (song change, stop/full stop, far
  // click-seek) are NOT here either -- the rAF loop detects a large playhead
  // jump while not smoothly following and snaps the view to it (see below).
  // followMode="off" only opts out of being continuously yanked around
  // DURING playback; a deliberate song pick or a stop still brings the
  // playhead into view, same as clicking an item in a list still scrolls to
  // it even with "autoscroll" off elsewhere in this app.
  useLayoutEffect(() => {
    const songChanged = prevSongIdxRef.current !== currentSongIdx;
    prevSongIdxRef.current = currentSongIdx;

    // Pause ALL auto-scroll (continuous follow and the discrete reveal
    // alike) while the user is actively zooming or manually scrolling --
    // gestureActive is only set by those two sources (wheel/pinch zoom, or a
    // genuine user scroll event; see markGestureActiveRef/programmaticScrollRef).
    // Fighting the user's own zoom-focus-point scroll adjustment for control
    // of scrollLeft every frame was the other half of the reported jitter.
    if (gestureActive) return;
    // "smooth" is handled entirely by its own rAF-loop effect below.
    if (state.playing && followMode === "smooth") return;

    if (!scrollRef.current) return;
    const scroller = scrollRef.current;
    const viewWidth = scroller.clientWidth || 1000;
    // Clamp to the SAME upper bound the browser enforces natively
    // (contentWidth - viewWidth). Without this, near the end of a song
    // playheadPx - viewWidth*0.25 can exceed that bound: the browser
    // silently clamps the real DOM scrollLeft, but scrollState.scrollLeft
    // (used to position the WaveformLane/BeatGrid canvases via `left:
    // scrollLeft`) ends up larger than the true scroll position, opening a
    // blank gap on the left edge of the viewport until the next native
    // `scroll` event resyncs state -- the "мигание" (blinking) reported
    // specifically near song endings. Reading the DOM's scrollLeft back
    // after assignment (rather than trusting our own computed value) closes
    // the gap even if the browser clamps for some other reason too.
    const maxScrollLeft = Math.max(0, contentWidth - viewWidth);
    const snapTo = (px: number) => {
      const targetLeft = Math.min(maxScrollLeft, Math.max(0, px - viewWidth * 0.25));
      programmaticScrollRef.current = true;
      scroller.scrollLeft = targetLeft;
      setScrollState({ scrollLeft: scroller.scrollLeft, viewportWidth: viewWidth });
    };

    if (state.playing && followMode !== "off") {
      const playheadPx = playheadAbsoluteSec * pxPerSec;
      const currentLeft = scroller.scrollLeft;
      const rightMargin = 120;
      const leftMargin = 40;
      if (
        songChanged ||
        playheadPx > currentLeft + viewWidth - rightMargin ||
        playheadPx < currentLeft + leftMargin
      ) {
        snapTo(playheadPx);
      }
      return;
    }

    // Not following playback here -- reveals on song change / stop / far
    // seek are handled by the rAF loop below (it sees the large playhead
    // jump every frame and snaps the view to it).
  }, [
    state.playing,
    followMode,
    currentSongIdx,
    Math.floor(playheadAbsoluteSec),
    pxPerSec,
    contentWidth,
    gestureActive,
  ]);

  // "smooth" follow's dedicated rAF loop -- fully decoupled from React's
  // render cycle (see the big effect above for why). playheadAbsoluteSec
  // itself stays raw/precise everywhere else (e.g. localPlayhead above,
  // used for split-at-playhead).
  //
  // The playhead MARKER is moved by writing its `left` style directly to the
  // DOM node (playheadRef) from this loop, NEVER through React state:
  // driving it via setState() re-rendered the timeline every frame and --
  // worse -- the committed render (and thus the marker's new position) landed
  // a frame AFTER the native scrollLeft write below had already taken effect,
  // so the marker visibly lagged/stuttered behind a viewport that was moving
  // every frame ("плейхед стал дико баганным"). Writing the style attribute
  // in the same tick as the scroll write makes the two atomic within a frame;
  // there is no React commit in between to desync them.
  //
  // The loop owns a single animated scroll position and glides it toward the
  // playhead-anchored target with a per-frame speed cap: normal follow eases
  // at ~25%/frame (filtering the small clock wobble), while big jumps --
  // song change, stop/full-stop reset, far seek -- PAN instead of teleporting
  // ("при переключении песен хай плавно скроллится к нужной песне", "время
  // стопилось якобы а потом оно с анимацией догоняло"). It runs ONCE (the
  // song index is tracked through a ref) so a song change doesn't restart it
  // and lose the in-flight glide.
  const playheadRef = useRef<HTMLDivElement>(null);
  // Marker's current on-screen X (document position minus scrollLeft),
  // updated every tick. applyZoomAt reads it to anchor zooms at the playhead
  // while smooth autofollow is live -- anchoring at the raw time-position
  // instead picked up the EMA residual and made the playhead visibly jump
  // mid-zoom ("дёргается при зуме всё-равно").
  const playheadScreenXRef = useRef<number | null>(null);
  useEffect(() => {
    let raf = 0;
    // Engine-owned scrollLeft; null while idle (not following / not panning).
    let engineScrollLeft: number | null = null;
    let displayPx = playheadAbsoluteSecRef.current * pxPerSecRefForFollow.current;
    // Reveal-pan state: the scroll position being animated toward a reveal
    // target; null when no reveal is in flight.
    let revealScroll: number | null = null;
    // Total distance of the current pan, captured at pan start (or when the
    // target jumps further away). Drives the constant-speed `linear` term so a
    // pan has a BOUNDED duration no matter how far away the target is.
    let panStartDist = 0;
    // Last position the reveal logic compared against, to detect a LARGE
    // jump. Updating it every idle frame is what makes ordinary pauses and
    // manual scrolls never fire a reveal.
    let lastRevealPx = displayPx;
    let lastSongIdx = currentSongIdxRef.current;
    const marker = playheadRef.current;
    if (marker) marker.style.left = `${displayPx}px`;

    const tick = () => {
      const px = playheadAbsoluteSecRef.current * pxPerSecRefForFollow.current;
      const songJumped = currentSongIdxRef.current !== lastSongIdx;
      lastSongIdx = currentSongIdxRef.current;

      // gestureActiveNowRef, NOT a React-state mirror: it's set synchronously
      // in the same tick as the wheel/pinch handler, so this rAF loop can
      // never observe a stale "not zooming" for a frame while React's own
      // update is still in flight -- that one-frame race (this loop writing
      // the playhead-anchor scroll target at the same instant applyZoomAt's
      // effect writes the zoom-focus target) was what made the playhead
      // visibly jump during a zoom gesture while autofollowing.
      const following =
        playingRef.current
        && !gestureActiveNowRef.current
        && followModeRef.current === "smooth";
      const scroller = scrollRef.current;
      const viewWidth = scroller ? scroller.clientWidth || 1000 : 1000;
      const maxScrollLeft = Math.max(0, contentWidthRef.current - viewWidth);
      const target = Math.min(maxScrollLeft, Math.max(0, px - viewWidth * 0.25));

      // Step `from` toward `target`. Two regimes:
      //  - Tiny differences (normal follow wobble) settle exponentially
      //    (alpha 0.25) so the clock jitter is filtered, not amplified.
      //  - Bigger jumps pan with a BOUNDED duration (~0.3s at 60fps) rather
      //    than a fixed pixels-per-frame cap -- the old cap was 15% of the
      //    viewport per frame, so on a long timeline a song far away took
      //    seconds to reach ("слишком медленно скроллит между песнями").
      //    `linear` is the CONSTANT speed panStartDist/PAN_FRAMES (captured at
      //    pan start, NOT recomputed from the shrinking distance -- using the
      //    current dist made it an exponential decay that crawled for minutes
      //    of timeline, which read as "медленный глайд при зуме"); when the
      //    remaining distance drops below the step, snap to the target so the
      //    tail can't drag on. `floor` keeps medium jumps from crawling.
      const glide = (from: number) => {
        const diff = target - from;
        const dist = Math.abs(diff);
        if (dist < 0.5) return target;
        const PAN_FRAMES = 18; // ~0.3s
        const ease = dist * 0.25;
        const linear = panStartDist / PAN_FRAMES;
        const floor = viewWidth * 0.06;
        const step = Math.min(ease, Math.max(linear, floor));
        if (step >= dist) return target;
        return diff > 0 ? from + step : from - step;
      };

      if (following && scroller) {
        revealScroll = null;
        if (engineScrollLeft === null) {
          engineScrollLeft = scroller.scrollLeft;
          panStartDist = Math.abs(target - engineScrollLeft);
        } else {
          // Target jumped further away mid-pan (e.g. another song change) --
          // re-anchor the constant speed so the pan restarts fast.
          const still = Math.abs(target - engineScrollLeft);
          if (still > panStartDist) panStartDist = still;
        }
        engineScrollLeft = glide(engineScrollLeft);
        const before = scroller.scrollLeft;
        scroller.scrollLeft = engineScrollLeft;
        engineScrollLeft = scroller.scrollLeft; // re-read in case browser clamped it
        if (Math.abs(before - engineScrollLeft) > 0.5) {
          programmaticScrollRef.current = true;
        }
        setScrollState({ scrollLeft: engineScrollLeft, viewportWidth: viewWidth });
        // Marker: pinned at 25% of the viewport whenever the playhead CAN sit
        // there (desired scroll within bounds). At the very start/end of the
        // timeline the desired scroll clamps to 0/maxScrollLeft, so the
        // playhead can't be at 25% -- show its true position there ("плейхед
        // не там" at the boundaries). During a song-change pan the marker
        // stays pinned and the timeline slides under it, like a DAW's
        // continuous-scroll playhead.
        const pinnedTarget = px - viewWidth * 0.25;
        displayPx =
          pinnedTarget >= 0 && pinnedTarget <= maxScrollLeft
            ? engineScrollLeft + viewWidth * 0.25
            : px;
      } else {
        // Not smoothly following this tick (paused, off/snap mode, or a
        // gesture is in progress) -- drop the follow anchor.
        engineScrollLeft = null;
        // Marker tracks the raw playhead at its natural document position.
        // Snap instantly on a large jump (seek, song change, stop) or while
        // dragging the handle (must track the pointer 1:1 with zero added
        // lag); ease only the small natural wobble during playback.
        displayPx =
          dragging.current || Math.abs(px - displayPx) > pxPerSecRefForFollow.current * 1.5
            ? px
            : displayPx + (px - displayPx) * 0.25;

        // Animated REVEAL: a large playhead jump while playback is stopped
        // (song change, stop/full-stop reset, far seek) PANS the view to it
        // instead of leaving it off-screen. Guarded against scrubbing
        // (dragging), zooming (gesture), and manual scrolling (px doesn't
        // move then, so lastRevealPx stays equal). While playing, the "snap"
        // layout effect owns the scroll and "smooth" owns the follow branch
        // above, so reveals are only this loop's job when stopped.
        const needReveal =
          !playingRef.current
          && (songJumped || Math.abs(px - lastRevealPx) > pxPerSecRefForFollow.current * 2.0);
        if (
          scroller
          && !dragging.current
          && !gestureActiveNowRef.current
          && (revealScroll !== null || needReveal)
        ) {
          if (revealScroll === null) {
            revealScroll = scroller.scrollLeft;
            panStartDist = Math.abs(target - revealScroll);
          } else {
            const still = Math.abs(target - revealScroll);
            if (still > panStartDist) panStartDist = still;
          }
          revealScroll = glide(revealScroll);
          const settled = Math.abs(target - revealScroll) < 0.5;
          if (settled) revealScroll = target;
          const before = scroller.scrollLeft;
          scroller.scrollLeft = revealScroll;
          if (Math.abs(before - scroller.scrollLeft) > 0.5) {
            programmaticScrollRef.current = true;
          }
          setScrollState({ scrollLeft: scroller.scrollLeft, viewportWidth: viewWidth });
          if (settled) revealScroll = null;
        } else {
          revealScroll = null;
        }
      }

      lastRevealPx = px;
      if (scroller) playheadScreenXRef.current = displayPx - scroller.scrollLeft;

      const m = playheadRef.current;
      if (m) m.style.left = `${displayPx}px`;

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Toolbar ──────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-default/30 bg-background-secondary"
    >
      {/* Toast overlay */}
      <ToastContainer
        toasts={toasts}
        onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))}
      />

      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-default/30 px-3 py-1.5 bg-background-secondary z-20">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground/40 shrink-0">
          Timeline
          <span className="ml-2 font-normal lowercase text-foreground/25">
            {songs.length} song{songs.length === 1 ? "" : "s"} &middot;{" "}
            {formatTimeShort(totalLength)}
          </span>
        </span>

        <div className="flex items-center gap-1 ml-auto h-7">
          {!readOnly && (
            <>
              <Button
                size="sm"
                variant="outline"
                isIconOnly
                aria-label={
                  state.undoLabel ? `Undo: ${state.undoLabel} (⌘Z)` : "Undo (⌘Z)"
                }
                isDisabled={!state.canUndo}
                onPress={() => void timelineHistory.undo()}
              >
                <Undo2 size={13} />
              </Button>
              <Button
                size="sm"
                variant="outline"
                isIconOnly
                aria-label={
                  state.redoLabel
                    ? `Redo: ${state.redoLabel} (⌘⇧Z)`
                    : "Redo (⌘⇧Z)"
                }
                isDisabled={!state.canRedo}
                onPress={() => void timelineHistory.redo()}
              >
                <Redo2 size={13} />
              </Button>
              <div className="w-px h-4 bg-default/30 mx-0.5" />
              <Button
                size="sm"
                variant="outline"
                isIconOnly
                aria-label="Copy selected regions (⌘C)"
                isDisabled={selectedRegionKeys.length === 0}
                onPress={copySelectedRegions}
              >
                <Copy size={13} />
              </Button>
              <Button
                size="sm"
                variant="outline"
                isIconOnly
                aria-label="Delete selected regions (⌫)"
                isDisabled={selectedRegionKeys.length === 0}
                onPress={deleteSelectedRegions}
              >
                <Trash2 size={13} />
              </Button>
              <Button
                size="sm"
                variant="outline"
                isIconOnly
                aria-label="Trim/split selected regions at playhead (⌘T)"
                isDisabled={selectedRegionKeys.length === 0}
                onPress={() => void splitSelectedAtPlayhead()}
              >
                <Scissors size={13} />
              </Button>
              <div className="w-px h-4 bg-default/30 mx-0.5" />
              <Button
                size="sm"
                variant={snapToGrid ? "primary" : "outline"}
                isIconOnly
                aria-label={
                  snapToGrid ? "Snap to grid: ON" : "Snap to grid: OFF"
                }
                onPress={() => setSnapToGrid((v) => !v)}
              >
                <Magnet size={13} />
              </Button>
            </>
          )}

          <div className="w-px h-4 bg-default/30 mx-0.5" />
          <Button
            size="sm"
            variant={followMode === "off" ? "outline" : "primary"}
            isIconOnly
            aria-label={
              followMode === "off"
                ? "Playhead autofollow: off (click for standard)"
                : followMode === "snap"
                  ? "Playhead autofollow: standard (click for smooth)"
                  : "Playhead autofollow: smooth (click to turn off)"
            }
            onPress={cycleFollowMode}
          >
            {followMode === "off" ? (
              <LocateOff size={13} />
            ) : followMode === "snap" ? (
              <Locate size={13} />
            ) : (
              <LocateFixed size={13} />
            )}
          </Button>

          {/* H / V zoom — narrow, right side; thumb hit padding 1rem */}
          <div className="flex items-center gap-1.5 ml-1 w-[17.5rem] shrink-0">
            <MoveHorizontalIcon
              style={{ opacity: 0.2, width: "16px", height: "16px" }}
            />
            <Slider
              aria-label="Horizontal zoom"
              minValue={0}
              maxValue={1}
              step={0.001}
              value={Math.max(
                0,
                Math.min(
                  1,
                  Math.log(pxPerSec / MIN_PX_PER_SEC) /
                    Math.log(MAX_PX_PER_SEC / MIN_PX_PER_SEC),
                ),
              )}
              onChange={(v) => {
                const t = Array.isArray(v) ? v[0] : v;
                const next =
                  MIN_PX_PER_SEC * Math.pow(MAX_PX_PER_SEC / MIN_PX_PER_SEC, t);
                applyZoomAt(next);
              }}
              className="flex-1 min-w-0 -mt-1"
            >
              <Slider.Track
                style={{
                  borderLeftColor: "var(--default)",
                  background: "var(--background)",
                }}
              >
                <Slider.Fill style={{ background: "var(--default)" }} />
                <Slider.Thumb
                  style={
                    {
                      boxSizing: "border-box",
                      background: "var(--default)",
                    } as any
                  }
                />
              </Slider.Track>
            </Slider>
            <MoveVerticalIcon
              style={{ opacity: 0.2, width: "16px", height: "16px" }}
            />
            <Slider
              aria-label="Vertical zoom"
              minValue={0.3}
              maxValue={4}
              step={0.01}
              value={verticalZoom}
              onChange={(v) => {
                const z = Array.isArray(v) ? v[0] : v;
                setVerticalZoom(z);
              }}
              className="flex-1 min-w-0 -mt-1"
            >
              <Slider.Track
                style={{
                  borderLeftColor: "var(--default)",
                  background: "var(--background)",
                }}
              >
                <Slider.Fill style={{ background: "var(--default)" }} />
                <Slider.Thumb
                  style={
                    {
                      boxSizing: "border-box",
                      background: "var(--default)",
                    } as any
                  }
                />
              </Slider.Track>
            </Slider>
          </div>
        </div>
      </div>

      {!hasSongs ? (
        <div className="flex h-full min-h-0 items-center justify-center text-sm text-foreground/40">
          No songs in this project
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Fixed Left Sidebar with Track Controls (editor only) */}
          {!readOnly && (
            <div
              className="shrink-0 flex flex-col border-r border-default/30 bg-background-secondary z-20 select-none"
              style={{ width: SIDEBAR_WIDTH }}
            >
              {/* Ruler spacer header */}
              <div
                className="shrink-0 border-b border-default/30 px-2.5 text-[10px] font-bold uppercase tracking-wider text-foreground/40 flex items-center bg-background-tertiary"
                style={{ height: RULER_HEIGHT }}
              >
                SONGS
              </div>
              {/* Section-marker lane spacer */}
              <div
                className="shrink-0 border-b border-default/30 px-2.5 text-[9px] font-bold uppercase text-foreground/25 flex items-center bg-background-tertiary"
                style={{ height: SECTION_LANE_HEIGHT }}
              >
                Sections
              </div>
              {/* Event lane spacer */}
              <div
                className="shrink-0 border-b border-default/30 px-2.5 text-[9px] font-bold uppercase text-foreground/25 flex items-center bg-background-tertiary"
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
                          verticalZoom={verticalZoom}
                          anySolo={
                            (state.clickSolo ?? false) ||
                            state.tracks.some((t) => t.solo)
                          }
                        />
                      ) : (
                        <TimelineRowLabel
                          key={row.name}
                          name={row.name}
                          color={row.color}
                          verticalZoom={verticalZoom}
                        />
                      ),
                    )
                  )}
                </div>
              </div>
            </div>
          )}

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
                className="sticky top-0 z-20 bg-background-secondary shrink-0 cursor-col-resize touch-none relative"
                style={{ width: contentWidth, height: RULER_HEIGHT }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancelOrLost}
                onLostPointerCapture={onPointerCancelOrLost}
              >
                {songs.map((song, i) => {
                  const left = Math.round(songOffsets[i] * pxPerSec);
                  const isActive = i === state.songIndex;
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
                        contentWidth={Math.max(
                          1,
                          Math.round(songLengths[i] * pxPerSec),
                        )}
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
              </div>

              {/* 1.5. Section Marker Lane -- structural markers per song (Intro/Verse/Chorus/...) */}
              <SectionMarkerLane
                songs={songs}
                songOffsets={songOffsets}
                songLengths={songLengths}
                pxPerSec={pxPerSec}
                contentWidth={contentWidth}
                readOnly={readOnly}
                snapToGrid={snapToGrid}
              />

              {/* 2. Event Marker Lane -- events from every song, each at its song's absolute offset */}
              <div
                className="relative shrink-0 border-b border-default/30 bg-surface/30 cursor-col-resize touch-none"
                style={{ height: EVENT_LANE_HEIGHT, width: contentWidth }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancelOrLost}
                onLostPointerCapture={onPointerCancelOrLost}
              >
                <div className="relative" style={{ width: contentWidth }}>
                  {songs.flatMap((song, i) =>
                    song.events
                      .filter((e) => !e.triggerOnLoad)
                      .map((e) => {
                        const color = EVENT_COLORS[e.type] ?? "#8e8e93";
                        const left =
                          (songOffsets[i] + e.timeSeconds) * pxPerSec - 5;
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

              {/* 3. Track Waveforms & Grid Container -- one row per canonical track name, one segment per song */}
              <div
                className="relative flex-1 touch-none select-none min-h-[120px]"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancelOrLost}
                onLostPointerCapture={onPointerCancelOrLost}
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
                      contentWidth={Math.max(
                        1,
                        Math.round(songLengths[i] * pxPerSec),
                      )}
                      scrollLeft={Math.max(
                        0,
                        scrollState.scrollLeft - songOffsets[i] * pxPerSec,
                      )}
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
                    <div
                      key={row.name}
                      className="relative border-b border-default/15 bg-default/5"
                      style={{
                        width: contentWidth,
                        height: LANE_HEIGHT * verticalZoom,
                      }}
                    >
                      {songs.map((song, i) => {
                        const segStart = songOffsets[i] * pxPerSec;
                        const segWidth = Math.max(
                          1,
                          Math.round(songLengths[i] * pxPerSec),
                        );
                        const segEnd = segStart + segWidth;
                        const viewStart = Math.max(
                          segStart,
                          scrollState.scrollLeft,
                        );
                        const viewEnd = Math.min(
                          segEnd,
                          scrollState.scrollLeft + scrollState.viewportWidth,
                        );
                        if (viewEnd <= viewStart) return null;

                        const track = state.tracks.find(
                          (t) =>
                            (t.name || t.id) === row.name || t.id === row.name,
                        );
                        const trackRegions = (song.regions ?? []).filter(
                          (r) =>
                            Boolean(r.file) &&
                            (r.trackId === track?.id || r.trackId === row.name),
                        );
                        if (trackRegions.length === 0) return null;

                        // Per-region entries (allPeaks) are keyed by region
                        // id; the coarser per-track fallback (peaks, used
                        // only for the staged song before allPeaks arrives)
                        // is keyed by track id and shared across a track's
                        // regions. Resolved per-region below so a track with
                        // more than one region (e.g. after a split) doesn't
                        // have every region but one render the wrong -- or
                        // no -- waveform.
                        const peaksForSong =
                          allPeaks?.songs[i]?.tracks ??
                          (i === state.songIndex ? peaks?.tracks : undefined);
                        const segDuration = songLengths[i];

                        const snapSec = (sec: number) =>
                          snapToGridSec(
                            sec,
                            pxPerSec,
                            song.bpm,
                            song.tsNum ?? 4,
                            snapToGrid,
                          );

                        const effectiveGeom = (r: RegionRow): RegionGeom => {
                          const draft = regionGeomDraft[regionSelKey(i, r.id)];
                          const start = draft?.start ?? r.startSeconds;
                          const duration =
                            draft?.duration ??
                            (r.durationSeconds > 0
                              ? r.durationSeconds
                              : Math.max(0.05, segDuration - start));
                          return {
                            start,
                            sourceOffset:
                              draft?.sourceOffset ?? r.sourceOffsetSeconds,
                            duration,
                            fadeIn: draft?.fadeIn ?? r.fadeInSeconds ?? 0,
                            fadeOut: draft?.fadeOut ?? r.fadeOutSeconds ?? 0,
                            fadeInCurve:
                              draft?.fadeInCurve ?? r.fadeInCurve ?? 0,
                            fadeOutCurve:
                              draft?.fadeOutCurve ?? r.fadeOutCurve ?? 0,
                            loop: draft?.loop ?? r.loop ?? false,
                            loopLengthSeconds:
                              draft?.loopLengthSeconds ?? r.loopLengthSeconds ?? 0,
                          };
                        };

                        const peakEntryFor = (r: RegionRow) =>
                          peaksForSong?.find((p) => {
                            const withTrackId = p as { trackId?: string };
                            // allPeaks entries carry trackId and are keyed
                            // by region id; match this exact region.
                            if (withTrackId.trackId !== undefined)
                              return p.id === r.id;
                            // peaks fallback is keyed by track id only.
                            return p.id === track?.id;
                          });

                        return (
                          <div
                            key={i}
                            className="absolute top-0 bottom-0"
                            style={{ left: segStart, width: segWidth }}
                          >
                            {trackRegions.map((songRegion) => {
                              const thisRegionSelKey = regionSelKey(
                                i,
                                songRegion.id,
                              );
                              const isRegionSelected =
                                selectedRegionKeys.includes(thisRegionSelKey);
                              const regionUi = getRegionUi(thisRegionSelKey);
                              const geom = effectiveGeom(songRegion);
                              const leftPx = geom.start * pxPerSec;
                              const regionWidth = Math.max(
                                8,
                                geom.duration * pxPerSec,
                              );

                              const peakEntry = peakEntryFor(songRegion);
                              const peaksLoading =
                                Boolean(songRegion.file) &&
                                (!peakEntry || peakEntry.levels.length === 0);
                              const fileDuration =
                                peakEntry?.durationSeconds ??
                                songRegion.durationSeconds ??
                                segDuration;

                              // Viewport slice relative to this region box
                              // (peaks are drawn only inside the clipped region).
                              const regionAbsLeft = segStart + leftPx;
                              const regionAbsRight =
                                regionAbsLeft + regionWidth;
                              const regViewStart = Math.max(
                                regionAbsLeft,
                                viewStart,
                              );
                              const regViewEnd = Math.min(
                                regionAbsRight,
                                viewEnd,
                              );
                              const regScrollLeft = Math.max(
                                0,
                                regViewStart - regionAbsLeft,
                              );
                              const regViewportWidth = Math.max(
                                0,
                                regViewEnd - regViewStart,
                              );

                              const maxSourceDur = Math.max(
                                0.05,
                                fileDuration - geom.sourceOffset,
                              );

                              const beginDrag = (
                                e: React.PointerEvent,
                                mode: RegionDragMode,
                              ) => {
                                e.stopPropagation();
                                e.preventDefault();
                                selectRegion(thisRegionSelKey, e);
                                const orig: RegionGeom = {
                                  start: geom.start,
                                  sourceOffset: geom.sourceOffset,
                                  duration: geom.duration,
                                  fadeIn: geom.fadeIn,
                                  fadeOut: geom.fadeOut,
                                  fadeInCurve: geom.fadeInCurve,
                                  fadeOutCurve: geom.fadeOutCurve,
                                  loop: geom.loop,
                                  loopLengthSeconds: geom.loopLengthSeconds,
                                };
                                const origLoopLen =
                                  mode === "loopTrim"
                                    ? geom.loop &&
                                      geom.loopLengthSeconds &&
                                      geom.loopLengthSeconds > 0
                                      ? geom.loopLengthSeconds
                                      : geom.duration
                                    : geom.loopLengthSeconds ?? 0;

                                regionDragRef.current = {
                                  key: thisRegionSelKey,
                                  mode,
                                  startX: e.clientX,
                                  startY: e.clientY,
                                  songIndex: i,
                                  regionId: songRegion.id,
                                  origStart: orig.start,
                                  origSourceOffset: orig.sourceOffset,
                                  origDuration: orig.duration,
                                  origFadeIn: orig.fadeIn,
                                  origFadeOut: orig.fadeOut,
                                  origFadeInCurve: orig.fadeInCurve,
                                  origFadeOutCurve: orig.fadeOutCurve,
                                  origLoop: orig.loop,
                                  origLoopLength: origLoopLen,
                                  maxEnd: segDuration,
                                  maxSourceDur: Math.max(
                                    0.05,
                                    fileDuration - orig.sourceOffset,
                                  ),
                                  lastGeom: orig,
                                };
                                (
                                  e.currentTarget as HTMLElement
                                ).setPointerCapture(e.pointerId);
                              };

                              const baseGeom = (
                                rd: NonNullable<typeof regionDragRef.current>,
                              ): RegionGeom => ({
                                start: rd.origStart,
                                sourceOffset: rd.origSourceOffset,
                                duration: rd.origDuration,
                                fadeIn: rd.origFadeIn,
                                fadeOut: rd.origFadeOut,
                                fadeInCurve: rd.origFadeInCurve,
                                fadeOutCurve: rd.origFadeOutCurve,
                                loop: rd.origLoop,
                                loopLengthSeconds: rd.origLoopLength,
                              });

                              /** Hit-test left/right edge into Logic Pro style zones. */
                              const edgeMode = (
                                localX: number,
                                localY: number,
                                w: number,
                                h: number,
                              ): RegionDragMode => {
                                const qH = h * 0.25;
                                if (localX < EDGE_PX) {
                                  // Left: top 25% = fade in, bottom 75% = trim start
                                  return localY < qH
                                    ? "fadeIn"
                                    : "trimStart";
                                }
                                if (localX > w - EDGE_PX) {
                                  // Right Logic Pro style:
                                  // - Top 25%: Fade Out
                                  // - Upper-Middle (25%..65%): Loop Trim Handle
                                  // - Bottom (65%..100%): Standard Trim End
                                  if (localY < qH) return "fadeOut";
                                  if (localY < h * 0.65) return "loopTrim";
                                  return "trimEnd";
                                }
                                return "move";
                              };

                              const edgeCursor = (
                                localX: number,
                                localY: number,
                                w: number,
                                h: number,
                              ): string => {
                                const m = edgeMode(localX, localY, w, h);
                                if (m === "fadeIn" || m === "fadeOut")
                                  return "col-resize";
                                if (m === "loopTrim") return "alias";
                                if (m === "trimStart" || m === "trimEnd")
                                  return "ew-resize";
                                return "grab";
                              };

                              const onDragMove = (e: React.PointerEvent) => {
                                const rd = regionDragRef.current;
                                if (!rd || rd.key !== thisRegionSelKey) return;
                                const dSec = (e.clientX - rd.startX) / pxPerSec;
                                const dY = e.clientY - rd.startY;

                                if (rd.mode === "move") {
                                  const maxStart = Math.max(
                                    0,
                                    rd.maxEnd - rd.origDuration,
                                  );
                                  const nextStart = Math.max(
                                    0,
                                    Math.min(
                                      maxStart,
                                      snapSec(rd.origStart + dSec),
                                    ),
                                  );
                                  writeGeomDraft(thisRegionSelKey, {
                                    ...baseGeom(rd),
                                    start: nextStart,
                                  });
                                  return;
                                }

                                if (rd.mode === "trimStart") {
                                  // Stretch left into earlier source (only if
                                  // sourceOffset > 0). Dragging left decreases
                                  // start & sourceOffset, grows duration.
                                  const maxLeft = rd.origSourceOffset; // can't go past file start
                                  const rawDelta =
                                    snapSec(rd.origStart + dSec) - rd.origStart;
                                  // Negative delta = extend left
                                  const delta = Math.max(
                                    -maxLeft,
                                    Math.min(rd.origDuration - 0.05, rawDelta),
                                  );
                                  writeGeomDraft(thisRegionSelKey, {
                                    ...baseGeom(rd),
                                    start: rd.origStart + delta,
                                    sourceOffset: rd.origSourceOffset + delta,
                                    duration: rd.origDuration - delta,
                                  });
                                  return;
                                }

                                if (rd.mode === "loopTrim") {
                                  const rawEnd =
                                    rd.origStart + rd.origDuration + dSec;
                                  const snappedEnd = snapSec(rawEnd);
                                  const maxDur = rd.maxEnd - rd.origStart;
                                  const nextDur = Math.max(
                                    0.05,
                                    Math.min(maxDur, snappedEnd - rd.origStart),
                                  );
                                  const loopLen =
                                    rd.origLoopLength > 0
                                      ? rd.origLoopLength
                                      : rd.origDuration;
                                  const isLooped =
                                    nextDur > loopLen + 0.01;
                                  writeGeomDraft(thisRegionSelKey, {
                                    ...baseGeom(rd),
                                    duration: nextDur,
                                    loop: isLooped,
                                    loopLengthSeconds: isLooped ? loopLen : 0,
                                  });
                                  return;
                                }

                                if (rd.mode === "trimEnd") {
                                  const rawEnd =
                                    rd.origStart + rd.origDuration + dSec;
                                  const snappedEnd = snapSec(rawEnd);
                                  // Standard trim never loops; capped to remaining source duration.
                                  const maxDur = Math.min(
                                    rd.maxEnd - rd.origStart,
                                    rd.maxSourceDur,
                                  );
                                  const nextDur = Math.max(
                                    0.05,
                                    Math.min(maxDur, snappedEnd - rd.origStart),
                                  );
                                  writeGeomDraft(thisRegionSelKey, {
                                    ...baseGeom(rd),
                                    duration: nextDur,
                                    loop: false,
                                    loopLengthSeconds: 0,
                                  });
                                  return;
                                }

                                if (rd.mode === "fadeIn") {
                                  const maxFade = rd.origDuration * 0.5;
                                  const next = Math.max(
                                    0,
                                    Math.min(maxFade, rd.origFadeIn + dSec),
                                  );
                                  writeGeomDraft(thisRegionSelKey, {
                                    ...baseGeom(rd),
                                    fadeIn: next,
                                  });
                                  return;
                                }

                                if (rd.mode === "fadeOut") {
                                  const maxFade = rd.origDuration * 0.5;
                                  // Dragging the right-top zone left increases fade-out.
                                  const next = Math.max(
                                    0,
                                    Math.min(maxFade, rd.origFadeOut - dSec),
                                  );
                                  writeGeomDraft(thisRegionSelKey, {
                                    ...baseGeom(rd),
                                    fadeOut: next,
                                  });
                                  return;
                                }

                                if (rd.mode === "fadeInCurve") {
                                  // Vertical drag reshapes the curve (−1..+1).
                                  const next = Math.max(
                                    -1,
                                    Math.min(1, rd.origFadeInCurve - dY / 40),
                                  );
                                  writeGeomDraft(thisRegionSelKey, {
                                    ...baseGeom(rd),
                                    fadeInCurve: next,
                                  });
                                  return;
                                }

                                if (rd.mode === "fadeOutCurve") {
                                  const next = Math.max(
                                    -1,
                                    Math.min(1, rd.origFadeOutCurve - dY / 40),
                                  );
                                  writeGeomDraft(thisRegionSelKey, {
                                    ...baseGeom(rd),
                                    fadeOutCurve: next,
                                  });
                                }
                              };

                              const onDragUp = (e: React.PointerEvent) => {
                                const rd = regionDragRef.current;
                                if (!rd || rd.key !== thisRegionSelKey) return;
                                const finalGeom: RegionGeom =
                                  rd.lastGeom ?? baseGeom(rd);
                                // Keep draft until state.songs matches (useEffect above).
                                writeGeomDraft(thisRegionSelKey, finalGeom);
                                void builder.regionUpdate({
                                  songIndex: i,
                                  regionId: songRegion.id,
                                  startSeconds: finalGeom.start,
                                  sourceOffsetSeconds: finalGeom.sourceOffset,
                                  durationSeconds: finalGeom.duration,
                                  fadeInSeconds: finalGeom.fadeIn,
                                  fadeOutSeconds: finalGeom.fadeOut,
                                  fadeInCurve: finalGeom.fadeInCurve,
                                  fadeOutCurve: finalGeom.fadeOutCurve,
                                  loop: finalGeom.loop,
                                  loopLengthSeconds: finalGeom.loopLengthSeconds,
                                });
                                regionDragRef.current = null;
                                try {
                                  (
                                    e.currentTarget as HTMLElement
                                  ).releasePointerCapture(e.pointerId);
                                } catch {
                                  /* already released */
                                }
                              };

                              const onRegionPointerDown = (
                                e: React.PointerEvent,
                              ) => {
                                if (readOnly) return;
                                const rect =
                                  e.currentTarget.getBoundingClientRect();
                                const localX = e.clientX - rect.left;
                                const localY = e.clientY - rect.top;
                                const mode = edgeMode(
                                  localX,
                                  localY,
                                  regionWidth,
                                  rect.height,
                                );
                                // Trim-start only useful when there's earlier
                                // source to pull (sourceOffset > 0).
                                if (
                                  mode === "trimStart" &&
                                  geom.sourceOffset <= 0.0001
                                ) {
                                  beginDrag(e, "move");
                                  return;
                                }
                                beginDrag(e, mode);
                              };

                              return (
                                <div key={songRegion.id}>
                                  <div
                                    className={`absolute top-1 bottom-1 rounded-md overflow-hidden ${readOnly ? "pointer-events-none" : "pointer-events-auto"}`}
                                    style={{
                                      left: leftPx,
                                      width: regionWidth,
                                      border: isRegionSelected
                                        ? `2px solid ${row.color}`
                                        : `1.5px solid ${row.color}55`,
                                      background: isRegionSelected
                                        ? `${row.color}30`
                                        : `${row.color}12`,
                                      boxShadow: isRegionSelected
                                        ? `0 0 0 1px ${row.color}aa, 0 0 10px ${row.color}44`
                                        : undefined,
                                      cursor: readOnly ? "default" : "grab",
                                      opacity: regionUi.muted ? 0.4 : 1,
                                      zIndex: isRegionSelected ? 2 : 1,
                                    }}
                                    title={`${row.name} – Song ${i + 1}: ${song.name}${geom.loop ? " [loop]" : ""}`}
                                    onPointerDown={onRegionPointerDown}
                                    onPointerMove={(e) => {
                                      if (regionDragRef.current) {
                                        onDragMove(e);
                                        return;
                                      }
                                      // Hover cursor reflects edge zone.
                                      if (readOnly) return;
                                      const rect =
                                        e.currentTarget.getBoundingClientRect();
                                      const c = edgeCursor(
                                        e.clientX - rect.left,
                                        e.clientY - rect.top,
                                        regionWidth,
                                        rect.height,
                                      );
                                      (
                                        e.currentTarget as HTMLElement
                                      ).style.cursor = c;
                                    }}
                                    onPointerUp={onDragUp}
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      if (readOnly) return;
                                      selectRegion(thisRegionSelKey, e);
                                      setRegionContextMenu({
                                        x: e.clientX,
                                        y: e.clientY,
                                        songIndex: i,
                                        regionId: songRegion.id,
                                        selKey: thisRegionSelKey,
                                      });
                                    }}
                                  >
                                    {/* Peaks clipped to region bounds */}
                                    {regViewportWidth > 0 && (
                                      <TrackWaveformLane
                                        levels={peakEntry?.levels ?? []}
                                        durationSeconds={fileDuration}
                                        regionFile={songRegion.file}
                                        gestureActive={gestureActive}
                                        verticalZoom={verticalZoom}
                                        contentWidth={regionWidth}
                                        scrollLeft={regScrollLeft}
                                        viewportWidth={regViewportWidth}
                                        pxPerSec={pxPerSec}
                                        color={row.color}
                                        muted={
                                          (track?.mute ?? false) ||
                                          regionUi.muted
                                        }
                                        sourceOffsetSec={geom.sourceOffset}
                                        embedded
                                        loop={geom.loop}
                                        loopLengthSec={geom.loopLengthSeconds}
                                      />
                                    )}
                                    <div
                                      className="absolute top-0.5 left-2 text-[9px] font-semibold truncate max-w-[80%] pointer-events-none select-none"
                                      style={{
                                        color: row.color,
                                        opacity: 0.8,
                                      }}
                                    >
                                      {regionUi.muted ? "[M] " : ""}
                                      {row.name}
                                    </div>
                                    {peaksLoading && regionWidth > 40 && (
                                      <div
                                        className="absolute bottom-0.5 left-2 text-[8px] pointer-events-none select-none animate-pulse"
                                        style={{
                                          color: row.color,
                                          opacity: 0.5,
                                        }}
                                      >
                                        peaks…
                                      </div>
                                    )}

                                    {/* Fade overlays (curve only — no handle squares).
                                        Edge zones on the parent set cursor + drag mode. */}
                                    {geom.fadeIn > 0.001 && (
                                      <FadeCurveOverlay
                                        side="in"
                                        widthPx={Math.max(
                                          4,
                                          geom.fadeIn * pxPerSec,
                                        )}
                                        heightPct={100}
                                        curve={geom.fadeInCurve}
                                        color={row.color}
                                        readOnly={readOnly}
                                        onPointerDown={(e) =>
                                          beginDrag(e, "fadeInCurve")
                                        }
                                        onPointerMove={onDragMove}
                                        onPointerUp={onDragUp}
                                      />
                                    )}
                                    {geom.fadeOut > 0.001 && (
                                      <FadeCurveOverlay
                                        side="out"
                                        widthPx={Math.max(
                                          4,
                                          geom.fadeOut * pxPerSec,
                                        )}
                                        heightPct={100}
                                        curve={geom.fadeOutCurve}
                                        color={row.color}
                                        readOnly={readOnly}
                                        onPointerDown={(e) =>
                                          beginDrag(e, "fadeOutCurve")
                                        }
                                        onPointerMove={onDragMove}
                                        onPointerUp={onDragUp}
                                      />
                                    )}

                                    {/* Loop iteration notches (triangles top+bottom). */}
                                    {geom.loop && (() => {
                                      const cycleLen =
                                        geom.loopLengthSeconds &&
                                        geom.loopLengthSeconds > 0
                                          ? geom.loopLengthSeconds
                                          : maxSourceDur;
                                      if (
                                        cycleLen <= 0.05 ||
                                        geom.duration <= cycleLen + 0.01
                                      )
                                        return null;
                                      return Array.from({
                                        length: Math.floor(
                                          geom.duration / cycleLen,
                                        ),
                                      }).map((_, li) => {
                                        const x =
                                          (li + 1) * cycleLen * pxPerSec;
                                        if (x <= 2 || x >= regionWidth - 2)
                                          return null;
                                        return (
                                          <div
                                            key={`loop-${li}`}
                                            className="pointer-events-none absolute top-0 bottom-0 z-[3]"
                                            style={{ left: x }}
                                            title="Loop boundary"
                                          >
                                            <div
                                              className="absolute left-1/2 top-0 -translate-x-1/2"
                                              style={{
                                                width: 0,
                                                height: 0,
                                                borderLeft:
                                                  "4px solid transparent",
                                                borderRight:
                                                  "4px solid transparent",
                                                borderTop: `6px solid ${row.color}`,
                                                opacity: 0.9,
                                              }}
                                            />
                                            <div
                                              className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2"
                                              style={{
                                                background: row.color,
                                                opacity: 0.4,
                                              }}
                                            />
                                            <div
                                              className="absolute left-1/2 bottom-0 -translate-x-1/2"
                                              style={{
                                                width: 0,
                                                height: 0,
                                                borderLeft:
                                                  "4px solid transparent",
                                                borderRight:
                                                  "4px solid transparent",
                                                borderBottom: `6px solid ${row.color}`,
                                                opacity: 0.9,
                                              }}
                                            />
                                          </div>
                                        );
                                      });
                                    })()}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>

              {/* 4. Sticky Playhead (Handle triangle sits stickily on Ruler, needle spans full height) */}
              <div
                ref={playheadRef}
                className="pointer-events-none absolute top-0 z-30 flex flex-col items-center bottom-0"
                style={{
                  transform: "translateX(-50%)",
                }}
              >
                {/* Sticky Playhead Handle resting on Ruler */}
                <div
                  className="sticky top-0 z-30 pointer-events-auto flex flex-col items-center cursor-col-resize select-none -mt-0.5"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancelOrLost}
                  onLostPointerCapture={onPointerCancelOrLost}
                >
                  <div className="h-2 w-2 rotate-45 bg-[#fff]" />
                </div>

                {/* Playhead needle extending through the entire height */}
                <div className="flex-1 w-[1.5px] bg-[#fff] shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
              </div>
            </div>
          </div>
        </div>
      )}

      {regionContextMenu && (() => {
        const song = songs[regionContextMenu.songIndex];
        const songRegion = song?.regions?.find(
          (r) => r.id === regionContextMenu.regionId,
        );
        if (!songRegion || !song) return null;

        const regUi = getRegionUi(regionContextMenu.selKey);

        return (
          <ContextMenu
            x={regionContextMenu.x}
            y={regionContextMenu.y}
            width={180}
            onClose={() => setRegionContextMenu(null)}
          >


            <ContextMenuItem
              onClick={() => {
                setRegionUi(regionContextMenu.selKey, {
                  muted: !regUi.muted,
                });
                setRegionContextMenu(null);
              }}
            >
              {regUi.muted ? "Unmute Region" : "Mute Region"}
            </ContextMenuItem>

            <ContextMenuDivider />

            <ContextMenuItem
              danger
              onClick={() => {
                void builder.regionRemove(
                  regionContextMenu.songIndex,
                  regionContextMenu.regionId,
                );
                setRegionContextMenu(null);
              }}
            >
              Delete Region
            </ContextMenuItem>
          </ContextMenu>
        );
      })()}
    </div>
  );
}

// Beat/bar vertical grid lines drawn on a viewport-sliced canvas, matching Ruler tick density
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

  const { majorStepSec, minorStepSec } = useMemo(
    () => getTickConfig(pxPerSec, bpm, tsNum),
    [pxPerSec, bpm, tsNum],
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportWidth <= 0) return;
    const parent = canvas.parentElement;
    const height = parent ? parent.clientHeight : 300;

    const dpr = window.devicePixelRatio || 1;
    const renderWidth = Math.min(viewportWidth, contentWidth);
    const targetW = Math.max(1, Math.floor(renderWidth * dpr));
    const targetH = Math.max(1, Math.floor(height * dpr));

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${renderWidth}px`;
      canvas.style.height = `${height}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, renderWidth, height);

    if (minorStepSec > 0 && majorStepSec > 0) {
      const startTime = Math.max(0, scrollLeft / pxPerSec);
      const endTime = Math.min(
        songLength + minorStepSec,
        (scrollLeft + viewportWidth) / pxPerSec,
      );
      const startTick = Math.floor(startTime / minorStepSec) * minorStepSec;
      const eps = Math.max(minorStepSec * 0.01, 1e-9);
      // Cap strokes per frame so extreme zoom-out never melts the canvas.
      const maxStrokes = 500;
      let strokes = 0;

      for (
        let t = startTick;
        t <= endTime && strokes < maxStrokes;
        t += minorStepSec
      ) {
        const rounded = Math.round(t / minorStepSec) * minorStepSec;
        const globalX = Math.round(rounded * pxPerSec);
        const canvasX = globalX - scrollLeft;
        if (canvasX < 0 || canvasX > renderWidth) continue;

        const phase = ((rounded % majorStepSec) + majorStepSec) % majorStepSec;
        const isMajor = phase < eps || Math.abs(phase - majorStepSec) < eps;

        ctx.strokeStyle = isMajor
          ? "rgba(255,255,255,0.05)"
          : "rgba(255,255,255,0.015)";
        ctx.lineWidth = isMajor ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(canvasX, 0);
        ctx.lineTo(canvasX, height);
        ctx.stroke();
        strokes += 1;
      }
    }
  }, [
    pxPerSec,
    contentWidth,
    scrollLeft,
    viewportWidth,
    songLength,
    majorStepSec,
    minorStepSec,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute top-0 z-0"
      style={{ left: scrollLeft }}
    />
  );
}
