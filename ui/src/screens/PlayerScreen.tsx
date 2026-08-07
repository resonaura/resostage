import { Button, ScrollShadow } from "@heroui/react";
import {
  ChevronDown,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react";
import { useEffect, useState } from "react";
import { FontIcon } from "../components/FontIcon";
import { LevelMeterBar } from "../components/LevelMeterBar";
import { VUMeter } from "../components/VUMeter";
import { ResoLightStage3D } from "../components/light/ResoLightStage3D";
import { Timeline } from "../components/Timeline";
import { builder, transport } from "../lib/api";
import { getLiveLevels } from "../lib/liveLevels";
import { useContinuousPlayhead } from "../lib/optimistic";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type AllPeaksResponse,
  type BusRow,
  type ClickSendRow,
  type MeterRow,
  type PeaksResponse,
  type WebUiState,
} from "../lib/types";

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

// One accent for every Direct Output lane (regardless of pairing), so the
// device outputs read as a single family in the preview.
const DIRECT_OUT_COLOR = "#7c3aed";
const BUS_ACCENT_CYCLE = ["#30d158", "#ff9230", "#db34f2", "#00d2e0", "#ffd600"];

/** "direct:3" -> 3; anything else -> null. */
function laneNumber(id: string): number | null {
  if (!id.startsWith("direct:")) return null;
  const n = Number(id.slice("direct:".length));
  return Number.isFinite(n) ? n : null;
}

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

  // A project bus (main / aux / send) with a mono physical target uses that
  // single lane alone. channels>=2 marks a stereo pair, so it does NOT solo.
  // Direct lanes themselves are the outputs, not route sources -- detect them
  // by id (the wire does not flag isDirectOut).
  for (const b of busses) {
    if (b.id.startsWith("direct:")) continue;
    if (b.channels <= 1) solo.add(b.startChannel + 1);
  }

  const applyRefs = (id: string | undefined) => {
    if (!id || !id.startsWith("direct:")) return;
    const lanes = id
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => /^direct:(\d+)$/.exec(t))
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
      ? "#0091ff"
      : busObj?.isAux
        ? "#ff9230"
        : BUS_ACCENT_CYCLE[auxIdx++ % BUS_ACCENT_CYCLE.length];
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
        accent: DIRECT_OUT_COLOR,
        meters: [a, b],
      });
      i += 2;
    } else {
      groups.push({
        id: `out:${laneA}`,
        name: `Out ${laneA}`,
        accent: DIRECT_OUT_COLOR,
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
function SystemHealthWidget({
  state,
  cpuHistory,
  ramHistory,
}: {
  state: WebUiState;
  cpuHistory: number[];
  ramHistory: number[];
}) {
  const h = state.health;
  // Numbers track the 1 Hz history sample (not every telemetry frame) so
  // the readout doesn't jitter between SystemHealth samples.
  const cpuVal = Math.max(
    0,
    cpuHistory[cpuHistory.length - 1] ?? h?.cpuPercent ?? 0,
  );
  const ramVal =
    ramHistory[ramHistory.length - 1] ?? (h?.rssBytes ?? 0) / (1024 * 1024);

  return (
    <div className="flex shrink-0 items-center gap-4 border-l border-default/30 px-4 py-2 tabular-nums">
      {/* Graph 1: CPU (Accent Color #0091ff) */}
      <Sparkline
        history={cpuHistory}
        color="var(--accent, #0091ff)"
        gradientId="cpuGrad"
        label="CPU"
        valueText={`${cpuVal.toFixed(1)}%`}
        maxMinVal={Math.max(100, Math.ceil(Math.max(cpuVal, 1) / 100) * 100)}
      />

      {/* Graph 2: RAM (Purple Color #a855f7) */}
      <Sparkline
        history={ramHistory}
        color="#a855f7"
        gradientId="ramGrad"
        label="RAM"
        valueText={`${ramVal.toFixed(0)} MB`}
        maxMinVal={Math.max(512, Math.ceil(ramVal / 256) * 256)}
      />

      {/* Status details */}
      <div className="flex flex-col gap-0.5 text-[10px] text-foreground/40">
        <div
          className={`flex items-center gap-1 font-bold ${state.playing ? "text-success" : "text-danger"}`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${state.playing ? "animate-pulse bg-success" : "bg-danger"}`}
          />
          {state.playing ? "PLAYING" : "STOPPED"}
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
}

function PlayerLightStagePreview({ state }: { state: WebUiState }) {
  const li = state.lighting;
  const fixtures = li?.fixtures ?? [];

  if (fixtures.length === 0) return null;

  return (
    <div className="flex h-full w-52 shrink-0 flex-col overflow-hidden rounded-xl border border-default/30 bg-background-secondary relative">
      <div className="border-b border-default/20 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-foreground/35 flex items-center justify-between z-10">
        <span>Stage Lights</span>
        <span className="text-[9px] font-mono text-foreground/40">
          {fixtures.length} fix
        </span>
      </div>
      <div className="flex-1 min-h-0 relative">
        <ResoLightStage3D
          mode="preview"
          fixtures={fixtures}
          live={Boolean(li?.enabled)}
          chrome="minimal"
        />
      </div>
    </div>
  );
}

type BusMeterMode = "bars" | "vu";

const BUS_METER_MODE_KEY = "resostage.player.busMeterMode";

function readBusMeterMode(): BusMeterMode {
  try {
    const saved = localStorage.getItem(BUS_METER_MODE_KEY);
    if (saved === "bars" || saved === "vu") return saved;
  } catch {
    /* private mode */
  }
  return "vu";
}

function BusMetersPanel({ state }: { state: WebUiState }) {
  const [mode, setMode] = useState<BusMeterMode>(readBusMeterMode);
  useEffect(() => {
    try {
      localStorage.setItem(BUS_METER_MODE_KEY, mode);
    } catch {
      /* best-effort */
    }
  }, [mode]);
  const groups = busMeterGroups(
    state.meters,
    state.busses,
    state.tracks,
    state.click ? sourceOutputBusId(state.click.output) : undefined,
    state.click ? outputSendsToClickRows(state.click.output) : undefined,
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
    <div className="flex min-h-0 max-w-[40%] shrink-0 flex-col overflow-hidden rounded-xl border border-default/30 bg-background-secondary">
      <div className="flex items-center justify-between border-b border-default/20 px-3 py-1.5">
        <span className="text-[11px] font-bold uppercase tracking-widest text-foreground/35">
          Bus meters
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={mode === "bars" ? "secondary" : "outline"}
            onPress={() => setMode("bars")}
            className="!h-6 !min-h-0 !px-2 text-[10px]"
          >
            Simple
          </Button>
          <Button
            size="sm"
            variant={mode === "vu" ? "secondary" : "outline"}
            onPress={() => setMode("vu")}
            className="!h-6 !min-h-0 !px-2 text-[10px]"
          >
            VU
          </Button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="flex h-full items-center justify-center py-4 text-sm text-foreground/40">
          No busses.
        </div>
      ) : mode === "vu" ? (
        <ScrollShadow
          orientation="horizontal"
          className="flex min-h-0 flex-1 items-center gap-4 p-3"
        >
          {groups.map((g) => {
            const db = Math.max(...g.meters.map((m) => m.peakDb));
            return (
              <div
                key={g.id}
                className="flex h-full w-[176px] shrink-0 items-center"
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
          orientation="horizontal"
          className="flex min-h-0 flex-1 items-center gap-3 p-4"
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
                className="flex h-full flex-col items-center justify-between gap-1.5 py-1"
              >
                <div className="truncate text-center text-xs font-semibold text-foreground/80 w-[72px]">
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
                    barClassName="h-full w-1.5"
                  />
                </div>
                <div className="text-center text-[10px] tabular-nums text-foreground/50">
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
                  <div className="text-[9px] text-foreground/35">
                    {lufs <= -144 ? "−∞ L" : `${lufs.toFixed(1)} L`}
                  </div>
                </div>
              </div>
            );
          })}
        </ScrollShadow>
      )}
    </div>
  );
}

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
  const [metronomeOverride, setMetronomeOverride] = useState<boolean | null>(
    null,
  );
  const [clickSendsOpen, setClickSendsOpen] = useState(false);
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

  const hasSongs = state.songs.length > 0;
  // Project-global metronome (not per-song). Optimistic override until
  // state.click catches up from the WS snapshot.
  const isMetronomeOn = metronomeOverride ?? state.click?.enabled ?? false;
  useEffect(() => {
    if (
      metronomeOverride != null &&
      state.click?.enabled === metronomeOverride
    )
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
          : (state.click
              ? sourceOutputBusId(state.click.output)
              : (s?.clickBusId ?? "")),
      clickSends: (
        partial.clickSends ??
        (state.click ? outputSendsToClickRows(state.click.output) : undefined) ??
        s?.clickSends ??
        []
      ).map((cs) => ({
        busId: cs.busId,
        gainDb: cs.gainDb,
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
      newSends = [
        ...clickSends,
        { busId, gainDb: 0.0, enabled: true },
      ];
    }
    patchProjectClick({ clickSends: newSends });
  };

  // ONE continuous absolute clock for transport. Song-local is derived from
  // the current song's offset so gapless boundaries don't reset a second clock.
  const [displayGlobalSeconds] = useContinuousPlayhead(
    state.globalPlayheadSeconds,
    state.playing,
    state.projectName,
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
  const displaySeconds = Math.max(0, displayGlobalSeconds - songOffset);

  // Empty string = Sends Only (must not fall back to main via falsy ||).
  const currentClickBus = state.click
    ? sourceOutputBusId(state.click.output)
    : "";
  const auxBusses = state.busses.filter((b) => b.isAux);

  const changeClickBus = (busId: string) => {
    // busId may be "" for Sends Only. Project-global.
    patchProjectClick({ clickBusId: busId });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* ── 1. Top Transport bar ──────────────────────────────── */}
      <div className="flex shrink-0 items-stretch gap-0 overflow-hidden rounded-xl border border-default/30 bg-background-secondary">
        {/* Clock + bar/beat + abs (full info — header has compact clock) */}
        <div className="flex shrink-0 flex-col justify-center border-r border-default/30 px-5 py-2.5">
          <div
            style={{ fontWeight: "100" }}
            className={`font-mono text-3xl tabular-nums tracking-tight leading-none ${
              state.playing ? "text-success" : "text-foreground"
            }`}
          >
            {formatTime(displaySeconds)}
            {songLength > 0 && (
              <span className="ml-2 text-sm font-normal text-foreground/25">
                / {formatTime(songLength)}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-base font-semibold tabular-nums text-accent">
              {song ? barBeat(displaySeconds, song.bpm, song.tsNum) : "—"}
            </span>
            <span className="text-[11px] text-foreground/30">bar | beat</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5 opacity-60">
            <span className="font-mono text-[10px] tabular-nums text-foreground/35">
              {formatTime(displayGlobalSeconds)}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-foreground/35">
              {song
                ? globalBarBeat(
                    state.globalBeatsElapsed +
                      Math.max(
                        0,
                        displayGlobalSeconds - state.globalPlayheadSeconds,
                      ) *
                        ((song.bpm > 0 ? song.bpm : 120) / 60),
                    song.tsNum,
                  )
                : "—"}
            </span>
            <span className="text-[9px] text-foreground/25">abs</span>
          </div>
        </div>

        {/* Song metadata — flex-1 so the card fills evenly (clock + transport
            + health stay fixed; title/BPM claim the leftover width). */}
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center border-r border-default/30 px-4 py-2.5 text-center">
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
        <div className="flex shrink-0 items-center gap-1.5 px-3 py-2.5">
          <button
            type="button"
            onClick={() => transport.prev()}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-default/40 bg-default/10 text-foreground/60 transition-colors hover:bg-default/25 hover:text-foreground"
            title="Previous"
          >
            <SkipBack size={16} />
          </button>
          {/* Fixed width so Play ↔ Pause does not reflow the transport bar */}
          <Button
            variant="secondary"
            className="flex h-9 w-[5.75rem] shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
            onPress={() =>
              state.playing ? transport.stop() : transport.play()
            }
            aria-label={state.playing ? "Pause" : "Play"}
          >
            {state.playing ? <Pause size={15} /> : <Play size={15} />}
            <span className="tabular-nums">
              {state.playing ? "Pause" : "Play"}
            </span>
          </Button>
          <button
            type="button"
            onClick={() => void transport.stopToStart()}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-danger/20 bg-danger/10 text-danger/60 transition-colors hover:bg-danger/20 hover:text-danger"
            title="Stop (press again at song start to jump to project start)"
          >
            <Square size={16} />
          </button>
          <button
            type="button"
            onClick={() => transport.next()}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-default/40 bg-default/10 text-foreground/60 transition-colors hover:bg-default/25 hover:text-foreground"
            title="Next"
          >
            <SkipForward size={16} />
          </button>

          {/* Global Metronome Toggle + Send routing */}
          <div className="relative flex items-stretch rounded-lg border border-default/40 overflow-hidden">
            {/* Main click toggle */}
            <button
              type="button"
              onClick={toggleMetronome}
              className={`flex h-9 items-center gap-1.5 px-2.5 text-xs font-semibold transition-colors ${
                isMetronomeOn
                  ? "bg-accent/20 text-accent"
                  : "bg-default/10 text-foreground/40 hover:bg-default/25 hover:text-foreground"
              }`}
              title={isMetronomeOn ? "Metronome: ON" : "Metronome: OFF"}
            >
              <FontIcon name="metronome" size={16} />
              <span>Click</span>
            </button>
            {/* Send routing chevron */}
            <button
              type="button"
              onClick={() => setClickSendsOpen((o) => !o)}
              className={`flex h-9 items-center border-l border-default/40 px-1.5 transition-colors ${
                clickSendsOpen
                  ? "bg-accent/10 text-accent"
                  : "bg-default/10 text-foreground/40 hover:bg-default/25 hover:text-foreground"
              }`}
              title="Click send routing"
            >
              <ChevronDown
                size={12}
                className={`transition-transform ${clickSendsOpen ? "rotate-180" : ""}`}
              />
            </button>
            {/* Popover: 1-to-1 track parity with Output Bus select + Aux Sends list */}
            {clickSendsOpen && (
              <div className="absolute left-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-default/40 bg-surface/95 backdrop-blur-md p-3 shadow-2xl space-y-3 select-none">
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
                    auxBusses.map((bus) => {
                      const send = (state.click
                        ? outputSendsToClickRows(state.click.output)
                        : []
                      ).find((cs) => cs.busId === bus.id);
                      const isActive = send?.enabled === true;
                      return (
                        <div
                          key={bus.id}
                          className="flex items-center justify-between gap-2 bg-default/10 p-1.5 rounded-lg border border-default/20"
                        >
                          <button
                            type="button"
                            onClick={() => toggleClickSend(bus.id)}
                            className={`flex items-center gap-1.5 text-xs font-medium truncate ${
                              isActive
                                ? "text-accent"
                                : "text-foreground/50 hover:text-foreground"
                            }`}
                          >
                            <span
                              className={`h-2 w-2 rounded-full shrink-0 ${
                                isActive ? "bg-accent" : "bg-default/40"
                              }`}
                            />
                            <span className="truncate">
                              {bus.name || bus.id}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleClickSend(bus.id)}
                            className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                              isActive
                                ? "bg-accent/20 text-accent border border-accent/40"
                                : "bg-default/20 text-foreground/40 hover:bg-default/30"
                            }`}
                          >
                            {isActive ? "ACTIVE" : "OFF"}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Dual sparkline graphs: CPU & RAM */}
        <SystemHealthWidget
          state={state}
          cpuHistory={cpuHistory}
          ramHistory={ramHistory}
        />
      </div>

      {/* ── 2. Middle: Setlist + Bus meters (flex layout, max 40% meters width) ─ */}
      <div className="flex h-[210px] shrink-0 gap-3">
        {/* Setlist (occupies all remaining available width) */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-default/30 bg-background-secondary">
          <div className="border-b border-default/20 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-foreground/35">
            Setlist
          </div>
          <ScrollShadow orientation="vertical" className="min-h-0 flex-1">
            {state.songs.length === 0 ? (
              /* Centered vertically when setlist is empty */
              <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-foreground/40">
                No songs in this project.
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-default/15">
                {state.songs.map((s, i) => {
                  const isActive = i === displaySongIndex;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        setOptimisticSongIndex(i);
                        void transport.select(i);
                      }}
                      className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-${isActive ? "accent/20" : "default/20"} ${
                        isActive ? "bg-accent/8" : ""
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all ${
                          isActive && state.playing
                            ? "animate-pulse scale-125 bg-success shadow-[0_0_4px_#30d158]"
                            : isActive
                              ? "bg-accent"
                              : "bg-foreground/12"
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div
                          className={`truncate text-sm ${isActive ? "font-semibold text-foreground" : "text-foreground/80"}`}
                        >
                          {i + 1}. {s.name}
                        </div>
                        <div className="text-[10px] text-foreground/35">
                          {s.bpm.toFixed(1)} bpm ·{" "}
                          {s.mode === "auto" ? "auto" : "wait"} ·{" "}
                          {s.regions?.length ?? 0} clips
                        </div>
                      </div>
                      {isActive && (
                        <span
                          className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold ${state.playing ? "bg-success/15 text-success" : "bg-default/30 text-foreground/30"}`}
                        >
                          {state.playing ? "NOW" : "CUE"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </ScrollShadow>
        </div>

        <PlayerLightStagePreview state={state} />

        <BusMetersPanel state={state} />
      </div>

      {/* ── 3. Bottom: Timeline (expands to fill remaining height) ── */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Timeline
          state={state}
          peaks={peaks}
          allPeaks={allPeaks}
          pxPerSec={pxPerSec}
          setPxPerSec={setPxPerSec}
          readOnly
        />
      </div>
    </div>
  );
}
