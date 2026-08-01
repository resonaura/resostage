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
import { Timeline } from "../components/Timeline";
import { builder, transport } from "../lib/api";
import { useContinuousPlayhead } from "../lib/optimistic";
import type {
  AllPeaksResponse,
  ClickSendRow,
  PeaksResponse,
  WebUiState,
} from "../lib/types";

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
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
// (see AudioEngine::globalBeatsElapsed). Bar-wraps using the *current* song's
// time signature -- if an earlier song had a different signature, its beats
// don't necessarily land on a bar boundary under the current one; inherent
// to any cross-time-signature cumulative bar counter, not a bug.
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
  const isMetronomeOn =
    metronomeOverride ?? (hasSongs ? state.songs.some((s) => s.click) : false);

  const toggleMetronome = () => {
    const nextState = !isMetronomeOn;
    setMetronomeOverride(nextState);

    if (hasSongs) {
      const idx = state.songIndex >= 0 ? state.songIndex : 0;
      const s = state.songs[idx];
      if (s) {
        // Preserve empty clickBusId (Sends Only) — never coerce "" → main.
        void builder.songUpdate({
          index: idx,
          name: s.name,
          bpm: s.bpm,
          mode: s.mode,
          tsNum: s.tsNum,
          tsDen: s.tsDen,
          click: nextState,
          clickBusId: s.clickBusId ?? "",
          clickSends: (s.clickSends ?? []).map((cs) => ({
            busId: cs.busId,
            gainDb: cs.gainDb,
            enabled: cs.enabled,
          })),
        });
      }
    }
  };

  // Toggle a send on/off for the metronome (aux bus click routing)
  const toggleClickSend = (busId: string) => {
    if (!hasSongs) return;
    const idx = state.songIndex >= 0 ? state.songIndex : 0;
    const s = state.songs[idx];
    if (!s) return;
    const existing = (s.clickSends ?? []).find((cs) => cs.busId === busId);
    let newSends: ClickSendRow[];
    if (existing) {
      // Toggle enabled flag
      newSends = (s.clickSends ?? []).map((cs) =>
        cs.busId === busId ? { ...cs, enabled: !cs.enabled } : cs,
      );
    } else {
      // Add new send at unity gain, enabled
      newSends = [
        ...(s.clickSends ?? []),
        { busId, gainDb: 0.0, enabled: true },
      ];
    }
    void builder.songUpdate({
      index: idx,
      name: s.name,
      bpm: s.bpm,
      mode: s.mode,
      tsNum: s.tsNum,
      tsDen: s.tsDen,
      click: s.click,
      clickBusId: s.clickBusId,
      clickSends: newSends,
    });
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
  const currentClickBus =
    hasSongs && state.songIndex >= 0 && state.songs[state.songIndex]
      ? (state.songs[state.songIndex].clickBusId ?? "")
      : (state.busses[0]?.id ?? "");
  const auxBusses = state.busses.filter((b) => b.isAux);

  const changeClickBus = (busId: string) => {
    if (!hasSongs) return;
    const idx = state.songIndex >= 0 ? state.songIndex : 0;
    const s = state.songs[idx];
    if (!s) return;
    // busId may be "" for Sends Only.
    void builder.songUpdate({
      index: idx,
      name: s.name,
      bpm: s.bpm,
      mode: s.mode,
      tsNum: s.tsNum,
      tsDen: s.tsDen,
      click: s.click,
      clickBusId: busId,
      clickSends: s.clickSends ?? [],
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* ── 1. Top Transport bar ──────────────────────────────── */}
      <div className="flex shrink-0 items-stretch gap-0 overflow-hidden rounded-xl border border-default/30 bg-background-secondary">
        {/* Clock + bar/beat */}
        <div className="flex flex-col justify-center border-r border-default/30 px-5 py-2.5">
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
          {/* Absolute whole-project position (not song-relative) -- small/gray by design */}
          <div className="mt-0.5 flex items-baseline gap-1.5 opacity-60">
            <span className="font-mono text-[10px] tabular-nums text-foreground/35">
              {formatTime(displayGlobalSeconds)}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-foreground/35">
              {song
                ? globalBarBeat(
                    // Reconstruct beats from smoothed global seconds using the
                    // current song's bpm as a local approximation for the
                    // fractional tail (prior songs already baked into the
                    // server's globalBeatsElapsed baseline via the WS delta).
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

        {/* Song metadata */}
        <div className="flex flex-1 flex-col justify-center border-r border-default/30 px-4 py-2.5 min-w-0">
          <div className="truncate text-sm font-semibold">
            {state.songName || "No song selected"}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-foreground/40">
            {song && song.bpm > 0 ? (
              <>
                <span>{song.bpm.toFixed(1)} bpm</span>
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
        <div className="flex items-center gap-1.5 px-3 py-2.5">
          <button
            type="button"
            onClick={() => transport.prev()}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-default/40 bg-default/10 text-foreground/60 transition-colors hover:bg-default/25 hover:text-foreground"
            title="Previous"
          >
            <SkipBack size={16} />
          </button>
          {/* Play button: Standard accent styling without hardcoded custom green */}
          <Button
            variant="secondary"
            className="flex h-9 px-4 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold bg-accent/20 text-accent hover:bg-accent/80 transition-colors"
            onPress={() =>
              state.playing ? transport.stop() : transport.play()
            }
            aria-label={state.playing ? "Pause" : "Play"}
          >
            {state.playing ? <Pause size={15} /> : <Play size={15} />}
            {state.playing ? "Pause" : "Play"}
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
                      const send = (song?.clickSends ?? []).find(
                        (cs) => cs.busId === bus.id,
                      );
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

        {/* Bus meters — Vertical meters (Capped at max 40% screen width) */}
        <div className="flex min-h-0 max-w-[40%] shrink-0 flex-col overflow-hidden rounded-xl border border-default/30 bg-background-secondary">
          <div className="border-b border-default/20 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-foreground/35">
            Bus meters
          </div>
          <ScrollShadow
            orientation="horizontal"
            className="flex min-h-0 flex-1 items-center justify-center gap-6 p-4"
          >
            {state.meters.length === 0 ? (
              <div className="py-4 text-center text-sm text-foreground/40">
                No busses.
              </div>
            ) : (
              state.meters.map((m, mi) => {
                const busObj = state.busses.find((b) => b.id === m.id);
                const displayName =
                  busObj?.name || (m.id === "main" ? "Main" : m.id);
                const isMaster =
                  busObj?.name?.toLowerCase() === "master" ||
                  m.id === "main" ||
                  m.id === "master";
                const accent = isMaster
                  ? "#0091ff"
                  : busObj?.isAux
                    ? "#ff9230"
                    : ["#30d158", "#ff9230", "#db34f2", "#00d2e0", "#ffd600"][
                        mi % 5
                      ];
                return (
                  <div
                    key={m.id}
                    className="flex h-full flex-col items-center justify-between gap-1.5 py-1"
                  >
                    {/* Bus name */}
                    <div
                      className="truncate text-center text-xs font-semibold text-foreground/80 w-[72px]"
                      title={displayName}
                    >
                      {displayName}
                    </div>
                    <div className="flex h-full min-h-0 flex-1 items-center justify-center">
                      <LevelMeterBar
                        db={m.peakDb}
                        dbL={m.peakDbL ?? m.peakDb}
                        dbR={m.peakDbR ?? m.peakDb}
                        accent={accent}
                        vertical={true}
                        showValue={false}
                        className="h-full"
                        barClassName="h-full w-1.5"
                      />
                    </div>
                    <div className="text-center text-[10px] tabular-nums text-foreground/50">
                      <div
                        className={
                          m.peakDb > -3
                            ? "text-danger font-bold"
                            : m.peakDb > -9
                              ? "text-warning font-semibold"
                              : ""
                        }
                      >
                        {m.peakDb <= -99 ? "−∞" : m.peakDb.toFixed(1)} dB
                      </div>
                      {/* Always-visible LUFS readout to prevent layout jump during silence */}
                      <div className="text-[9px] text-foreground/35">
                        {m.shortTermLufs <= -144
                          ? "−∞ L"
                          : `${m.shortTermLufs.toFixed(1)} L`}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </ScrollShadow>
        </div>
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
