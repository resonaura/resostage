import { Popover, ScrollShadow, Separator, Tooltip } from "@heroui/react";
import {
  ChevronDown,
  Gauge,
  LayoutGrid,
  Pause,
  Play,
  Rows3,
  SignalHigh,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatClockPrecise as formatTime,
  LevelMeterBar,
  LiveReadout,
  VUMeter,
} from "../components/daw";
import { FontIcon } from "../components/FontIcon";
import { ResoLightStage3D } from "../components/light/LazyResoLightStage3D";
import { Timeline } from "../components/Timeline";
import {
  Button,
  ButtonGroup,
  Card,
  ToggleButton,
  ToggleButtonGroup,
} from "../components/ui";
import { builder, transport } from "../lib/api";
import { useThemeVersion } from "../hooks/useThemeVersion";
import { rowsSameExceptLevels } from "../lib/levelFields";
import { getLiveLevels } from "../lib/liveLevels";
import { useContinuousPlayhead } from "../lib/optimistic";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type AllPeaksResponse,
  type BusRow,
  type Click,
  type ClickSendRow,
  type LightFixtureRow,
  type MeterRow,
  type PeaksResponse,
  type SongRow,
  type WebUiState,
} from "../lib/types";
import { useIsCompact } from "../lib/useMediaQuery";

import {
  busCycleColor,
  extOutColor,
  masterColor,
  monoOutColor,
  sendColor,
} from "../lib/mixerColors";

/** "audio::out:3" or "direct:3" -> 3; anything else -> null. */
function laneNumber(id: string): number | null {
  if (id.startsWith("audio::out:")) {
    const n = Number(id.slice("audio::out:".length));
    return Number.isFinite(n) ? n : null;
  }
  if (id.startsWith("direct:")) {
    const n = Number(id.slice("direct:".length));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Stable empty roster so a rig with no fixtures doesn't churn the memo. */
const EMPTY_FIXTURES: LightFixtureRow[] = [];

type BusMeterGroup = {
  id: string;
  name: string;
  accent: string;
  meters: MeterRow[];
};

/** 1-based mono lanes referenced STANDALONE (any mono route / mono master /
 *  mono send / metronome). Such lanes must not be folded into a stereo pair. */
function collectSoloLanes(
  busses: BusRow[],
  tracks: WebUiState["tracks"],
  clickBusId?: string,
  clickSends?: ClickSendRow[],
): Set<number> {
  const solo = new Set<number>();

  for (const b of busses) {
    if (b.id.startsWith("audio::out:") || b.id.startsWith("direct:")) continue;
    if (b.channels <= 1) solo.add(b.startChannel + 1);
  }

  const applyRefs = (id: string | undefined) => {
    if (!id) return;
    const lanes = id
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => /^(?:audio::out:|direct:)(\d+)$/.exec(t))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    // A single-lane route (compounds are a stereo pair of lanes) solos it.
    if (lanes.length <= 1) {
      for (const l of lanes) solo.add(l);
    }
  };

  for (const t of tracks) {
    applyRefs(sourceOutputBusId(t.output));
    for (const s of t.output.sends) applyRefs(s.bus);
  }
  applyRefs(clickBusId);
  for (const cs of clickSends ?? []) applyRefs(cs.busId);

  return solo;
}

/**
 * Preview grouping for the Player "Bus meters" widget. Project busses
 * (main / aux / sends) stay as their own meter columns; Direct Output lanes
 * are folded into consecutive stereo pairs -- "Out 1/2", "Out 3/4" -- unless
 * a lane is targeted standalone anywhere (mono route, mono master, mono send,
 * metronome), in which case it is shown on its own ("Out 5") instead of being
 * glued into a pair. Every direct group shares one colour.
 */
function busMeterGroups(
  meters: MeterRow[],
  busses: BusRow[],
  tracks: WebUiState["tracks"],
  clickBusId?: string,
  clickSends?: ClickSendRow[],
): BusMeterGroup[] {
  const direct: MeterRow[] = [];
  const groups: BusMeterGroup[] = [];
  let auxIdx = 0;
  for (const m of meters) {
    if (laneNumber(m.id) != null) {
      direct.push(m);
      continue;
    }
    const busObj = busses.find((b) => b.id === m.id);
    const isMaster =
      busObj?.name?.toLowerCase() === "master" ||
      m.id === "audio::main" ||
      m.id === "main" ||
      m.id === "master";
    const accent = isMaster
      ? masterColor()
      : busObj?.isAux
        ? sendColor()
        : busCycleColor(auxIdx++);
    groups.push({
      id: m.id,
      name: busObj?.name || (m.id === "main" ? "Main" : m.id),
      accent,
      meters: [m],
    });
  }

  const soloLanes = collectSoloLanes(busses, tracks, clickBusId, clickSends);
  direct.sort((a, b) => (laneNumber(a.id) ?? 0) - (laneNumber(b.id) ?? 0));
  for (let i = 0; i < direct.length; ) {
    const a = direct[i];
    const laneA = laneNumber(a.id) ?? 0;
    const b = direct[i + 1];
    const laneB = b ? (laneNumber(b.id) ?? -1) : -1;
    const isPair =
      b != null &&
      laneA % 2 === 1 &&
      laneB === laneA + 1 &&
      !soloLanes.has(laneA) &&
      !soloLanes.has(laneB);
    if (isPair) {
      groups.push({
        id: `out:${laneA}/${laneB}`,
        name: `Out ${laneA}/${laneB}`,
        accent: extOutColor(),
        meters: [a, b],
      });
      i += 2;
    } else {
      groups.push({
        id: `out:${laneA}`,
        name: `Out ${laneA}`,
        accent: monoOutColor(),
        meters: [a],
      });
      i += 1;
    }
  }
  return groups;
}

function barBeat(seconds: number, bpm: number, tsNum: number): string {
  if (bpm <= 0 || seconds < 0) return "—";
  const beatsPerBar = Math.max(1, tsNum);
  const secondsPerBeat = 60 / bpm;
  const totalBeats = seconds / secondsPerBeat;
  const bar = Math.floor(totalBeats / beatsPerBar) + 1;
  const beat = (Math.floor(totalBeats) % beatsPerBar) + 1;
  return `${bar} | ${beat}`;
}

// Cumulative whole-project bar|beat from an already-accumulated beat count
// (see AudioEngine::globalBeatsElapsed).
function globalBarBeat(beatsElapsed: number, tsNum: number): string {
  if (!Number.isFinite(beatsElapsed) || beatsElapsed < 0 || tsNum <= 0)
    return "—";
  const beatsPerBar = Math.max(1, tsNum);
  const bar = Math.floor(beatsElapsed / beatsPerBar) + 1;
  const beat = (Math.floor(beatsElapsed) % beatsPerBar) + 1;
  return `${bar} | ${beat}`;
}

// Single sparkline SVG renderer (no pinging animations, clean solid line)
function Sparkline({
  history,
  color,
  gradientId,
  label,
  valueText,
  maxMinVal = 25,
}: {
  history: number[];
  color: string;
  gradientId: string;
  label: string;
  valueText: string;
  maxMinVal?: number;
}) {
  const maxVal = Math.max(maxMinVal, ...history);
  const points = history.map((val, i) => {
    const x = (i / Math.max(1, history.length - 1)) * 90;
    const y = 24 - (val / maxVal) * 20;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const pathD = `M ${points.join(" L ")}`;
  const areaD = `M 0,24 L ${points.join(" L ")} L 90,24 Z`;
  const lastPoint =
    points.length > 0 ? points[points.length - 1].split(",") : ["90", "24"];

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="flex items-center justify-between w-full text-[10px] tabular-nums font-semibold">
        <span className="text-foreground/40 uppercase">{label}</span>
        <span style={{ color }}>{valueText}</span>
      </div>
      <svg width="90" height="24" className="overflow-visible">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#${gradientId})`} />
        <path
          d={pathD}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {/* Solid static dot at latest point -- no constant pinging animation */}
        <circle cx={lastPoint[0]} cy={lastPoint[1]} r="2" fill={color} />
      </svg>
    </div>
  );
}

// Live system health widget with 2 separate graphs (CPU: Accent, RAM: Purple)
//
// Memoized on the few fields it reads rather than taking the whole state: the
// telemetry feed hands out a new state object on every frame, and without this
// two SVG sparklines were being rebuilt thirty times a second to show numbers
// that only change once a second by construction.
const SystemHealthWidget = memo(function SystemHealthWidget({
  health: h,
  playing,
  cpuHistory,
  ramHistory,
}: {
  health: WebUiState["health"];
  playing: boolean;
  cpuHistory: number[];
  ramHistory: number[];
}) {
  // Numbers track the 1 Hz history sample (not every telemetry frame) so
  // the readout doesn't jitter between SystemHealth samples.
  const cpuVal = Math.max(
    0,
    cpuHistory[cpuHistory.length - 1] ?? h?.cpuPercent ?? 0,
  );
  const cpuMax = Math.max(cpuVal, ...cpuHistory);

  const ramVal =
    ramHistory[ramHistory.length - 1] ?? (h?.rssBytes ?? 0) / (1024 * 1024);
  const ramMax = Math.max(ramVal, ...ramHistory);

  // Hardware limits derived dynamically from C++ JUCE SystemHealth:
  const cores = Math.max(1, h?.cpuCoreCount ?? 8);
  const totalCpuMax = cores * 100;
  const cpuRatio = cpuMax / totalCpuMax;

  const totalRamMb = (h?.systemTotalBytes ?? 0) / (1024 * 1024);
  const ramRatio = totalRamMb > 0 ? ramMax / totalRamMb : ramMax / 16384;

  // Warning (>= 65% total system CPU / >= 50% total system RAM)
  // Danger (>= 85% total system CPU / >= 75% total system RAM)
  const cpuColor =
    cpuRatio >= 0.85
      ? "var(--danger)"
      : cpuRatio >= 0.65
        ? "var(--warning)"
        : "var(--segment)";

  const ramColor =
    ramRatio >= 0.75
      ? "var(--danger)"
      : ramRatio >= 0.5
        ? "var(--warning)"
        : "var(--segment)";

  return (
    <div className="hidden shrink-0 items-center gap-4 border-l border-default/30 px-4 py-2 tabular-nums lg:flex">
      {/* Graph 1: CPU */}
      <Sparkline
        history={cpuHistory}
        color={cpuColor}
        gradientId="cpuGrad"
        label="CPU"
        valueText={`${cpuVal.toFixed(1)}%`}
        maxMinVal={Math.max(100, Math.ceil(Math.max(cpuVal, 1) / 100) * 100)}
      />

      {/* Graph 2: RAM */}
      <Sparkline
        history={ramHistory}
        color={ramColor}
        gradientId="ramGrad"
        label="RAM"
        valueText={`${ramVal.toFixed(0)} MB`}
        maxMinVal={Math.max(512, Math.ceil(ramVal / 256) * 256)}
      />

      {/* Status details */}
      <div className="flex flex-col gap-0.5 text-[10px] text-foreground/40">
        <div
          className={`flex items-center gap-1 font-bold ${playing ? "text-success" : "text-danger"}`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${playing ? "animate-pulse bg-success" : "bg-danger"}`}
          />
          {playing ? "PLAYING" : "STOPPED"}
        </div>
        {(h?.underrunCount ?? 0) > 0 ? (
          <span className="font-bold text-danger">
            ⚠ {h?.underrunCount} underrun
            {(h?.underrunCount ?? 0) !== 1 ? "s" : ""}
          </span>
        ) : (
          <span>0 underruns</span>
        )}
        <span>
          {h?.webClientCount ?? 1} client
          {(h?.webClientCount ?? 1) !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
});

// Memoized on the fixture roster alone. That roster is shipped on every
// telemetry frame ("lighting ... always shipped" in WebServer.cpp) but rarely
// actually changes, and structural sharing in the live-state merge keeps its
// reference stable when it doesn't -- so the WebGL stage now mounts once and
// stays put instead of being re-rendered under the live LED stream.
const PlayerLightStagePreview = memo(function PlayerLightStagePreview({
  fixtures,
  enabled,
}: {
  fixtures: LightFixtureRow[];
  enabled: boolean;
}) {
  if (fixtures.length === 0) return null;

  return (
    <Card className="relative flex h-40 w-full shrink-0 flex-col overflow-hidden sm:h-full sm:w-52 p-0 gap-0">
      <Card.Header className="h-10 border-b border-default/20 px-3.5 text-[11px] font-bold uppercase tracking-widest text-foreground/35 flex flex-row items-center justify-between z-10 space-y-0 shrink-0">
        <span>Stage Lights</span>
      </Card.Header>
      <Card.Content className="flex flex-col flex-1 min-h-0 relative p-0 overflow-hidden">
        <ResoLightStage3D
          mode="preview"
          fixtures={fixtures}
          live={enabled}
          chrome="minimal"
        />
      </Card.Content>
    </Card>
  );
});

type BusMeterMode = "bars" | "vu";

/**
 * How much fits on screen at once.
 *
 * "comfortable" is the original layout: full-size meters in a single row that
 * scrolls sideways. It reads well from a metre away, which is what matters
 * with four or five busses.
 *
 * "compact" trades size for count -- meters shrink and wrap, and the panel
 * scrolls VERTICALLY instead. A rig with a master, four sends and a dozen
 * output lanes is unusable as one long horizontal strip; nothing past the
 * third meter is ever on screen.
 */
type BusMeterDensity = "comfortable" | "compact";

const BUS_METER_MODE_KEY = "resostage.player.busMeterMode";
const BUS_METER_DENSITY_KEY = "resostage.player.busMeterDensity";

function readBusMeterMode(): BusMeterMode {
  try {
    const saved = localStorage.getItem(BUS_METER_MODE_KEY);
    if (saved === "bars" || saved === "vu") return saved;
  } catch {
    /* private mode */
  }
  return "vu";
}

function readBusMeterDensity(): BusMeterDensity {
  try {
    const saved = localStorage.getItem(BUS_METER_DENSITY_KEY);
    if (saved === "comfortable" || saved === "compact") return saved;
  } catch {
    /* private mode */
  }
  return "comfortable";
}

// Memoized on exactly the four wire arrays the grouping depends on, and
// compared BY CONTENT rather than by identity -- see the comparator below.
//
// The comment that used to sit here claimed all four keep their identity
// across frames "while the routing holds still". That is true of `busses` and
// `tracks`, and false of `meters`: every MeterRow carries the peaks, so the
// array is rebuilt on every telemetry frame and the memo never once hit. The
// panel -- and the grouping recomputed inside it -- was being re-rendered at
// telemetry rate to show levels its meters were already reading for
// themselves through getLiveLevels() during their own canvas paint.
const BusMetersPanelInner = memo(function BusMetersPanel({
  meters,
  busses,
  tracks,
  click,
}: {
  meters: MeterRow[];
  busses: BusRow[];
  tracks: WebUiState["tracks"];
  click?: Click;
}) {
  const [mode, setMode] = useState<BusMeterMode>(readBusMeterMode);
  const [density, setDensity] = useState<BusMeterDensity>(readBusMeterDensity);
  useEffect(() => {
    try {
      localStorage.setItem(BUS_METER_MODE_KEY, mode);
    } catch {
      /* best-effort */
    }
  }, [mode]);
  useEffect(() => {
    try {
      localStorage.setItem(BUS_METER_DENSITY_KEY, density);
    } catch {
      /* best-effort */
    }
  }, [density]);
  const compact = density === "compact";
  // Group accents are resolved hex, so a theme swap must recompute them --
  // and this panel is memoised on props that a theme change does not touch,
  // so the hook is also what makes it re-render at all. See useThemeVersion.
  const themeVersion = useThemeVersion();
  const groups = useMemo(
    () =>
      busMeterGroups(
        meters,
        busses,
        tracks,
        click ? sourceOutputBusId(click.output) : undefined,
        click ? outputSendsToClickRows(click.output) : undefined,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meters, busses, tracks, click, themeVersion],
  );

  const vuGetterFor = (g: BusMeterGroup) => () => {
    let mx = -Infinity;
    const levels = getLiveLevels().meters;
    if (!levels.length) return -144;
    for (const m of g.meters) {
      for (const lm of levels) {
        if (lm.id === m.id) {
          const a = lm.peakDbL ?? -144;
          const b = lm.peakDbR ?? -144;
          if (a > mx) mx = a;
          if (b > mx) mx = b;
        }
      }
    }
    return mx === -Infinity ? -144 : mx;
  };

  return (
    <Card className="flex md:w-100 h-56 min-h-0 shrink-0 flex-col overflow-hidden sm:w-unset sm:h-auto p-0 gap-0">
      <Card.Header className="h-10 flex flex-row items-center justify-between border-b border-default/20 px-3.5 space-y-0 shrink-0">
        <span className="text-[11px] mr-5 font-bold uppercase tracking-widest text-foreground/35">
          Bus meters
        </span>
        {/* Two independent single-selects: what the meters look like, and how
            many of them fit. Both are exclusive and neither may be emptied. */}
        <div className="flex items-center gap-2">
          <ToggleButtonGroup
            aria-label="Meter style"
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[mode]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0] as BusMeterMode | undefined;
              if (next) setMode(next);
            }}
          >
            <Tooltip>
              <ToggleButton id="bars" isIconOnly aria-label="Bar meters">
                <SignalHigh size={14} />
              </ToggleButton>
              <Tooltip.Content>Bar meters</Tooltip.Content>
            </Tooltip>
            <Tooltip>
              <ToggleButton id="vu" isIconOnly aria-label="VU meters">
                <ToggleButtonGroup.Separator />
                <Gauge size={14} />
              </ToggleButton>
              <Tooltip.Content>VU meters</Tooltip.Content>
            </Tooltip>
          </ToggleButtonGroup>
          <Separator orientation="vertical" className="h-4 mt-auto mb-auto" />
          <ToggleButtonGroup
            aria-label="Meter density"
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[density]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0] as BusMeterDensity | undefined;
              if (next) setDensity(next);
            }}
          >
            <Tooltip>
              <ToggleButton
                id="comfortable"
                isIconOnly
                aria-label="Comfortable"
              >
                <Rows3 size={14} />
              </ToggleButton>
              <Tooltip.Content>
                Comfortable — full size, scrolls sideways
              </Tooltip.Content>
            </Tooltip>
            <ToggleButtonGroup.Separator />
            <Tooltip>
              <ToggleButton id="compact" isIconOnly aria-label="Compact">
                <ToggleButtonGroup.Separator />
                <LayoutGrid size={14} />
              </ToggleButton>
              <Tooltip.Content>
                Compact — fits more, scrolls vertically
              </Tooltip.Content>
            </Tooltip>
          </ToggleButtonGroup>
        </div>
      </Card.Header>

      {groups.length === 0 ? (
        <div className="flex h-full items-center justify-center py-4 text-sm text-foreground/40">
          No busses.
        </div>
      ) : mode === "vu" ? (
        <ScrollShadow
          orientation={compact ? "vertical" : "horizontal"}
          className={
            compact
              ? "flex min-h-0 flex-1 flex-wrap content-start justify-center gap-2 p-2"
              : "flex min-h-0 flex-1 items-center gap-4 p-3"
          }
        >
          {groups.map((g) => {
            const db = Math.max(...g.meters.map((m) => m.peakDb));
            return (
              <div
                key={g.id}
                className={
                  compact
                    ? "flex h-[88px] w-[104px] shrink-0 items-center"
                    : "flex h-full w-[176px] shrink-0 items-center"
                }
              >
                <VUMeter
                  name={g.name}
                  db={db}
                  getDb={vuGetterFor(g)}
                  color={g.accent}
                />
              </div>
            );
          })}
        </ScrollShadow>
      ) : (
        <ScrollShadow
          orientation={compact ? "vertical" : "horizontal"}
          className={
            compact
              ? "flex min-h-0 flex-1 flex-wrap content-start justify-center gap-x-2 gap-y-1 p-2"
              : "flex min-h-0 flex-1 items-center gap-3 p-4"
          }
        >
          {groups.map((g) => {
            const m0 = g.meters[0];
            const m1 = g.meters[1];
            const db = Math.max(...g.meters.map((m) => m.peakDb));
            const dbL = m0.peakDbL ?? m0.peakDb;
            const dbR = m1
              ? (m1.peakDbR ?? m1.peakDb)
              : (m0.peakDbR ?? m0.peakDb);
            const lufs = Math.max(...g.meters.map((m) => m.shortTermLufs));
            const live0 = () =>
              getLiveLevels().meters.find((lm) => lm.id === m0.id);
            const live1 = () =>
              m1
                ? getLiveLevels().meters.find((lm) => lm.id === m1.id)
                : undefined;
            return (
              <div
                key={g.id}
                className={
                  compact
                    ? "flex h-[104px] w-[68px] shrink-0 flex-col items-center justify-between gap-0.5"
                    : "flex h-full flex-col items-center justify-between gap-1.5 py-1"
                }
              >
                <div
                  className={`truncate text-center font-semibold text-foreground/80 ${
                    compact ? "w-[64px] text-[10px]" : "w-[72px] text-xs"
                  }`}
                  title={g.name}
                >
                  {g.name}
                </div>
                <div className="flex h-full min-h-0 flex-1 items-center justify-center">
                  <LevelMeterBar
                    db={db}
                    dbL={dbL}
                    dbR={dbR}
                    getLiveDbL={() => live0()?.peakDbL ?? -144}
                    getLiveDbR={() =>
                      m1
                        ? (live1()?.peakDbR ?? -144)
                        : (live0()?.peakDbR ?? -144)
                    }
                    accent={g.accent}
                    vertical={true}
                    showValue={false}
                    className="h-full"
                    barClassName={compact ? "h-full w-1" : "h-full w-1.5"}
                  />
                </div>
                <div
                  className={`text-center tabular-nums text-foreground/50 ${
                    compact ? "text-[9px]" : "text-[10px]"
                  }`}
                >
                  <div
                    className={
                      db > -3
                        ? "text-danger font-bold"
                        : db > -9
                          ? "text-warning font-semibold"
                          : ""
                    }
                  >
                    {db <= -99 ? "−∞" : db.toFixed(1)} dB
                  </div>
                  {/* LUFS is the first thing to go when space is tight -- peak
                      is what you glance at during a show. */}
                  {!compact && (
                    <div className="text-[9px] text-foreground/35">
                      {lufs <= -144 ? "−∞ L" : `${lufs.toFixed(1)} L`}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </ScrollShadow>
      )}
    </Card>
  );
});

/**
 * Re-render only when the ROUTING behind the meters changes, never because a
 * level moved. `meters` is compared field-by-field with the peaks excluded;
 * the other three keep their identity through structural sharing, so a plain
 * reference check is exact for them. See lib/levelFields.
 */
const BusMetersPanel = memo(
  BusMetersPanelInner,
  (prev, next) =>
    prev.busses === next.busses &&
    prev.tracks === next.tracks &&
    prev.click === next.click &&
    rowsSameExceptLevels(prev.meters, next.meters),
);

// The setlist is pure project data plus two booleans, but it used to be
// rebuilt -- one <button> subtree per song -- on every telemetry frame simply
// because it lived inline in a component the playhead re-renders. Memoized on
// what it actually reads, it now re-renders when the setlist, the staged song
// or the transport state changes, which is the entire set of things that can
// change how it looks.
const SetlistPanel = memo(function SetlistPanel({
  songs,
  activeIndex,
  playing,
  onSelect,
}: {
  songs: SongRow[];
  activeIndex: number;
  playing: boolean;
  onSelect: (index: number) => void;
}) {
  return (
    <Card className="flex h-56 min-h-0 flex-1 flex-col overflow-hidden sm:h-auto p-0 gap-0">
      <Card.Header className="h-10 flex flex-row items-center border-b border-default/20 px-3.5 text-[11px] font-bold uppercase tracking-widest text-foreground/35 space-y-0 shrink-0">
        Setlist
      </Card.Header>
      <ScrollShadow orientation="vertical" className="min-h-0 flex-1">
        {songs.length === 0 ? (
          /* Centered vertically when setlist is empty */
          <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-foreground/40">
            No songs in this project.
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-default/15">
            {songs.map((s, i) => {
              const isActive = i === activeIndex;
              const isCurrentPlaying = isActive && playing;

              const toneClass = isCurrentPlaying
                ? "bg-accent-soft hover:bg-accent-soft-hover text-accent-soft-foreground"
                : isActive
                  ? "bg-default-soft hover:bg-default-soft-hover text-foreground"
                  : "hover:bg-default/30 text-foreground/80";

              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSelect(i)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${toneClass}`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all ${
                      isCurrentPlaying
                        ? "animate-pulse scale-125 bg-accent shadow-[0_0_4px_var(--player-active-glow)]"
                        : isActive
                          ? "bg-foreground/50"
                          : "bg-foreground/12"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={`truncate text-sm ${
                        isActive ? "font-semibold" : "text-foreground/80"
                      }`}
                    >
                      {i + 1}. {s.name}
                    </div>
                    <div
                      className={`text-[10px] ${
                        isActive ? "opacity-75" : "text-foreground/35"
                      }`}
                    >
                      {s.bpm.toFixed(1)} bpm ·{" "}
                      {s.mode === "auto" ? "auto" : "wait"} ·{" "}
                      {s.regions?.length ?? 0} clips
                    </div>
                  </div>
                  {isActive && (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide ${
                        isCurrentPlaying
                          ? "bg-accent/20 text-accent"
                          : "bg-default/40 text-foreground/60"
                      }`}
                    >
                      {playing ? "NOW" : "CUE"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </ScrollShadow>
    </Card>
  );
});

export function PlayerScreen({
  state,
  cpuHistory,
  ramHistory,
  peaks,
  allPeaks,
  pxPerSec,
  setPxPerSec,
}: {
  state: WebUiState;
  cpuHistory: number[];
  ramHistory: number[];
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
}) {
  const compact = useIsCompact();
  const [metronomeOverride, setMetronomeOverride] = useState<boolean | null>(
    null,
  );
  const [clickSendsOpen, setClickSendsOpen] = useState(false);
  // Anchors the routing popover; see the note at its trigger.
  const clickRoutingAnchorRef = useRef<HTMLDivElement>(null);
  // Optimistic setlist highlight: flip immediately on click so hopscotch
  // never waits for the ~30 Hz WS round-trip / stageSong to paint.
  const [optimisticSongIndex, setOptimisticSongIndex] = useState<number | null>(
    null,
  );
  useEffect(() => {
    if (
      optimisticSongIndex != null &&
      state.songIndex === optimisticSongIndex
    ) {
      setOptimisticSongIndex(null);
    }
  }, [state.songIndex, optimisticSongIndex]);
  const displaySongIndex =
    optimisticSongIndex != null ? optimisticSongIndex : state.songIndex;
  // Stable identity so the memoized setlist isn't invalidated every frame by
  // a freshly-allocated click handler.
  const selectSong = useCallback((i: number) => {
    setOptimisticSongIndex(i);
    void transport.select(i);
  }, []);

  const hasSongs = state.songs.length > 0;
  // Project-global metronome (not per-song). Optimistic override until
  // state.click catches up from the WS snapshot.
  const isMetronomeOn = metronomeOverride ?? state.click?.enabled ?? false;
  useEffect(() => {
    if (metronomeOverride != null && state.click?.enabled === metronomeOverride)
      setMetronomeOverride(null);
  }, [state.click?.enabled, metronomeOverride]);

  const patchProjectClick = (partial: {
    click?: boolean;
    clickBusId?: string;
    clickSends?: ClickSendRow[];
  }) => {
    const idx = hasSongs ? (state.songIndex >= 0 ? state.songIndex : 0) : -1;
    const s = hasSongs ? state.songs[idx] : null;
    void builder.songUpdate({
      index: idx,
      name: s?.name ?? "",
      bpm: s?.bpm ?? 120,
      mode: s?.mode ?? "wait",
      tsNum: s?.tsNum ?? 4,
      tsDen: s?.tsDen ?? 4,
      click: partial.click ?? state.click?.enabled ?? false,
      // Preserve empty clickBusId (Sends Only) — never coerce "" → main.
      clickBusId:
        partial.clickBusId !== undefined
          ? partial.clickBusId
          : state.click
            ? sourceOutputBusId(state.click.output)
            : (s?.clickBusId ?? ""),
      clickSends: (
        partial.clickSends ??
        (state.click
          ? outputSendsToClickRows(state.click.output)
          : undefined) ??
        s?.clickSends ??
        []
      ).map((cs) => ({
        busId: cs.busId,
        level: cs.level,
        enabled: cs.enabled,
      })),
    });
  };

  const toggleMetronome = () => {
    const nextState = !isMetronomeOn;
    setMetronomeOverride(nextState);
    patchProjectClick({ click: nextState });
  };

  // Toggle a send on/off for the metronome (aux bus click routing)
  const toggleClickSend = (busId: string) => {
    const clickSends = state.click
      ? outputSendsToClickRows(state.click.output)
      : [];
    const existing = clickSends.find((cs) => cs.busId === busId);
    let newSends: ClickSendRow[];
    if (existing) {
      newSends = clickSends.map((cs) =>
        cs.busId === busId ? { ...cs, enabled: !cs.enabled } : cs,
      );
    } else {
      newSends = [...clickSends, { busId, level: 100, enabled: true }];
    }
    patchProjectClick({ clickSends: newSends });
  };

  // ONE continuous absolute clock for transport. Song-local is derived from
  // the current song's offset so gapless boundaries don't reset a second clock.
  //
  // Deliberately NOT mirrored into React state (the trailing `false`): the
  // only things that read this clock are the four readouts below, and each
  // paints itself off the shared frame driver. Mirroring it re-rendered the
  // entire Player -- setlist, meter bay, light preview, transport -- sixty
  // times a second to move a handful of digits. Timeline already reads its
  // playhead this way; see useContinuousPlayhead's `publishToReact`.
  const [, , getLiveAbsolute] = useContinuousPlayhead(
    state.globalPlayheadSeconds,
    state.playing,
    state.projectName,
    false,
    undefined,
    undefined,
    false,
  );

  const song =
    state.songIndex >= 0 && state.songs[state.songIndex]
      ? state.songs[state.songIndex]
      : null;

  // Match Timeline's duration math so local clock and needle agree.
  let songOffset = 0;
  let songLength = 0;
  if (state.songs.length > 0 && state.songIndex >= 0) {
    for (let i = 0; i < state.songs.length; i++) {
      const fromAll = allPeaks?.songs[i]?.tracks;
      const fromCurrent = i === state.songIndex ? peaks?.tracks : undefined;
      let len = 0;
      for (const r of state.songs[i].regions ?? []) {
        if (r.durationSeconds) len = Math.max(len, r.durationSeconds);
      }
      for (const p of fromAll ?? fromCurrent ?? []) {
        if (p.durationSeconds) len = Math.max(len, p.durationSeconds);
      }
      len = Math.max(len, 1);
      if (i === state.songIndex) {
        songLength = len;
        break;
      }
      songOffset += len;
    }
  }
  if (songLength <= 0 && peaks?.tracks) {
    for (const tr of peaks.tracks) {
      if (tr && tr.durationSeconds > songLength)
        songLength = tr.durationSeconds;
    }
  }
  // Song-local = absolute − offset of current song (one timeline, not two).
  // A live read, not a rendered value -- see the clock above.
  const liveSongSeconds = () => Math.max(0, getLiveAbsolute() - songOffset);

  // Empty string = Sends Only (must not fall back to main via falsy ||).
  const currentClickBus = state.click
    ? sourceOutputBusId(state.click.output)
    : "";
  const auxBusses = state.busses.filter((b) => b.isAux);
  const enabledClickSendIds = (
    state.click ? outputSendsToClickRows(state.click.output) : []
  )
    .filter((cs) => cs.enabled)
    .map((cs) => cs.busId);

  const changeClickBus = (busId: string) => {
    // busId may be "" for Sends Only. Project-global.
    patchProjectClick({ clickBusId: busId });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto sm:gap-3 sm:overflow-visible">
      {/* ── 1. Top Transport bar ──────────────────────────────── */}
      {/* Stacks on phones: the desktop row is one ~900px-wide line of clock,
          title, transport and health graphs that cannot usefully shrink. */}
      <Card className="flex shrink-0 flex-col items-stretch gap-0 overflow-hidden sm:flex-row p-0">
        {/* Clock + bar/beat + abs (full info — header has compact clock) */}
        <div className="flex shrink-0 flex-col justify-center border-b border-default/30 px-4 py-2 sm:border-b-0 sm:border-r sm:px-5 sm:py-2.5">
          <div
            style={{ fontWeight: "100" }}
            className={`font-mono text-2xl tabular-nums tracking-tight leading-none sm:text-3xl ${
              state.playing ? "text-success" : "text-foreground"
            }`}
          >
            {/* The clock runs at the full frame rate; the readouts below it
                are coarser on purpose -- a bar/beat that only changes a few
                times a second does not need sampling sixty. */}
            <LiveReadout
              sample={() => formatTime(liveSongSeconds())}
              intervalMs={0}
            />
            {songLength > 0 && (
              <span className="ml-2 text-sm font-normal text-foreground/25">
                / {formatTime(songLength)}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <LiveReadout
              className="font-mono text-base font-semibold tabular-nums text-accent"
              sample={() =>
                song ? barBeat(liveSongSeconds(), song.bpm, song.tsNum) : "—"
              }
            />
            <span className="text-[11px] text-foreground/30">bar | beat</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5 opacity-60">
            <LiveReadout
              className="font-mono text-[10px] tabular-nums text-foreground/35"
              sample={() => formatTime(getLiveAbsolute())}
            />
            <LiveReadout
              className="font-mono text-[10px] tabular-nums text-foreground/35"
              sample={() =>
                song
                  ? globalBarBeat(
                      state.globalBeatsElapsed +
                        Math.max(
                          0,
                          getLiveAbsolute() - state.globalPlayheadSeconds,
                        ) *
                          ((song.bpm > 0 ? song.bpm : 120) / 60),
                      song.tsNum,
                    )
                  : "—"
              }
            />
            <span className="text-[9px] text-foreground/25">abs</span>
          </div>
        </div>

        {/* Song metadata — flex-1 so the card fills evenly (clock + transport
            + health stay fixed; title/BPM claim the leftover width). */}
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center border-b border-default/30 px-4 py-2 text-center sm:border-b-0 sm:border-r sm:py-2.5">
          <div className="w-full max-w-full truncate text-sm font-semibold">
            {state.songName || "No song selected"}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[11px] text-foreground/40">
            {song && song.bpm > 0 ? (
              <>
                <span className="font-mono tabular-nums text-accent">
                  {song.bpm.toFixed(1)} BPM
                </span>
                <span>
                  {song.tsNum}/{song.tsDen}
                </span>
                <span>{state.tracks.length} tracks</span>
              </>
            ) : (
              <span>Select a song to begin</span>
            )}
            {state.drift !== 1 && (
              <span className="text-warning">
                drift ×{state.drift.toFixed(4)}
              </span>
            )}
          </div>
        </div>

        {/* Transport control buttons */}
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-3 py-2.5">
          {/* `size` is repeated on every button rather than left to the group.
              ButtonGroup shares it by marking its DIRECT children, and these
              are wrapped in Tooltip -- so the mark lands on the tooltip and the
              buttons inside fall back to the default size, which is what made
              Play stand a notch taller than the icons beside it. (The group's
              own rounding still works: Tooltip renders no wrapper element, so
              the buttons remain its first and last DOM children.) */}
          <ButtonGroup aria-label="Transport">
            <Tooltip>
              <Button
                size="sm"
                isIconOnly
                variant="default-soft"
                onPress={() => transport.prev()}
                aria-label="Previous"
              >
                <SkipBack size={16} />
              </Button>
              <Tooltip.Content>Previous</Tooltip.Content>
            </Tooltip>
            <Button
              size="sm"
              variant={state.playing ? "success-soft" : "accent-soft"}
              onPress={() =>
                state.playing ? transport.stop() : transport.play()
              }
              aria-label={state.playing ? "Pause" : "Play"}
            >
              <ButtonGroup.Separator />
              {state.playing ? <Pause size={15} /> : <Play size={15} />}
            </Button>
            <Tooltip>
              <Button
                size="sm"
                isIconOnly
                variant="danger-soft"
                onPress={() => void transport.stopToStart()}
                aria-label="Stop"
              >
                <ButtonGroup.Separator />
                <Square size={16} />
              </Button>
              <Tooltip.Content>
                Stop — press again at song start to jump to project start
              </Tooltip.Content>
            </Tooltip>
            <Tooltip>
              <Button
                size="sm"
                isIconOnly
                variant="default-soft"
                onPress={() => transport.next()}
                aria-label="Next"
              >
                <ButtonGroup.Separator />
                <SkipForward size={16} />
              </Button>
              <Tooltip.Content>Next</Tooltip.Content>
            </Tooltip>
          </ButtonGroup>

          {/* Global metronome + its send routing. Two unrelated booleans, hence
              a multiple-selection group rather than an exclusive one: the click
              can be on with the routing panel shut, and vice versa.

              The routing panel is a real Popover: it renders in an overlay
              portal, so it is no longer clipped away by the transport card's
              own `overflow-hidden` (which is what kept it invisible), and it
              closes on an outside click or Escape instead of only on a second
              press of the chevron. `triggerRef` anchors it to the group --
              HeroUI's Popover normally takes its anchor from a Button child,
              and a ToggleButton is a different primitive that never registers
              itself as one. */}
          <Popover isOpen={clickSendsOpen} onOpenChange={setClickSendsOpen}>
            <div ref={clickRoutingAnchorRef}>
              <ToggleButtonGroup
                aria-label="Metronome"
                size="sm"
                selectionMode="multiple"
                selectedKeys={[
                  ...(isMetronomeOn ? ["on"] : []),
                  ...(clickSendsOpen ? ["routing"] : []),
                ]}
                onSelectionChange={(keys) => {
                  const next = new Set(Array.from(keys, String));
                  if (next.has("on") !== isMetronomeOn) toggleMetronome();
                  setClickSendsOpen(next.has("routing"));
                }}
              >
                <ToggleButton id="on">
                  <FontIcon name="metronome" size={16} />
                  <span>Click</span>
                </ToggleButton>
                <Tooltip>
                  <ToggleButton
                    id="routing"
                    isIconOnly
                    aria-label="Click send routing"
                  >
                    <ToggleButtonGroup.Separator />
                    <ChevronDown
                      size={12}
                      className={`transition-transform ${clickSendsOpen ? "rotate-180" : ""}`}
                    />
                  </ToggleButton>
                  <Tooltip.Content>Click send routing</Tooltip.Content>
                </Tooltip>
              </ToggleButtonGroup>
            </div>
            {/* 1-to-1 track parity with Output Bus select + Aux Sends list */}
            <Popover.Content
              triggerRef={clickRoutingAnchorRef}
              placement="bottom end"
              className="w-64"
            >
              <Popover.Dialog className="space-y-3 select-none">
                <div className="flex items-center justify-between border-b border-default/20 pb-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-foreground/50">
                    Click Routing
                  </span>
                  <span className="text-[10px] font-mono text-accent">
                    Metronome
                  </span>
                </div>

                {/* Primary Destination Bus Select (1-to-1 like track output) */}
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-foreground/60">
                    Output Bus
                  </label>
                  <select
                    value={
                      currentClickBus === ""
                        ? "__sends_only__"
                        : currentClickBus
                    }
                    onChange={(e) =>
                      changeClickBus(
                        e.target.value === "__sends_only__"
                          ? ""
                          : e.target.value,
                      )
                    }
                    className="w-full rounded-md border border-default/40 bg-default/20 px-2 py-1 text-xs text-foreground focus:outline-none"
                  >
                    {state.busses.map((bus) => (
                      <option key={bus.id} value={bus.id}>
                        {bus.name || bus.id}
                      </option>
                    ))}
                    <option value="__sends_only__">Sends Only</option>
                  </select>
                </div>

                {/* Aux Sends List (1-to-1 like track sends) */}
                <div className="space-y-1.5">
                  <div className="text-[10px] font-semibold text-foreground/60">
                    Aux Sends
                  </div>
                  {auxBusses.length === 0 ? (
                    <div className="text-[10px] text-foreground/30 py-1">
                      No Aux buses
                    </div>
                  ) : (
                    /* Independent on/off per bus -- a multiple-selection group,
                       detached so each send reads as its own row rather than a
                       segment of one bar. */
                    <ToggleButtonGroup
                      aria-label="Aux sends"
                      orientation="vertical"
                      isDetached
                      fullWidth
                      size="sm"
                      selectionMode="multiple"
                      selectedKeys={enabledClickSendIds}
                      onSelectionChange={(keys) => {
                        const next = new Set(Array.from(keys, String));
                        for (const bus of auxBusses) {
                          if (
                            next.has(bus.id) !==
                            enabledClickSendIds.includes(bus.id)
                          )
                            toggleClickSend(bus.id);
                        }
                      }}
                    >
                      {auxBusses.map((bus) => (
                        <ToggleButton key={bus.id} id={bus.id}>
                          <span className="truncate">{bus.name || bus.id}</span>
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                  )}
                </div>
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
        </div>

        {/* Dual sparkline graphs: CPU & RAM */}
        <SystemHealthWidget
          health={state.health}
          playing={state.playing}
          cpuHistory={cpuHistory}
          ramHistory={ramHistory}
        />
      </Card>

      {/* ── 2. Middle: Setlist + Bus meters (flex layout, max 40% meters width) ─ */}
      <div className="flex shrink-0 flex-col gap-2 sm:h-[210px] sm:flex-row sm:gap-3">
        <SetlistPanel
          songs={state.songs}
          activeIndex={displaySongIndex}
          playing={state.playing}
          onSelect={selectSong}
        />

        <PlayerLightStagePreview
          fixtures={state.lighting?.fixtures ?? EMPTY_FIXTURES}
          enabled={Boolean(state.lighting?.enabled)}
        />

        <BusMetersPanel
          meters={state.meters}
          busses={state.busses}
          tracks={state.tracks}
          click={state.click}
        />
      </div>

      {/* ── 3. Bottom: Timeline (expands to fill remaining height) ──
          Deliberately NOT rendered on phones: a multi-song arrangement with
          per-region waveform canvases is neither usable at that width nor
          affordable on that hardware, and `display: none` would still build
          and animate all of it. */}
      {!compact && (
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <Timeline
            state={state}
            peaks={peaks}
            allPeaks={allPeaks}
            pxPerSec={pxPerSec}
            setPxPerSec={setPxPerSec}
            readOnly
          />
        </Card>
      )}
    </div>
  );
}
