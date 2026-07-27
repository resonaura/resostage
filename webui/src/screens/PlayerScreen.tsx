import { Button } from "@heroui/react";
import { ChevronDown } from "lucide-react";
import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LevelMeterBar } from "../components/LevelMeterBar";
import { Timeline } from "../components/Timeline";
import { builder, fetchAllPeaks, fetchPeaks, transport } from "../lib/api";
import type { AllPeaksResponse, ClickSendRow, PeaksResponse, WebUiState } from "../lib/types";

function MetronomeIcon({
  size = 16,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 18v-7" />
      <path d="M7 22l4-18h2l4 18H7z" />
      <path d="M9 14h6" />
    </svg>
  );
}

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
  const [displayCpu, setDisplayCpu] = useState(0);
  const [displayRam, setDisplayRam] = useState(0);

  const rawCpuRef = useRef(0);
  const rawRamRef = useRef(0);

  const coreCount =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 10;
  const rawCpu = h?.cpuPercent ?? 0;
  const targetCpu = Math.min(100, Math.max(0, rawCpu / coreCount));
  const targetRam = (h?.rssBytes ?? 0) / (1024 * 1024);

  rawCpuRef.current = targetCpu;
  rawRamRef.current = targetRam;

  // 1Hz (once per second) update for numerical readouts
  useEffect(() => {
    const timer = setInterval(() => {
      setDisplayCpu(rawCpuRef.current);
      setDisplayRam(rawRamRef.current);
    }, 1000);
    setDisplayCpu(rawCpuRef.current);
    setDisplayRam(rawRamRef.current);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex shrink-0 items-center gap-4 border-l border-default/30 px-4 py-2 tabular-nums">
      {/* Graph 1: CPU (Accent Color #0091ff) */}
      <Sparkline
        history={cpuHistory}
        color="var(--accent, #0091ff)"
        gradientId="cpuGrad"
        label="CPU"
        valueText={`${displayCpu.toFixed(1)}%`}
        maxMinVal={25}
      />

      {/* Graph 2: RAM (Track Palette Purple #c56cf0) */}
      <Sparkline
        history={ramHistory}
        color="#c56cf0"
        gradientId="ramGrad"
        label="RAM"
        valueText={`${displayRam.toFixed(0)} MB`}
        maxMinVal={200}
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
}: {
  state: WebUiState;
  cpuHistory: number[];
  ramHistory: number[];
}) {
  const [peaks, setPeaks] = useState<PeaksResponse | null>(null);
  const [allPeaks, setAllPeaks] = useState<AllPeaksResponse | null>(null);
  const [pxPerSec, setPxPerSec] = useState(40);
  const [metronomeOverride, setMetronomeOverride] = useState<boolean | null>(
    null,
  );
  const [clickSendsOpen, setClickSendsOpen] = useState(false);

  const hasSongs = state.songs.length > 0;
  const isMetronomeOn =
    metronomeOverride ?? (hasSongs ? state.songs.some((s) => s.click) : false);

  const toggleMetronome = () => {
    const nextState = !isMetronomeOn;
    setMetronomeOverride(nextState);
    const defaultClickBus = state.busses[0]?.id || "main";

    if (hasSongs) {
      const idx = state.songIndex >= 0 ? state.songIndex : 0;
      const s = state.songs[idx];
      if (s) {
        void builder.songUpdate({
          index: idx,
          name: s.name,
          bpm: s.bpm,
          mode: s.mode,
          tsNum: s.tsNum,
          tsDen: s.tsDen,
          click: nextState,
          clickBusId: s.clickBusId || defaultClickBus,
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
        cs.busId === busId ? { ...cs, enabled: !cs.enabled } : cs
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

  useEffect(() => {
    let cancelPoll = false;
    const poll = async () => {
      for (let attempt = 0; attempt < 20 && !cancelPoll; attempt++) {
        const data = await fetchPeaks().catch(() => null);
        if (cancelPoll) return;
        if (data && data.tracks && data.tracks.length > 0) {
          setPeaks(data);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };
    void poll();
    return () => {
      cancelPoll = true;
    };
  }, [state.projectName, state.songIndex]);

  // Continuous multi-song timeline: peak data for every song, not just the
  // staged one. Re-polled (not just fetched once) since AudioEngine builds
  // these in the background -- re-fetching a few times lets the timeline
  // fill in waveforms progressively as the sweep completes, and re-running
  // it when the song count changes picks up newly added songs/tracks.
  useEffect(() => {
    let cancelPoll = false;
    const poll = async () => {
      for (let attempt = 0; attempt < 30 && !cancelPoll; attempt++) {
        const data = await fetchAllPeaks().catch(() => null);
        if (cancelPoll) return;
        if (data) setAllPeaks(data);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    void poll();
    return () => {
      cancelPoll = true;
    };
  }, [state.projectName, state.songs.length]);

  const displaySeconds = state.playheadSeconds;
  const song =
    state.songIndex >= 0 && state.songs[state.songIndex]
      ? state.songs[state.songIndex]
      : null;

  let songLength = 0;
  if (peaks && peaks.tracks) {
    for (const tr of peaks.tracks) {
      if (tr && tr.durationSeconds > songLength)
        songLength = tr.durationSeconds;
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* ── 1. Top Transport bar ──────────────────────────────── */}
      <div className="flex shrink-0 items-stretch gap-0 overflow-hidden rounded-xl border border-default/30 bg-surface/80">
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
                <span>{song.tracks.length} tracks</span>
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
            className="flex h-9 px-4 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold bg-accent text-accent-foreground hover:bg-accent/80 transition-colors"
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
            onClick={() => transport.stop()}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-danger/20 bg-danger/10 text-danger/60 transition-colors hover:bg-danger/20 hover:text-danger"
            title="Stop"
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
              <MetronomeIcon size={16} />
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
              <ChevronDown size={12} className={`transition-transform ${clickSendsOpen ? "rotate-180" : ""}`} />
            </button>
            {/* Popover: one row per bus, toggle send on/off */}
            {clickSendsOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-lg border border-default/40 bg-surface shadow-xl">
                <div className="border-b border-default/20 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/40">
                  Click → Send to Bus
                </div>
                {state.busses.map((bus) => {
                  const send = (song?.clickSends ?? []).find(
                    (cs) => cs.busId === bus.id,
                  );
                  const isActive = send?.enabled === true;
                  return (
                    <button
                      key={bus.id}
                      type="button"
                      onClick={() => toggleClickSend(bus.id)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-default/15 ${
                        isActive ? "text-accent" : "text-foreground/50"
                      }`}
                    >
                      <span
                        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                          isActive ? "bg-accent" : "bg-default/40"
                        }`}
                      />
                      <span className="truncate">{bus.name || bus.id}</span>
                      {bus.isAux && (
                        <span className="ml-auto shrink-0 rounded bg-default/20 px-1 text-[9px] uppercase text-foreground/30">
                          aux
                        </span>
                      )}
                    </button>
                  );
                })}
                {state.busses.length === 0 && (
                  <div className="px-3 py-2 text-xs text-foreground/30">No buses</div>
                )}
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-default/30 bg-surface/60">
          <div className="border-b border-default/20 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-foreground/35">
            Setlist
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {state.songs.length === 0 ? (
              /* Centered vertically when setlist is empty */
              <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-foreground/40">
                No songs in this project.
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-default/15">
                {state.songs.map((s, i) => {
                  const isActive = i === state.songIndex;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => transport.select(i)}
                      className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-default/20 ${
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
                          {s.tracks.length} trk
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
          </div>
        </div>

        {/* Bus meters — Vertical meters (Capped at max 40% screen width) */}
        <div className="flex min-h-0 max-w-[40%] shrink-0 flex-col overflow-hidden rounded-xl border border-default/30 bg-surface/60">
          <div className="border-b border-default/20 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-foreground/35">
            Bus meters
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center gap-6 overflow-x-auto p-4">
            {state.meters.length === 0 ? (
              <div className="py-4 text-center text-sm text-foreground/40">
                No busses.
              </div>
            ) : (
              state.meters.map((m) => {
                const busObj = state.busses.find((b) => b.id === m.id);
                const displayName = busObj?.name || (m.id === "main" ? "Main" : m.id);
                return (
                  <div
                    key={m.id}
                    className="flex h-full flex-col items-center justify-between gap-1.5 py-1"
                  >
                    {/* Bus name */}
                    <div
                      className="truncate text-xs font-semibold text-foreground/80 max-w-[72px]"
                      title={displayName}
                    >
                      {displayName}
                    </div>
                  <div className="flex h-full min-h-0 flex-1 items-center justify-center">
                    <LevelMeterBar
                      db={m.peakDb}
                      vertical={true}
                      showValue={false}
                      className="h-full"
                      barClassName="h-full w-3.5"
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
            }))}
          </div>
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
        />
      </div>
    </div>
  );
}
