import { Button, Slider } from "@heroui/react";
import {
  AudioLines,
  Copy,
  Lightbulb,
  Locate,
  LocateFixed,
  LocateOff,
  Magnet,
  MoveHorizontalIcon,
  MoveVerticalIcon,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  builder,
  lighting,
  mixer,
  timelineHistory,
  transport,
} from "../lib/api";
import { getLiveLevels } from "../lib/liveLevels";
import { useContinuousPlayhead, useLiveValue } from "../lib/optimistic";
import { isPositionVisible } from "../lib/timelineVisibility";
import type {
  AllPeaksResponse,
  LightCueRow,
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
import {
  isCompactLane,
  laneHeightPx,
  TrackWaveformLane,
} from "./TrackWaveformLane";
import {
  AudioHintStrip,
  LightHintStrip,
  LightTrackHeader,
  LightTrackLane,
  AUDIO_HINT_HEIGHT,
  LIGHT_COLORS,
  LIGHT_HINT_HEIGHT,
} from "./light/LightTimeline";
import type { CueSelKey } from "./light/LightTimeline";
import { LightSidePanel } from "./light/LightSidePanel";
import type { LightSidePanelSelection } from "./light/LightSidePanel";

const SIDEBAR_WIDTH = 240;
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

/**
 * Compact-lane fill: lower lightness of a hex color, optionally push
 * saturation. Done in HSL (no CSS filter) so hue is preserved.
 * `lightness` / `saturation` are multipliers on the source L / S channels.
 */
function dimHexColor(color: string, lightness: number, saturation = 1): string {
  const m = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3)
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  const n = parseInt(hex, 16);
  let r = ((n >> 16) & 255) / 255;
  let g = ((n >> 8) & 255) / 255;
  let b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      default:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  s = Math.max(0, Math.min(1, s * saturation));
  l = Math.max(0, Math.min(1, l * lightness));
  // HSL → RGB
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const ri = Math.round(r * 255);
  const gi = Math.round(g * 255);
  const bi = Math.round(b * 255);
  return `#${((1 << 24) | (ri << 16) | (gi << 8) | bi).toString(16).slice(1)}`;
}

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
// Density follows verticalZoom so the left rail stays pixel-aligned with
// waveform lanes: compact (name + M/S), normal (+ pan), roomy (+ vol + taller meter).

const TrackHeaderControl = memo(function TrackHeaderControl({
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
  const h = laneHeightPx(verticalZoom);
  // Density tiers keyed to lane height (LANE_HEIGHT=56 at zoom 1).
  const showVol = h >= 48;
  const showPan = h >= 36;
  const showMeter = h >= 28;
  const padY = h < 32 ? 2 : h < 48 ? 4 : h < 80 ? 6 : 8;
  const padX = h < 36 ? 8 : 12;
  const nameSize = h < 32 ? 10 : h < 64 ? 12 : 13;
  const btn = h < 36 ? 16 : h < 72 ? 20 : 22;
  const btnFont = h < 36 ? 8 : 10;
  const knobSize = h < 48 ? 16 : h < 80 ? 20 : 24;
  // Meter fills leftover vertical space next to the name row.
  const meterH = showVol
    ? Math.max(14, Math.round(h * 0.38))
    : Math.max(12, h - padY * 2 - 4);
  const swatchH = h < 32 ? 10 : 14;
  const swatchW = h < 32 ? 6 : 8;

  return (
    <div
      className={`flex flex-col justify-center border-b border-default/15 select-none overflow-hidden transition-opacity duration-300 bg-surface/40 hover:bg-surface/70 ${
        isDimmed ? "opacity-35" : "opacity-100"
      }`}
      style={{
        height: h,
        padding: `${padY}px ${padX}px`,
        gap: showVol ? 4 : 0,
      }}
    >
      {/* Top row: color, name, meter, pan, M/S */}
      <div className="flex min-h-0 min-w-0 flex-1 items-center gap-1.5">
        <span
          className="shrink-0 rounded-sm"
          style={{
            height: swatchH,
            width: swatchW,
            background: color,
            opacity: track.mute ? 0.35 : 1,
          }}
        />
        <span
          className={`min-w-0 flex-1 truncate font-semibold text-foreground/90 ${
            track.mute ? "line-through opacity-40" : ""
          }`}
          style={{ fontSize: nameSize }}
          title={track.name || track.id}
        >
          {track.name || track.id}
        </span>
        {showMeter && (
          <div className="w-3 shrink-0" style={{ height: meterH }}>
            <LevelMeterBar
              db={track.peakDb ?? -100}
              dbL={track.peakDbL ?? track.peakDb ?? -100}
              dbR={track.peakDbR ?? track.peakDb ?? -100}
              getLiveDbL={() =>
                getLiveLevels().tracks[index]?.peakDbL ?? -144
              }
              getLiveDbR={() =>
                getLiveLevels().tracks[index]?.peakDbR ?? -144
              }
              accent={color}
              vertical
              showValue={false}
              barClassName="h-full w-1"
            />
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {showPan && (
            <div
              className="flex items-center gap-0.5"
              title={`Pan: ${formatPan(pan)}`}
            >
              <Knob
                value={pan}
                min={-1}
                max={1}
                defaultValue={0}
                size={knobSize}
                accent={color}
                onCommit={(v) => setPan(v)}
              />
              {h >= 44 && (
                <span
                  className="w-5 text-center font-mono font-medium text-foreground/50"
                  style={{ fontSize: Math.max(7, nameSize - 3) }}
                >
                  {formatPan(pan)}
                </span>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => mixer.setTrackMute(index, !track.mute)}
            className={`rounded font-bold transition-all shadow-sm ${
              track.mute
                ? "bg-danger text-white scale-105"
                : isDimmed
                  ? "bg-danger/80 text-white animate-pulse"
                  : "bg-default/20 text-foreground/50 hover:bg-default/35 hover:text-foreground"
            }`}
            style={{ height: btn, width: btn, fontSize: btnFont }}
            title="Mute"
          >
            M
          </button>

          <button
            type="button"
            onClick={() => mixer.setTrackSolo(index, !track.solo)}
            className={`rounded font-bold transition-all shadow-sm ${
              track.solo
                ? "bg-warning text-black scale-105"
                : "bg-default/20 text-foreground/50 hover:bg-default/35 hover:text-foreground"
            }`}
            style={{ height: btn, width: btn, fontSize: btnFont }}
            title="Solo"
          >
            S
          </button>
        </div>
      </div>

      {showVol && (
        <div
          className="flex shrink-0 items-center gap-1.5 font-mono text-foreground/60"
          style={{ fontSize: Math.max(8, nameSize - 3) }}
        >
          <span className="shrink-0 uppercase tracking-wider font-semibold text-foreground/40">
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
          <span
            className="w-8 shrink-0 text-right font-medium tabular-nums"
            style={{ fontSize: Math.max(8, nameSize - 2) }}
          >
            {gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1)}
          </span>
        </div>
      )}
    </div>
  );
},
// Peak levels now animate off the live binary telemetry (getLiveDb* above),
// not this prop -- so a `track` update that only bumps peakDb/peakDbL/peakDbR
// (i.e. every WS frame during playback) shouldn't force a re-render of the
// whole header row. Compare only the fields that actually affect output.
(prev, next) =>
  prev.index === next.index &&
  prev.color === next.color &&
  prev.verticalZoom === next.verticalZoom &&
  prev.anySolo === next.anySolo &&
  prev.track.id === next.track.id &&
  prev.track.name === next.track.name &&
  prev.track.mute === next.track.mute &&
  prev.track.solo === next.track.solo &&
  prev.track.gainDb === next.track.gainDb &&
  prev.track.pan === next.track.pan,
);

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
  return tc.minorStepSec > 0 ? tc.minorStepSec : 60 / bpm;
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

  // Quantize OUTSIDE the mark list so the memo only invalidates every 250px
  // of pan -- not on every follow/scrollState tick. Raw scrollLeft in the
  // dep array rebuilt the whole mark list every frame and, with key={idx},
  // React recycled tick nodes onto the next mark's position ("сетка прыгает").
  const quantizedLeft = Math.max(
    0,
    Math.floor((scrollLeft || 0) / 250) * 250 - 250,
  );
  const bufferedWidth = (viewportWidth || 1200) + 500;

  const marks = useMemo(() => {
    const list: { x: number; major: boolean; label?: string }[] = [];
    if (minorStepSec <= 0 || majorStepSec <= 0) return list;

    const startTime = Math.max(0, quantizedLeft / pxPerSec);
    const endTime = Math.min(
      songLength + majorStepSec,
      (quantizedLeft + bufferedWidth) / pxPerSec + minorStepSec,
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
    quantizedLeft,
    bufferedWidth,
  ]);

  return (
    <div
      className="relative select-none border-b border-default/30 bg-background-tertiary shrink-0"
      style={{ height: RULER_HEIGHT, width: contentWidth }}
    >
      {marks.map(({ x, major, label }) => (
        <div key={x} className="absolute bottom-0" style={{ left: x }}>
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
    const snappedLocal = snapToGridSec(
      localSeconds,
      pxPerSec,
      bpm,
      tsNum,
      snapToGrid,
    );
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
const TimelineRowLabel = memo(function TimelineRowLabel({
  name,
  color,
  verticalZoom,
}: {
  name: string;
  color: string;
  verticalZoom: number;
}) {
  const h = laneHeightPx(verticalZoom);
  const padX = h < 36 ? 8 : 12;
  const nameSize = h < 32 ? 10 : h < 64 ? 12 : 13;
  const swatchH = h < 32 ? 10 : 14;
  const swatchW = h < 32 ? 6 : 8;
  return (
    <div
      className="flex items-center gap-2 border-b border-default/15 select-none overflow-hidden bg-surface/20 opacity-60"
      style={{ height: h, padding: `0 ${padX}px` }}
    >
      <span
        className="shrink-0 rounded-sm"
        style={{ height: swatchH, width: swatchW, background: color }}
      />
      <span
        className="truncate font-medium text-foreground/60"
        style={{ fontSize: nameSize }}
        title={name}
      >
        {name}
      </span>
    </div>
  );
});

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
  // Read live (never as a render dependency) by both the follow rAF loop
  // below and useContinuousPlayhead's own reconciliation effects -- a
  // playhead drag is a direct manipulation of the transport and must
  // synchronously suspend both auto-follow AND server-value correction
  // before React has had any chance to render a state update.
  const dragging = useRef(false);
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;
  const pendingScrollLeftRef = useRef<number | null>(null);

  // Sidebar (track header list) vertical mirror. The list sits outside the
  // right scroller, so we apply translateY(-scrollTop) imperatively from
  // onScroll (sync with the browser) + rAF as a safety net — never via
  // React state (that lagged a frame and skew-synced track labels).
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({
    scrollLeft: 0,
    viewportWidth: 1000,
  });

  // ZOOM-only flag feeding the playhead clock FREEZE below. Declared here so
  // the clock hook can read it; the setter lives with the other gesture
  // plumbing (see markZoomActiveRef).
  const [zoomActive, setZoomActive] = useState(false);

  // ONE continuous absolute clock for the whole project. Song-local time is
  // derived below -- never a second independent rAF loop keyed on songIndex
  // (that reset/fought across gapless boundaries and felt like two timelines).
  // `zoomActive` FREEZES the clock while a zoom gesture is in progress so the
  // playhead marker holds still ("автостоп времени при зуме"); it resumes
  // (and softly re-corrects toward the engine) the moment the zoom settles.
  const [playheadAbsoluteSec, setPlayheadAbsoluteSec, getLivePlayheadAbsolute] =
    useContinuousPlayhead(
      state.globalPlayheadSeconds,
      state.playing,
      state.projectName,
      zoomActive,
      dragging,
    );
  // Live clock getter for the rAF follow/marker loop -- never go through the
  // React-state mirror (playheadAbsoluteSec), which can lag a commit behind
  // the rAF that advances the clock and made smooth-follow advance in steps.
  const getLivePlayheadAbsoluteRef = useRef(getLivePlayheadAbsolute);
  getLivePlayheadAbsoluteRef.current = getLivePlayheadAbsolute;

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
      if (saved === "off" || saved === "snap" || saved === "smooth")
        return saved;
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
    setFollowMode((m) =>
      m === "off" ? "snap" : m === "snap" ? "smooth" : "off",
    );

  // Dual-mode Audio/Light timeline (Editor only -- the Player Timeline stays
  // audio-only; RESTORE_POINT.md Feature 6). Per-instance, persisted exactly
  // like followMode above. Player is forced to audio via effectiveViewMode.
  type ViewMode = "audio" | "light";
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem("resostage.timeline.viewMode");
      if (saved === "audio" || saved === "light") return saved;
    } catch {
      // localStorage unavailable (e.g. private mode) -- fall through to default
    }
    return "audio";
  });
  useEffect(() => {
    try {
      localStorage.setItem("resostage.timeline.viewMode", viewMode);
    } catch {
      // best-effort persistence only
    }
  }, [viewMode]);
  const effectiveViewMode: ViewMode = readOnly ? "audio" : viewMode;

  // Selected light cue (Light-mode editor), drives the cue editor panel.
  const [cueSelection, setCueSelection] = useState<CueSelKey | null>(null);
  // Track selection for the side panel
  const [sidePanelTrackIndex, setSidePanelTrackIndex] = useState<number | null>(
    null,
  );
  // Leave editing when switching away from Light mode.
  useEffect(() => {
    if (effectiveViewMode !== "light") {
      setCueSelection(null);
      setSidePanelTrackIndex(null);
    }
  }, [effectiveViewMode]);

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
    }, 700);
  });
  // ZOOM-only flag feeding the playhead clock FREEZE: while the user is
  // zooming, the transport keeps playing but the timeline's clock must stand
  // still so the playhead marker doesn't creep left-right against the
  // zoom-focus anchor ("плейхед должен стоять на месте во время зума").
  // Deliberately NOT set by manual horizontal scrolling -- looking around must
  // never pause time, only a zoom gesture should.
  //
  // Each of the two flags gets its OWN timer: they fire together during a
  // pinch, and if they shared a single timer, markZoomActive's write would
  // overwrite (clear) the timer that resets gestureActiveNowRef, so a pinch
  // whose gestureend was lost would leave gestureActiveNowRef stuck true --
  // which permanently disabled auto-scroll in EVERY follow mode
  // ("автоскролл не пашет никакой теперь").
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markZoomActiveRef = useRef(() => {
    setZoomActive(true);
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = setTimeout(() => {
      setZoomActive(false);
    }, 700);
  });
  // Explicit end-of-gesture clear. The settle timer above is a fallback for
  // when a gesturechange burst stalls (a slow pinch can emit events more
  // sparsely than the timer window), but the browser ALSO fires gestureend /
  // touchend when the fingers lift -- clearing here makes the end exact
  // instead of waiting out the timer, and guarantees the zoom flag can't
  // outlive the fingers ("пинч периодически прерывается" was the timer
  // firing mid-gesture, flipping zoomActive off and unfreezing the clock
  // while fingers were still down).
  const endGestureRef = useRef(() => {
    gestureActiveNowRef.current = false;
    setGestureActive(false);
    setZoomActive(false);
    if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
    gestureTimerRef.current = null;
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = null;
  });
  // Set right before the auto-follow effect (or the zoom-focus effect)
  // writes scroller.scrollLeft programmatically -- onScrollSync checks this
  // to tell "we just scrolled ourselves" apart from a real user drag/wheel/
  // scrollbar interaction. Native `scroll` events fire for BOTH; without
  // this, continuous "smooth" auto-follow (writing scrollLeft every frame)
  // kept re-triggering markGestureActiveRef on its own scroll events, so its
  // settle timer never got a chance to fire and gestureActive was
  // permanently stuck true during autofollow -- pinning every waveform to
  // coarse/low-detail rendering (see WaveformLane's `gestureActive` checks)
  // AND making onScrollSync's own setScrollState fight the auto-follow
  // effect's synchronous one every frame (their async native-event timing
  // vs. the effect's synchronous write don't line up), both of which read as
  // constant waveform/playhead jitter.
  // The exact horizontal value written by our follow/zoom loop.  A boolean
  // was racy: a vertical native scroll event could consume it and make a
  // later delayed horizontal echo look user-originated (or vice versa).
  const programmaticScrollLeftRef = useRef<number | null>(null);
  // Companion to programmaticScrollLeftRef for continuous "smooth" follow:
  // that loop writes scrollLeft on EVERY rAF frame, but the browser coalesces
  // native `scroll` events, so by the time one fires it can echo an OLDER
  // write that's already been superseded by several newer ones -- the exact-
  // pixel comparison above then misses (the position moved on since), and
  // onScrollSync wrongly treated ITS OWN continuous auto-scroll as a user
  // gesture, pausing autofollow for 700ms, over and over
  // ("смотри такую вещь ... рывками и плейхед и таймлайн показывает"). Any
  // scroll event landing shortly after ANY programmatic write is still
  // almost certainly an echo of ours, regardless of exact pixel match.
  const lastProgrammaticWriteAtRef = useRef(0);
  const ECHO_GRACE_MS = 200;
  // Non-null while the smooth-follow rAF branch is actively driving
  // scrollLeft. onScrollSync treats any event near this value as an engine
  // echo (not a user fight), so continuous follow can never pause itself.
  const followEngineScrollRef = useRef<number | null>(null);
  // Last scrollLeft seen by onScrollSync, to tell a genuine HORIZONTAL user
  // scroll apart from a vertical-only one. Vertical scrolling must NOT pause
  // auto-follow (it doesn't fight the horizontal autoscroll) -- only a
  // horizontal user scroll or a zoom gesture should.
  const lastScrollLeftRef = useRef<number | null>(null);
  // Last scrollLeft we actually pushed into React scrollState. Separate from
  // lastScrollLeftRef: the follow-echo path in onScrollSync updates the latter
  // every frame (so gesture detection stays accurate), which made the rAF
  // "moved > N px" check always see 0 delta and NEVER re-render BeatGrid /
  // ruler / viewport-culled waveforms during smooth follow.
  const lastCommittedScrollLeftRef = useRef<number | null>(null);
  const lastScrollStateCommitAtRef = useRef(0);

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

  // Light-cue clipboard (parallel to clipboardRegions for audio regions).
  interface CueClipboardEntry extends LightCueRow {
    songIndex: number;
  }
  const clipboardCues = useRef<CueClipboardEntry[]>([]);

  // ── Light-cue editing actions (mirror of the audio-region equivalents) ──

  const copySelectedCue = () => {
    if (!cueSelection) return;
    const cue = songs[cueSelection.songIndex]?.lightCues?.find(
      (c) => c.id === cueSelection.cueId,
    );
    if (!cue) return;
    clipboardCues.current = [{ ...cue, songIndex: cueSelection.songIndex }];
    showToast("Copied light cue");
  };

  const deleteSelectedCue = () => {
    if (!cueSelection) return;
    void lighting.cueRemove(cueSelection.songIndex, cueSelection.cueId);
    setCueSelection(null);
    showToast("Deleted light cue");
  };

  const duplicateSelectedCue = async () => {
    if (!cueSelection) return;
    const cue = songs[cueSelection.songIndex]?.lightCues?.find(
      (c) => c.id === cueSelection.cueId,
    );
    if (!cue) return;
    await lighting.cueAdd(
      cueSelection.songIndex,
      cue.trackId,
      cue.startSeconds,
      cue.durationSeconds,
      {
        colorR: cue.colorR,
        colorG: cue.colorG,
        colorB: cue.colorB,
        intensity: cue.intensity,
        fadeInSeconds: cue.fadeInSeconds,
        fadeOutSeconds: cue.fadeOutSeconds,
        label: cue.label,
        effectType: cue.effectType,
        effectSourceType: cue.effectSourceType,
        effectSourceId: cue.effectSourceId,
        effectIntensity: cue.effectIntensity,
        tempoSync: cue.tempoSync,
        tempoSubdiv: cue.tempoSubdiv,
        effectRateHz: cue.effectRateHz,
        gradientPreset: cue.gradientPreset,
        gradientColors: cue.gradientColors,
      },
    );
    showToast("Duplicated light cue");
  };

  const pasteClipboardCues = async () => {
    const items = clipboardCues.current;
    if (items.length === 0) return;
    const gestureId = crypto.randomUUID();
    for (const entry of items) {
      await lighting.cueAdd(
        entry.songIndex,
        entry.trackId,
        entry.startSeconds,
        entry.durationSeconds,
        {
          colorR: entry.colorR,
          colorG: entry.colorG,
          colorB: entry.colorB,
          intensity: entry.intensity,
          fadeInSeconds: entry.fadeInSeconds,
          fadeOutSeconds: entry.fadeOutSeconds,
          label: entry.label,
          effectType: entry.effectType,
          effectSourceType: entry.effectSourceType,
          effectSourceId: entry.effectSourceId,
          effectIntensity: entry.effectIntensity,
          tempoSync: entry.tempoSync,
          tempoSubdiv: entry.tempoSubdiv,
          effectRateHz: entry.effectRateHz,
          gradientPreset: entry.gradientPreset,
          gestureId,
        },
      );
    }
    showToast(`Pasted ${items.length} light cue(s)`);
  };

  const splitSelectedCueAtPlayhead = async () => {
    if (!cueSelection) {
      showToast("Select a cue to trim");
      return;
    }
    const cue = songs[cueSelection.songIndex]?.lightCues?.find(
      (c) => c.id === cueSelection.cueId,
    );
    if (!cue) return;

    const songStart = songOffsets[cueSelection.songIndex] ?? 0;
    const localPlayhead = playheadAbsoluteSec - songStart;
    const cueEnd = cue.startSeconds + cue.durationSeconds;

    if (
      localPlayhead <= cue.startSeconds + 0.05 ||
      localPlayhead >= cueEnd - 0.05
    ) {
      showToast("Playhead is not inside the selected cue");
      return;
    }

    const leftDur = localPlayhead - cue.startSeconds;
    const rightDur = cueEnd - localPlayhead;
    const gestureId = crypto.randomUUID();

    // Trim left half (clear fade-out so it doesn't ramp through the cut).
    await lighting.cueUpdate({
      songIndex: cueSelection.songIndex,
      cueId: cue.id,
      durationSeconds: leftDur,
      fadeOutSeconds: 0,
      gestureId,
    });

    // Add right half with all cue properties, clearing the fade-in at the cut.
    await lighting.cueAdd(
      cueSelection.songIndex,
      cue.trackId,
      localPlayhead,
      rightDur,
      {
        colorR: cue.colorR,
        colorG: cue.colorG,
        colorB: cue.colorB,
        intensity: cue.intensity,
        fadeInSeconds: 0,
        fadeOutSeconds: cue.fadeOutSeconds,
        label: cue.label,
        effectType: cue.effectType,
        effectSourceType: cue.effectSourceType,
        effectSourceId: cue.effectSourceId,
        effectIntensity: cue.effectIntensity,
        tempoSync: cue.tempoSync,
        tempoSubdiv: cue.tempoSubdiv,
        effectRateHz: cue.effectRateHz,
        gradientPreset: cue.gradientPreset,
        gestureId,
      },
    );

    showToast("Split cue at playhead");
    setCueSelection(null);
  };

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
      if (hit)
        void builder.regionRemove(hit.songIndex, hit.region.id, gestureId);
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
      // Exact project length -- a 120s floor used to leave a long empty
      // tail the user could scroll into past the last song.
      totalLength: Math.max(acc, 1),
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

  // Light-mode derived data (Feature 6). Guarded with optional chaining so an
  // older WebUiState snapshot without the lighting fields still renders.
  const lightTracks = useMemo(
    () => state.lightTracks ?? [],
    [state.lightTracks],
  );
  const lightFixtures = useMemo(
    () => state.lighting?.fixtures ?? [],
    [state.lighting?.fixtures],
  );
  const lightEnabled = Boolean(state.lighting?.enabled);
  const lightTrackColor = (index: number) =>
    LIGHT_COLORS[Math.max(0, index) % LIGHT_COLORS.length];
  const lightTrackColorForId = (trackId: string) =>
    lightTrackColor(lightTracks.findIndex((t) => t.id === trackId));
  const hasLightContent =
    lightEnabled &&
    (lightTracks.length > 0 ||
      songs.some((s) => (s.lightCues ?? []).length > 0));

  // Live 3D stage colors come only from the core binary LED stream
  // (LightSidePanel). Do not re-resolve cues on the frontend.
  const previewColors = useMemo(
    () =>
      ({}) as Record<
        string,
        import("../lib/lightCueInterpolation").LightCueValue
      >,
    [],
  );

  // Derived side-panel selection (after songs, lightTracks, cueSelection are defined)
  const sidePanelSelection: LightSidePanelSelection | null = (() => {
    if (effectiveViewMode !== "light") return null;
    if (cueSelection) {
      const song = songs[cueSelection.songIndex];
      const cue = song?.lightCues?.find((c) => c.id === cueSelection.cueId);
      if (cue) {
        const tIdx = lightTracks.findIndex((t) => t.id === cue.trackId);
        if (tIdx >= 0)
          return {
            type: "cue" as const,
            songIndex: cueSelection.songIndex,
            cue,
            trackIndex: tIdx,
            track: lightTracks[tIdx],
          };
      }
    }
    if (sidePanelTrackIndex !== null && lightTracks[sidePanelTrackIndex]) {
      return {
        type: "track" as const,
        trackIndex: sidePanelTrackIndex,
        track: lightTracks[sidePanelTrackIndex],
      };
    }
    return null;
  })();

  // Drop cue selection when the cue itself disappears (delete / reload).
  useEffect(() => {
    if (!cueSelection) return;
    const song = songs[cueSelection.songIndex];
    const cue = song?.lightCues?.find((c) => c.id === cueSelection.cueId);
    if (!cue) setCueSelection(null);
  }, [songs, cueSelection]);

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

    // Anchor the zoom at the actual gesture focus -- the cursor for wheel-zoom,
    // the pinch midpoint for pinch, the viewport center for the slider. The
    // playhead is NOT pinned while zooming: it just sits at its natural
    // document position (the rAF loop snaps it to px during a gesture), so
    // whatever is under the cursor/fingers stays exactly under them through
    // the zoom ("пинчится не совсем точно там где нужно"). The old
    // marker-anchored pin drifted away from the pinch midpoint and landed
    // somewhere else when the gesture ended.
    let focusX =
      typeof focusClientX === "number"
        ? focusClientX - rect.left
        : rect.width / 2;
    if (focusX < 0 || focusX > rect.width) focusX = rect.width / 2;

    // Base for the incremental zoom step: use the pending (not-yet-committed)
    // target if the layout effect hasn't applied the previous step yet --
    // otherwise rapid successive wheel/pinch steps would all read the stale
    // DOM scrollLeft and lose the intermediate increments.
    const currentScrollLeft =
      pendingScrollLeftRef.current !== null
        ? pendingScrollLeftRef.current
        : scroller.scrollLeft;

    const newScrollLeftWanted = k * (currentScrollLeft + focusX) - focusX;

    pxPerSecRef.current = clampedNext;
    pendingScrollLeftRef.current = Math.max(0, newScrollLeftWanted);

    setPxPerSec(clampedNext);
  };

  // Apply the zoom-focus scroll target AND the playhead marker in ONE atomic
  // batch, synchronously before paint. This is the ONLY writer of scrollLeft
  // during a zoom gesture: applyZoomAt only queues the target refs above, and
  // the rAF loop's follow/reveal branches are disabled while a gesture is
  // active (gestureActiveNowRef). A single writer keeps the timeline content
  // and the marker in lockstep -- two writers (e.g. an earlier version also
  // applying the pending value inside the rAF tick) fought each other and
  // wobbled the whole timeline ("колбасит не только плейхед но и таймлайн").
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
        scroller.scrollLeft = targetScrollLeft;
        programmaticScrollLeftRef.current = scroller.scrollLeft;
        lastProgrammaticWriteAtRef.current = performance.now();
        // Marker: same document position the rAF loop derives during a gesture
        // (playheadAbsoluteSec * pxPerSec -- the clock is frozen while
        // zooming). Writing it here, in the same commit as the scroll write,
        // means the two can never land a frame apart.
        const px = playheadAbsoluteSecRef.current * pxPerSecRef.current;
        if (playheadRef.current) playheadRef.current.style.left = `${px}px`;
        if (playheadHandleRef.current)
          playheadHandleRef.current.style.left = `${px}px`;
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
        markZoomActiveRef.current();

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
      markGestureActiveRef.current();
      markZoomActiveRef.current();
    };

    const handleGestureChange = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      markGestureActiveRef.current();
      markZoomActiveRef.current();
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
      endGestureRef.current();
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
    const snappedLocal = snapToGridSec(
      localSeconds,
      pxPerSecRef.current,
      bpm,
      tsNum,
      snapToGrid,
    );

    // Clamp into the resolved song's authored length so we never seek past EOF.
    const songLen = songLengths[songIndex] ?? 0;
    const songStart = songOffsets[songIndex] ?? 0;
    const clampedLocal =
      songLen > 0
        ? Math.min(snappedLocal, Math.max(0, songLen - 0.01))
        : snappedLocal;
    const clampedAbs = songStart + clampedLocal;

    // Optimistic absolute needle moves immediately (one continuous timeline).
    // The commit lock only needs to bridge a real seek + one WS telemetry
    // turn now that useContinuousPlayhead no longer has a proximity-based
    // early release to race against -- see optimistic.ts's draggingRef doc.
    setPlayheadAbsoluteSec(clampedAbs, commit ? 800 : undefined);

    // Engine seeks only on commit (pointer up). Mid-drag same-song seeks used
    // to restage every 60ms and produced the "chirp then stop then play" glitch.
    if (!commit) return;

    if (songIndex !== state.songIndex) {
      void transport.seek(clampedLocal, songIndex);
      return;
    }
    void transport.seek(clampedLocal);
  };

  // Light-lane coordinate helpers (mirror seekFromClientX's math): absolute
  // project seconds from a clientX, and grid-snapped local seconds.
  const toAbsSec = (clientX: number) => {
    const bodyEl = timelineBodyRef.current;
    if (!bodyEl) return 0;
    const rect = bodyEl.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / pxPerSecRef.current);
  };
  const snapLocalSec = (songIndex: number, localSeconds: number) => {
    const song = songs[songIndex];
    if (!song) return localSeconds;
    return snapToGridSec(
      localSeconds,
      pxPerSecRef.current,
      song.bpm,
      song.tsNum ?? 4,
      snapToGrid,
    );
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
      // Lost button state is still a completed drop; never discard it.
      seekFromClientX(e.clientX, true);
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
  const onPointerCancelOrLost = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    // A drag can end via pointercancel/lostpointercapture instead of a clean
    // pointerup (capture lost to a mid-drag re-render, a trackpad gesture
    // reinterpretation, alt-tab mid-drag) -- still commit the seek, or the
    // optimistic marker the user just dropped silently snaps back to the
    // pre-drag position once optimistic.ts's reconciliation lock expires,
    // making the drag look like it "didn't apply."
    seekFromClientX(e.clientX, true);
  };

  const onScrollSync = (e: React.UIEvent<HTMLDivElement>) => {
    // Vertical sidebar mirror: write HERE (scroll event is sync with the
    // browser's scroll position) so the left track list never lags a frame
    // behind the right pane. rAF only re-applies as a safety net.
    const scroller = e.currentTarget;
    if (sidebarContentRef.current)
      sidebarContentRef.current.style.transform = `translate3d(0, -${scroller.scrollTop}px, 0)`;
    // Hard-clamp past the real content end (macOS rubber-band / trackpad
    // can report scrollLeft beyond scrollWidth-clientWidth briefly).
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    if (scroller.scrollLeft < 0) scroller.scrollLeft = 0;
    else if (scroller.scrollLeft > maxLeft) scroller.scrollLeft = maxLeft;
    const left = scroller.scrollLeft;
    const programmedLeft = programmaticScrollLeftRef.current;
    const exactEcho =
      programmedLeft !== null && Math.abs(left - programmedLeft) < 0.5;
    // Coalesced echo: a programmatic write landed very recently (continuous
    // "smooth" follow writes every rAF frame, faster than the browser
    // necessarily dispatches `scroll` events for each one) -- see
    // lastProgrammaticWriteAtRef's doc comment.
    const recentEcho =
      performance.now() - lastProgrammaticWriteAtRef.current < ECHO_GRACE_MS;
    // Continuous smooth-follow owns the scroller. Any event within a few
    // pixels of the engine target is an echo of our own write (browser
    // rounding / delayed coalesced events), NOT a user fight. Only a real
    // manual drag that pulls the viewport away from the follow anchor
    // should pause autofollow -- without this, own scroll events flipped
    // gestureActive every ~150ms and the timeline stuttered in 700ms chunks.
    const followTarget = followEngineScrollRef.current;
    const followEcho =
      followTarget !== null && Math.abs(left - followTarget) < 32;
    if (exactEcho || recentEcho || followEcho) {
      // Echo of our own auto-follow/zoom-focus write. Do NOT touch
      // lastCommittedScrollLeftRef here -- the rAF loop is the sole owner of
      // React scrollState during follow. Only keep lastScrollLeftRef fresh so
      // a later real user drag is measured correctly.
      lastScrollLeftRef.current = left;
      return;
    }
    // A true user horizontal move supersedes any delayed programmatic echo.
    programmaticScrollLeftRef.current = null;
    followEngineScrollRef.current = null;
    // null means "no baseline yet" (mount / scroll-restore) -- that first
    // event never counts as a user fight.
    const movedHorizontally =
      lastScrollLeftRef.current !== null && left !== lastScrollLeftRef.current;
    lastScrollLeftRef.current = left;
    lastCommittedScrollLeftRef.current = left;
    lastScrollStateCommitAtRef.current = performance.now();
    // Vertical-only scroll (scrollTop changed, scrollLeft didn't) is not a
    // user fight for the horizontal timeline -- don't pause auto-follow for
    // it ("при вертикальном скролле стопается автоскролл").
    if (movedHorizontally) {
      markGestureActiveRef.current();
    }
    setScrollState({
      scrollLeft: left,
      viewportWidth: scroller.clientWidth,
    });
  };

  // Editor hotkeys: region copy / paste / delete / select-all (audio mode)
  // and cue copy / paste / delete / split (light mode).
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

      if (effectiveViewMode === "light") {
        // ── Light-cue hotkeys ──
        if (mod && e.key === "c") {
          e.preventDefault();
          copySelectedCue();
        } else if (mod && e.key === "v") {
          e.preventDefault();
          void pasteClipboardCues();
        } else if (mod && e.key === "d") {
          e.preventDefault();
          void duplicateSelectedCue();
        } else if (mod && e.key === "t") {
          e.preventDefault();
          void splitSelectedCueAtPlayhead();
        } else if (e.key === "Backspace" || e.key === "Delete") {
          if (!cueSelection) return;
          e.preventDefault();
          deleteSelectedCue();
        } else if (e.key === "Escape") {
          setCueSelection(null);
        }
      } else {
        // ── Audio-region hotkeys ──
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    readOnly,
    effectiveViewMode,
    cueSelection,
    selectedRegionKeys,
    state.songs,
    playheadAbsoluteSec,
    songOffsets,
    songLengths,
  ]);

  const currentSongIdx = state.songIndex >= 0 ? state.songIndex : 0;

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
  const contentWidthRef = useRef(contentWidth);
  contentWidthRef.current = contentWidth;
  const followModeRef = useRef(followMode);
  followModeRef.current = followMode;
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;
  const currentSongIdxRef = useRef(currentSongIdx);
  currentSongIdxRef.current = currentSongIdx;

  // Auto-scroll to keep the playhead in view lives ENTIRELY in the dedicated
  // rAF loop below -- one code path for every follow mode, so every kind of
  // move (continuous smooth follow, "snap"-mode edge pans, and reveals on
  // song change / stop / far seek) is a smooth bounded-duration glide rather
  // than a teleport. Driving it from React's render cycle instead is what
  // produced the cross-render timing jitter fixed earlier. followMode="off"
  // only opts out of being continuously yanked around DURING playback; a
  // deliberate song pick or a stop still brings the playhead into view, same
  // as clicking an item in a list still scrolls to it even with "autoscroll"
  // off elsewhere in this app.

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
  // Ruler uses real CSS position:sticky (see markup). Do NOT emulate sticky
  // with translateY(scrollTop): native scroll paints on the compositor one
  // frame before JS can counter-translate → vertical jitter.
  // Playhead: needle is absolute full-height; the triangle handle lives INSIDE
  // the sticky ruler (sticky inside absolute is broken — handle would stick to
  // the playhead box, not the scrollport).
  const playheadRef = useRef<HTMLDivElement>(null);
  const playheadHandleRef = useRef<HTMLDivElement>(null);

  // Left sidebar track list lives OUTSIDE the right scroller; mirror its
  // vertical offset from the right pane's scrollTop. Applied synchronously
  // from onScroll (and rAF as a safety net) — never via React state.
  const syncSidebarScrollMirror = () => {
    const scroller = scrollRef.current;
    if (!scroller || !sidebarContentRef.current) return;
    const st = scroller.scrollTop;
    sidebarContentRef.current.style.transform = `translate3d(0, -${st}px, 0)`;
  };

  useEffect(() => {
    let raf = 0;
    // Engine-owned scrollLeft; null while idle (not following / not panning).
    let engineScrollLeft: number | null = null;
    let displayPx = playheadAbsoluteSecRef.current * pxPerSecRef.current;
    // Reveal-pan state: the scroll position being animated toward a reveal
    // target; null when no reveal is in flight.
    let revealScroll: number | null = null;
    // Pan engine state, captured by startPan() when a pan begins or when the
    // target jumps further away mid-pan. panStartDist also decides the regime
    // in glide(): real pan (ease-out curve) vs. follow wobble (exponential).
    let panStartDist = 0;
    let panFrom = 0;
    let panElapsedFrames = 0;
    // Last position the reveal logic compared against, to detect a LARGE
    // jump. Updating it every idle frame is what makes ordinary pauses and
    // manual scrolls never fire a reveal.
    let lastRevealPx = displayPx;
    let lastSongIdx = currentSongIdxRef.current;
    const placePlayhead = (px: number) => {
      if (playheadRef.current) playheadRef.current.style.left = `${px}px`;
      if (playheadHandleRef.current)
        playheadHandleRef.current.style.left = `${px}px`;
    };
    placePlayhead(displayPx);
    syncSidebarScrollMirror();
    let firstTick = true;

    const tick = () => {
      // Sidebar mirror safety net (primary write is onScroll — see below).
      syncSidebarScrollMirror();

      // Live playhead from the clock's own ref -- not the React-state mirror
      // (playheadAbsoluteSecRef), which only updates on commit and can lag
      // behind the clock rAF by one or more frames.
      // pxPerSecRef.current (NOT a render-copied mirror): applyZoomAt writes
      // it synchronously on every wheel/pinch tick, so this loop computes the
      // playhead's document position with the zoom scale CURRENT the same
      // frame the zoom-focus scroll is applied -- no one-frame stale-scale
      // gap, which made the marker wobble left-right during a zoom gesture.
      const liveSec = getLivePlayheadAbsoluteRef.current();
      const px = liveSec * pxPerSecRef.current;
      playheadAbsoluteSecRef.current = liveSec;
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
        playingRef.current &&
        !gestureActiveNowRef.current &&
        !dragging.current &&
        followModeRef.current === "smooth";
      const scroller = scrollRef.current;
      const viewWidth = scroller ? scroller.clientWidth || 1000 : 1000;
      // Prefer the live DOM max (scrollWidth) over the React contentWidth
      // mirror -- after zoom/layout the two can lag a frame and writing past
      // the real max felt like "scrolling into empty space".
      const maxScrollLeft = scroller
        ? Math.max(0, scroller.scrollWidth - scroller.clientWidth)
        : Math.max(0, contentWidthRef.current - viewWidth);
      const target = Math.min(
        maxScrollLeft,
        Math.max(0, px - viewWidth * 0.25),
      );

      // Begin (or re-anchor) a pan from `fromPos` toward the current target.
      const startPan = (fromPos: number) => {
        panStartDist = Math.abs(target - fromPos);
        panFrom = fromPos;
        panElapsedFrames = 0;
      };

      // Step `from` toward `target`. Three regimes:
      //  - REAL PAN: ease-out over ~PAN_FRAMES for song changes / large jumps.
      //  - STEADY FOLLOW (following===true): pin scrollLeft to the moving
      //    playhead-anchored target every frame. Target already advances
      //    with the live clock -- free-running at dt*pxPerSec drifted.
      //  - SNAP/REVEAL catch-up: exponential approach for medium pans.
      const glide = (from: number) => {
        const diff = target - from;
        const dist = Math.abs(diff);
        if (dist < 0.5) return target;
        const PAN_FRAMES = 18; // ~0.3s
        if (panStartDist > viewWidth * 0.25 && panElapsedFrames < PAN_FRAMES) {
          panElapsedFrames++;
          const t = Math.min(1, panElapsedFrames / PAN_FRAMES);
          const f = 1 - (1 - t) ** 3; // easeOutCubic
          const next = panFrom + (target - panFrom) * f;
          if (t >= 1) panStartDist = 0; // pan done
          return next;
        }
        panStartDist = 0;
        if (following) return target;
        const step = Math.max(dist * 0.25, 1);
        return diff > 0 ? from + step : from - step;
      };

      if (following && scroller) {
        revealScroll = null;
        if (engineScrollLeft === null) {
          engineScrollLeft = scroller.scrollLeft;
          startPan(engineScrollLeft);
        } else {
          // Target jumped further away mid-pan (e.g. another song change) --
          // re-anchor the ease-out curve so it restarts fast.
          const still = Math.abs(target - engineScrollLeft);
          if (still > panStartDist) startPan(engineScrollLeft);
        }
        engineScrollLeft = Math.min(
          maxScrollLeft,
          Math.max(0, glide(engineScrollLeft)),
        );
        scroller.scrollLeft = engineScrollLeft;
        engineScrollLeft = scroller.scrollLeft; // re-read in case browser clamped it
        // Always mark as programmatic while following, even if the write was
        // a sub-pixel no-op -- keeps onScrollSync's echo window fresh.
        programmaticScrollLeftRef.current = engineScrollLeft;
        lastProgrammaticWriteAtRef.current = performance.now();
        followEngineScrollRef.current = engineScrollLeft;
        // Commit React scrollState from THIS loop only, using a dedicated
        // ref that onScrollSync echoes do not touch. BeatGrid / Ruler /
        // viewport-culled peaks all read scrollState -- if we skip this,
        // the timeline scrolls under a frozen grid/waveform layer.
        const nowCommit = performance.now();
        const movedSinceCommit = Math.abs(
          (lastCommittedScrollLeftRef.current ?? Infinity) - engineScrollLeft,
        );
        if (
          movedSinceCommit > 8 ||
          nowCommit - lastScrollStateCommitAtRef.current > 50
        ) {
          lastCommittedScrollLeftRef.current = engineScrollLeft;
          lastScrollStateCommitAtRef.current = nowCommit;
          lastScrollLeftRef.current = engineScrollLeft;
          setScrollState({
            scrollLeft: engineScrollLeft,
            viewportWidth: viewWidth,
          });
        }
        // Marker: during active large panning (song change / far seek), hold
        // marker pinned at 25% viewport while timeline slides under it.
        // During normal continuous follow, anchor marker directly to true `px`
        // so any sub-pixel scroller adjustments never cause forward/backward marker jumps.
        const isPanning =
          panStartDist > viewWidth * 0.25 && panElapsedFrames < 18;
        const pinnedTarget = px - viewWidth * 0.25;
        displayPx =
          isPanning && pinnedTarget >= 0 && pinnedTarget <= maxScrollLeft
            ? engineScrollLeft + viewWidth * 0.25
            : px;
      } else {
        // Not smoothly following this tick (paused, off/snap mode, or a
        // gesture is in progress) -- drop the follow anchor.
        engineScrollLeft = null;
        followEngineScrollRef.current = null;
        // Marker tracks the true playhead position directly without lag
        displayPx = px;

        // Animated PANS (glide), unified for every follow mode and for
        // playing and stopped alike. Three triggers, all gliding instead of
        // teleporting ("глайд нужен не только в smooth", "не резко а плавно"):
        //  - "snap"-mode edge: while playing and followMode==="snap", pan
        //    once the playhead nears a viewport edge (the old behavior was a
        //    hard jump in a React effect).
        //  - Song change / stop / far seek in any mode: bring the new
        //    playhead into view (previously only revealed while stopped).
        //  - A pan already in flight continues (revealScroll !== null).
        // Guarded against scrubbing (dragging), zooming (gesture), and
        // manual scrolling (px doesn't move then, so lastRevealPx stays
        // equal). While playing in "smooth" the follow branch above owns the
        // scroll, so this else-branch logic never runs for it.
        // First tick after mount (== just switched to this tab, see
        // `firstTick`'s doc comment): if the playhead isn't already inside
        // the freshly-mounted scroller's default viewport, treat that as a
        // jump too, so it gets the exact same reveal-pan animation a song
        // change gets instead of sitting off-screen until the next real
        // jump (or, if paused with follow off, forever). Guarded to fire at
        // most once per mount regardless of whether a pan actually starts
        // this tick (dragging/gesture below could still defer it a frame).
        const notYetVisible =
          firstTick &&
          !!scroller &&
          !isPositionVisible(px, scroller.scrollLeft, viewWidth);
        const jumped =
          songJumped ||
          Math.abs(px - lastRevealPx) > pxPerSecRef.current * 2.0 ||
          notYetVisible;
        const snapEdge =
          playingRef.current &&
          followModeRef.current === "snap" &&
          scroller &&
          !gestureActiveNowRef.current &&
          !dragging.current;
        let overEdge = false;
        if (snapEdge) {
          const currentLeft = revealScroll ?? scroller!.scrollLeft;
          overEdge =
            px > currentLeft + viewWidth - 120 || px < currentLeft + 40;
        }
        const needPan = jumped || overEdge;
        if (
          scroller &&
          !dragging.current &&
          !gestureActiveNowRef.current &&
          (revealScroll !== null || needPan)
        ) {
          if (revealScroll === null) {
            const startLeft = scroller.scrollLeft;
            const d0 = Math.abs(target - startLeft);
            // Already at the target (e.g. playhead pinned at the very end,
            // where the 25% anchor clamps to maxScrollLeft) -- nothing to pan.
            if (d0 >= 0.5) {
              revealScroll = startLeft;
              startPan(startLeft);
            }
          } else {
            const still = Math.abs(target - revealScroll);
            if (still > panStartDist) startPan(revealScroll);
          }
          if (revealScroll !== null) {
            revealScroll = Math.min(
              maxScrollLeft,
              Math.max(0, glide(revealScroll)),
            );
            const settled = Math.abs(target - revealScroll) < 0.5;
            if (settled) revealScroll = target;
            const before = scroller.scrollLeft;
            scroller.scrollLeft = revealScroll;
            if (Math.abs(before - scroller.scrollLeft) > 0.5) {
              programmaticScrollLeftRef.current = scroller.scrollLeft;
              lastProgrammaticWriteAtRef.current = performance.now();
            }
            const revealLeft = scroller.scrollLeft;
            const revealMoved = Math.abs(
              (lastCommittedScrollLeftRef.current ?? Infinity) - revealLeft,
            );
            if (revealMoved > 8 || settled) {
              lastCommittedScrollLeftRef.current = revealLeft;
              lastScrollStateCommitAtRef.current = performance.now();
              lastScrollLeftRef.current = revealLeft;
              setScrollState({
                scrollLeft: revealLeft,
                viewportWidth: viewWidth,
              });
            }
            if (settled) revealScroll = null;
          }
        } else {
          revealScroll = null;
        }
      }

      lastRevealPx = px;
      firstTick = false;

      // Write the marker EXCEPT while a zoom-focus scroll commit is pending.
      // applyZoomAt updates pxPerSecRef.current synchronously, so px is
      // already the NEW-scale position while the DOM scrollLeft is still the
      // OLD one until the [pxPerSec] layout effect commits the atomic
      // scroll+marker write. If this loop painted the marker here it would
      // run one frame ahead of the scroll and the playhead would visibly
      // wobble over the content ("всё ещё колбасит плейхед"). When the
      // pending target is consumed, the DOM is consistent again and the loop
      // resumes writing the marker itself.
      if (pendingScrollLeftRef.current === null) {
        placePlayhead(displayPx);
      }

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
                  state.undoLabel
                    ? `Undo: ${state.undoLabel} (⌘Z)`
                    : "Undo (⌘Z)"
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
                aria-label={
                  effectiveViewMode === "light"
                    ? "Copy selected cue (⌘C)"
                    : "Copy selected regions (⌘C)"
                }
                isDisabled={
                  effectiveViewMode === "light"
                    ? !cueSelection
                    : selectedRegionKeys.length === 0
                }
                onPress={
                  effectiveViewMode === "light"
                    ? copySelectedCue
                    : copySelectedRegions
                }
              >
                <Copy size={13} />
              </Button>
              <Button
                size="sm"
                variant="outline"
                isIconOnly
                aria-label={
                  effectiveViewMode === "light"
                    ? "Delete selected cue (⌫)"
                    : "Delete selected regions (⌫)"
                }
                isDisabled={
                  effectiveViewMode === "light"
                    ? !cueSelection
                    : selectedRegionKeys.length === 0
                }
                onPress={
                  effectiveViewMode === "light"
                    ? deleteSelectedCue
                    : deleteSelectedRegions
                }
              >
                <Trash2 size={13} />
              </Button>
              <Button
                size="sm"
                variant="outline"
                isIconOnly
                aria-label={
                  effectiveViewMode === "light"
                    ? "Split selected cue at playhead (⌘T)"
                    : "Trim/split selected regions at playhead (⌘T)"
                }
                isDisabled={
                  effectiveViewMode === "light"
                    ? !cueSelection
                    : selectedRegionKeys.length === 0
                }
                onPress={
                  effectiveViewMode === "light"
                    ? () => void splitSelectedCueAtPlayhead()
                    : () => void splitSelectedAtPlayhead()
                }
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

          {!readOnly && (
            <>
              <div className="w-px h-4 bg-default/30 mx-0.5" />
              <div className="flex items-center rounded-lg border border-default/40 bg-default/10 p-0.5">
                <button
                  type="button"
                  className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${
                    effectiveViewMode === "audio"
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground/50 hover:text-foreground"
                  }`}
                  aria-pressed={effectiveViewMode === "audio"}
                  onClick={() => setViewMode("audio")}
                >
                  <AudioLines size={11} /> Audio
                </button>
                <button
                  type="button"
                  className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${
                    effectiveViewMode === "light"
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground/50 hover:text-foreground"
                  }`}
                  aria-pressed={effectiveViewMode === "light"}
                  onClick={() => setViewMode("light")}
                >
                  <Lightbulb size={11} /> Light
                </button>
              </div>
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
                // Same treatment as a wheel/pinch zoom: pause auto-follow,
                // freeze the clock, and anchor at the playhead so it stands
                // still while the slider moves ("плейхед колбасит при зуме").
                markGestureActiveRef.current();
                markZoomActiveRef.current();
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
              {/* Cross-mode hint strip spacer -- keeps sidebar rows aligned
                  with the body's LightHintStrip/AudioHintStrip above the
                  lanes. In Light mode it labels the audio-reference strip
                  (and doubles as the persistent "add track" control, since
                  the scrolling track list below has nowhere else to put one
                  once a first track already exists); in Audio mode the
                  (dimmed) light-content strip. */}
              <div
                className="shrink-0 border-b border-default/30 px-2.5 text-[9px] font-bold uppercase text-foreground/25 flex items-center justify-between bg-background-tertiary"
                style={{
                  height:
                    effectiveViewMode === "light"
                      ? AUDIO_HINT_HEIGHT
                      : LIGHT_HINT_HEIGHT,
                }}
              >
                <span>
                  {effectiveViewMode === "light" ? "Audio ref" : "Light"}
                </span>
                {effectiveViewMode === "light" && lightEnabled && (
                  <button
                    type="button"
                    title="Add light track"
                    className="flex items-center gap-0.5 rounded border border-default/40 bg-default/15 px-1 py-0.5 normal-case tracking-normal text-foreground/60 transition-colors hover:border-accent/60 hover:text-foreground"
                    onClick={() => void lighting.trackAdd()}
                  >
                    <Plus size={10} /> Track
                  </button>
                )}
              </div>
              {/* No preview-strip spacer in light mode — preview is now in the side panel */}
              {/* Track controls list (scrolls vertically in sync with right timeline) */}
              <div className="flex-1 min-h-0 overflow-hidden">
                {effectiveViewMode === "light" ? (
                  <div ref={sidebarContentRef}>
                    {!lightEnabled ? (
                      <div className="flex h-24 items-center justify-center px-3 text-center text-[10px] leading-relaxed text-foreground/40">
                        Enable lighting in Settings &gt; Project to author light
                        cues
                      </div>
                    ) : lightTracks.length === 0 ? (
                      <div className="flex flex-col items-center gap-1 px-3 py-5 text-center text-[10px] text-foreground/40">
                        No light tracks
                        <span>Use the Track button above to add one</span>
                      </div>
                    ) : (
                      lightTracks.map((t, i) => (
                        <LightTrackHeader
                          key={t.id}
                          track={t}
                          index={i}
                          fixtures={lightFixtures}
                          color={lightTrackColor(i)}
                          height={laneHeightPx(verticalZoom)}
                          selected={sidePanelTrackIndex === i && !cueSelection}
                          onSelect={() => {
                            setSidePanelTrackIndex(i);
                            setCueSelection(null);
                          }}
                        />
                      ))
                    )}
                  </div>
                ) : (
                  <div ref={sidebarContentRef}>
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
                )}
              </div>
            </div>
          )}

          {/* Right Scrollable Timeline View (Horizontally & Vertically) */}
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-auto relative select-none cursor-col-resize focus:outline-none"
            style={{
              // No transform/filter here: sticky ruler + playhead handle need
              // a clean scrollport. will-change:scroll-position alone is fine.
              willChange: "scroll-position",
              // Kill macOS rubber-band past the content end -- user could
              // pull the timeline into empty space past the last sample.
              overscrollBehavior: "none",
            }}
            onScroll={onScrollSync}
          >
            <div
              ref={timelineBodyRef}
              className="relative flex min-h-0 flex-col"
              style={{
                width: contentWidth,
                minHeight: "100%",
                // No translateZ(0): any transform on this node breaks
                // position:sticky for the ruler and playhead handle.
              }}
            >
              {/* 1. Ruler — real CSS sticky (compositor-pinned, no JS Y race).
                  Playhead triangle lives here so it sticks with the ruler;
                  sticky inside an absolute full-height needle does not work. */}
              <div
                className="sticky top-0 z-20 bg-background-secondary shrink-0 cursor-col-resize touch-none"
                style={{
                  width: contentWidth,
                  height: RULER_HEIGHT,
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancelOrLost}
                onLostPointerCapture={onPointerCancelOrLost}
              >
                {/* Playhead handle + ruler-band needle. Lives inside the sticky
                    header so the line is never painted under the opaque ruler
                    (the full-height needle is z-below sticky and would vanish
                    here). X synced with the lane needle via rAF. */}
                <div
                  ref={playheadHandleRef}
                  className="pointer-events-auto absolute top-0 bottom-0 z-30 w-0 -translate-x-1/2 cursor-col-resize select-none"
                  style={{ left: 0 }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancelOrLost}
                  onLostPointerCapture={onPointerCancelOrLost}
                >
                  <div className="absolute top-0 bottom-0 left-0 w-[1.5px] -translate-x-1/2 bg-[#fff] shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
                  {/* Down-pointing triangle (not a rotate-45 square = diamond). */}
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

              {/* 2.5. Cross-mode hint strip: Audio mode shows dimmed light
                  content (no click targets), Light mode shows a dimmed audio
                  waveform reference. The opposite mode's content, one strip
                  per mode. */}
              {effectiveViewMode === "audio" ? (
                hasLightContent && (
                  <LightHintStrip
                    songs={songs}
                    songOffsets={songOffsets}
                    songLengths={songLengths}
                    pxPerSec={pxPerSec}
                    scrollState={scrollState}
                    contentWidth={contentWidth}
                    height={LIGHT_HINT_HEIGHT}
                    trackColor={lightTrackColorForId}
                  />
                )
              ) : (
                <AudioHintStrip
                  state={state}
                  peaks={peaks}
                  allPeaks={allPeaks}
                  audioRows={rows.map((r) => ({
                    name: r.name,
                    color: r.color,
                  }))}
                  songs={songs}
                  songOffsets={songOffsets}
                  songLengths={songLengths}
                  pxPerSec={pxPerSec}
                  scrollState={scrollState}
                  verticalZoom={verticalZoom}
                  contentWidth={contentWidth}
                />
              )}

              {/* 3D preview moved to LightSidePanel — nothing to render here */}

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

                {effectiveViewMode === "light" ? (
                  <>
                    {!lightEnabled ? (
                      <div className="flex h-24 items-center justify-center px-6 text-center text-xs text-foreground/40">
                        Lighting is disabled. Enable it in Settings &gt; Project
                        to author light cues.
                      </div>
                    ) : lightTracks.length === 0 ? (
                      <div className="flex h-24 items-center justify-center px-6 text-center text-xs text-foreground/40">
                        No light tracks yet — add one from the sidebar, then
                        click an empty lane to place a cue.
                      </div>
                    ) : (
                      lightTracks.map((t, i) => (
                        <LightTrackLane
                          key={t.id}
                          track={t}
                          color={lightTrackColor(i)}
                          songs={songs}
                          songOffsets={songOffsets}
                          songLengths={songLengths}
                          pxPerSec={pxPerSec}
                          scrollState={scrollState}
                          verticalZoom={verticalZoom}
                          contentWidth={contentWidth}
                          readOnly={readOnly}
                          toAbsSec={toAbsSec}
                          snapLocalSec={snapLocalSec}
                          selected={cueSelection}
                          onSelect={setCueSelection}
                        />
                      ))
                    )}
                    <div className="h-6 shrink-0" />
                  </>
                ) : rows.length === 0 ? (
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
                        height: laneHeightPx(verticalZoom),
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
                              draft?.loopLengthSeconds ??
                              r.loopLengthSeconds ??
                              0,
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

                              // Region box sits fully outside the horizontal
                              // viewport (song segment above is only culled
                              // as a whole, not per-region) -- skip building
                              // its drag handles/JSX entirely. Never skip the
                              // region actively being dragged: an edge-of-
                              // viewport auto-scroll during drag must not
                              // unmount the element mid-gesture (it holds
                              // pointer capture).
                              if (
                                regViewEnd <= regViewStart &&
                                regionDragRef.current?.key !==
                                  thisRegionSelKey
                              ) {
                                return null;
                              }

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
                                    : (geom.loopLengthSeconds ?? 0);

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
                                  return localY < qH ? "fadeIn" : "trimStart";
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
                                  const isLooped = nextDur > loopLen + 0.01;
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
                                  loopLengthSeconds:
                                    finalGeom.loopLengthSeconds,
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

                              // Tiny vertical zoom: skip waveform canvas entirely
                              // and paint a solid color strip + name (peaks are
                              // noise at ≤COMPACT_LANE_MAX_PX).
                              const compactLane = isCompactLane(verticalZoom);

                              return (
                                <div key={songRegion.id}>
                                  <div
                                    className={`absolute overflow-hidden ${
                                      compactLane
                                        ? "top-0.5 bottom-0.5 rounded-sm"
                                        : "top-1 bottom-1 rounded-md"
                                    } ${readOnly ? "pointer-events-none" : "pointer-events-auto"}`}
                                    style={{
                                      left: leftPx,
                                      width: regionWidth,
                                      border: compactLane
                                        ? isRegionSelected
                                          ? "2px solid #fff"
                                          : `1px solid ${dimHexColor(row.color, regionUi.muted ? 0.52 : 0.68, 1.2)}`
                                        : isRegionSelected
                                          ? `2px solid ${row.color}`
                                          : `1.5px solid ${row.color}55`,
                                      // Compact: solid fill via HSL (L down a bit, S up a bit).
                                      background: compactLane
                                        ? dimHexColor(
                                            row.color,
                                            regionUi.muted ? 0.48 : 0.64,
                                            regionUi.muted ? 1.05 : 1.22,
                                          )
                                        : isRegionSelected
                                          ? `${row.color}30`
                                          : `${row.color}12`,
                                      boxShadow:
                                        isRegionSelected && !compactLane
                                          ? `0 0 0 1px ${row.color}aa, 0 0 10px ${row.color}44`
                                          : isRegionSelected && compactLane
                                            ? "0 0 0 1px rgba(255,255,255,0.5)"
                                            : undefined,
                                      cursor: readOnly ? "default" : "grab",
                                      // Mute: only dim the normal waveform chrome;
                                      // compact strips stay solid (label shows [M]).
                                      opacity:
                                        !compactLane && regionUi.muted
                                          ? 0.4
                                          : 1,
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
                                    {/* Peaks only when the lane is tall enough */}
                                    {!compactLane && regViewportWidth > 0 && (
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
                                    {/* Region name — left of region, light backdrop chip, no border. */}
                                    <div
                                      className="pointer-events-none absolute z-[3] max-w-[min(90%,14rem)] select-none"
                                      style={{
                                        left: compactLane ? 4 : 6,
                                        top: compactLane ? 1 : 3,
                                      }}
                                    >
                                      <span
                                        className="inline-block max-w-full truncate rounded-md px-1.5 py-0.5 font-semibold leading-tight"
                                        style={{
                                          color: "#fff",
                                          fontSize: compactLane
                                            ? Math.max(
                                                8,
                                                Math.min(
                                                  11,
                                                  laneHeightPx(verticalZoom) -
                                                    10,
                                                ),
                                              )
                                            : 10,
                                          background: "rgba(0, 0, 0, 0.28)",
                                          backdropFilter: "blur(6px)",
                                          WebkitBackdropFilter: "blur(6px)",
                                        }}
                                        title={`${regionUi.muted ? "[M] " : ""}${row.name}${geom.loop ? " ↺" : ""}`}
                                      >
                                        {regionUi.muted ? "[M] " : ""}
                                        {row.name}
                                        {geom.loop ? " ↺" : ""}
                                      </span>
                                    </div>
                                    {!compactLane &&
                                      peaksLoading &&
                                      regionWidth > 40 && (
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
                                    {geom.loop &&
                                      (() => {
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

              {/* 4. Lane needle (full content height). z below sticky ruler so
                  it doesn't cover song labels; the ruler-band segment is drawn
                  inside the sticky header (playheadHandleRef). */}
              <div
                ref={playheadRef}
                className="pointer-events-none absolute top-0 bottom-0 z-[15] w-0"
              >
                <div className="absolute top-0 bottom-0 left-0 w-[1.5px] -translate-x-1/2 bg-[#fff] shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
              </div>
            </div>
          </div>

          {/* Right Light Side Panel — shown in Light mode (editor only) */}
          {effectiveViewMode === "light" && !readOnly && (
            <LightSidePanel
              state={state}
              selection={sidePanelSelection}
              fixtures={lightFixtures}
              previewColors={previewColors}
              onClearSelection={() => {
                setCueSelection(null);
                setSidePanelTrackIndex(null);
              }}
            />
          )}
        </div>
      )}

      {regionContextMenu &&
        (() => {
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

  // Quantize scrollLeft to 250px chunks so the canvas node stays static for 250px of scroll
  // and moves smoothly with native GPU layer scrolling without 60fps React redraw stutter
  const quantizedLeft = Math.max(
    0,
    Math.floor((scrollLeft || 0) / 250) * 250 - 250,
  );
  const bufferedWidth = Math.min(contentWidth, (viewportWidth || 1200) + 500);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || bufferedWidth <= 0) return;
    const parent = canvas.parentElement;
    const height = parent ? parent.clientHeight : 300;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.floor(bufferedWidth * dpr));
    const targetH = Math.max(1, Math.floor(height * dpr));

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${bufferedWidth}px`;
      canvas.style.height = `${height}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, bufferedWidth, height);

    if (minorStepSec > 0 && majorStepSec > 0) {
      const startTime = Math.max(0, quantizedLeft / pxPerSec);
      const endTime = Math.min(
        songLength + minorStepSec,
        (quantizedLeft + bufferedWidth) / pxPerSec,
      );
      const startTick = Math.floor(startTime / minorStepSec) * minorStepSec;
      const eps = Math.max(minorStepSec * 0.01, 1e-9);
      const maxStrokes = 1000;
      let strokes = 0;

      for (
        let t = startTick;
        t <= endTime && strokes < maxStrokes;
        t += minorStepSec
      ) {
        const rounded = Math.round(t / minorStepSec) * minorStepSec;
        const globalX = Math.round(rounded * pxPerSec);
        const canvasX = globalX - quantizedLeft;
        if (canvasX < 0 || canvasX > bufferedWidth) continue;

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
    quantizedLeft,
    bufferedWidth,
    songLength,
    majorStepSec,
    minorStepSec,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute top-0 z-0"
      style={{ left: quantizedLeft }}
    />
  );
}
