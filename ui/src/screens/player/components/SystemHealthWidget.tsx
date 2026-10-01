/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { addRafTask } from "@/lib/state/rafLoop";
import type { WebUiState } from "@/lib/state/types";

/**
 * One health sparkline.
 *
 * Two things here are deliberately not React's job:
 *
 *  - the SLIDE. History arrives once a second, so the line used to jump a
 *    whole step at a time. It now slides that step over the following second,
 *    driven from the app's shared rAF and written straight to a transform --
 *    no state, no re-render, and it stands down with everything else when the
 *    frame budget drops or the window is idle.
 *  - the COLOUR. Stroke and fill are set as styles rather than as SVG
 *    attributes, because a CSS transition only applies to properties, not to
 *    presentation attributes. Crossing the warning threshold now fades
 *    instead of snapping, which is what stops a graph hovering on the
 *    boundary from strobing between two colours.
 */
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
  const WIDTH = 90;
  // The line is drawn ONE STEP WIDER than the box it lives in, starting off
  // the left edge.
  //
  // A sample that is about to be dropped has to already be outside the
  // viewport, or its removal re-spaces every remaining point and the whole
  // graph jerks -- which is what "a point is removed and the graph jumps" was. With
  // the domain running from -step to WIDTH, the oldest point spends its last
  // second travelling out through the left edge (the svg clips it) and is
  // gone from view well before it is gone from the array. The newest enters
  // the same way on the right.
  const stepPx = WIDTH / Math.max(1, history.length - 2);
  const points = history.map((val, i) => {
    const x = -stepPx + i * stepPx;
    const y = 24 - (val / maxVal) * 20;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const pathD = points.length > 0 ? `M ${points.join(" L ")}` : "";
  const areaD =
    points.length > 0
      ? `M ${(-stepPx).toFixed(1)},24 L ${points.join(" L ")} L ${WIDTH},24 Z`
      : "";

  const slideRef = useRef<SVGGElement | null>(null);
  const sampleAtRef = useRef(0);
  const stepRef = useRef(stepPx);
  stepRef.current = stepPx;
  const lengthRef = useRef(history.length);

  // A new sample is a new array from the history hook; length alone would
  // miss every update once the window is full.
  //
  // The slide only makes sense once the window IS full. While the history is
  // still filling, every sample also changes the x spacing of every point --
  // so sliding on top of that opened and closed a gap at the left edge on
  // each tick. Until then the line just grows in place, which is what it
  // looks like it should do anyway.
  // Layout effect, and it writes the transform itself rather than leaving it
  // to the next frame.
  //
  // A new sample re-renders the polyline already shifted one step left; the
  // transform that holds it in place until it can slide is applied by the rAF
  // task below. At 60fps the gap between those two is a frame nobody sees. At
  // the 15fps cap it is up to 66ms of the graph sitting a whole step to the
  // left of where it was -- the jump, followed by the slide it was supposed
  // to have instead of.
  useLayoutEffect(() => {
    const grew = history.length !== lengthRef.current;
    lengthRef.current = history.length;
    sampleAtRef.current = grew ? 0 : performance.now();
    const g = slideRef.current;
    if (g) {
      g.style.transform = grew
        ? ""
        : `translateX(${stepRef.current.toFixed(2)}px)`;
    }
  }, [history]);

  useEffect(() => {
    return addRafTask((nowMs) => {
      const g = slideRef.current;
      if (!g) return;
      // Interval is the health feed's own 1 Hz. Overshooting simply parks at
      // zero, which is the right resting state between samples.
      // 0 means "do not slide" -- the window is still filling.
      const since = sampleAtRef.current;
      const t = since === 0 ? 1 : Math.min(1, (nowMs - since) / 1000);
      const dx = (1 - t) * stepRef.current;
      g.style.transform = dx > 0.01 ? `translateX(${dx.toFixed(2)}px)` : "";
    });
  }, []);

  const swatch = color === "var(--default)" ? "var(--segment)" : color;

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="flex items-center justify-between w-full text-[10px] tabular-nums font-semibold">
        <span className="text-foreground/40 uppercase">{label}</span>
        <span style={{ color: swatch, transition: "color 400ms ease-out" }}>
          {valueText}
        </span>
      </div>
      <svg width="90" height="24" className="overflow-hidden">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              style={{
                stopColor: color,
                stopOpacity: 0.35,
                transition: "stop-color 400ms ease-out",
              }}
            />
            <stop
              offset="100%"
              style={{
                stopColor: color,
                stopOpacity: 0,
                transition: "stop-color 400ms ease-out",
              }}
            />
          </linearGradient>
        </defs>
        <g ref={slideRef}>
          <path d={areaD} fill={`url(#${gradientId})`} />
          <path
            d={pathD}
            fill="none"
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ stroke: color, transition: "stroke 400ms ease-out" }}
          />
        </g>
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
export const SystemHealthWidget = memo(function SystemHealthWidget({
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
  const lastCpu = cpuHistory[cpuHistory.length - 1] ?? h?.cpuPercent ?? 0;
  const cpuVal = Number.isFinite(lastCpu) ? Math.max(0, lastCpu) : 0;
  const rawRam =
    ramHistory[ramHistory.length - 1] ?? (h?.rssBytes ?? 0) / (1024 * 1024);
  const ramVal = Number.isFinite(rawRam) ? Math.max(0, rawRam) : 0;
  // Hardware limits derived dynamically from C++ JUCE SystemHealth:
  const cores = Math.max(1, h?.cpuCoreCount ?? 8);
  const totalCpuMax = cores * 100;

  const rawTotalRam = (h?.systemTotalBytes ?? 0) / (1024 * 1024);
  const totalRamMb =
    Number.isFinite(rawTotalRam) && rawTotalRam > 0 ? rawTotalRam : 16384;

  // Colour follows the CURRENT value, not the window's peak.
  //
  // Keyed on the max, one spike thirty seconds ago left the graph red for the
  // next thirty -- so the colour stopped meaning "this machine is in trouble"
  // and started meaning "was, at some point". The line's HEIGHT already keeps
  // the history; the colour is the only thing that can say what is happening
  // now, and on stage that is the question being asked.
  const cpuRatio = cpuVal / totalCpuMax;
  const ramRatio = totalRamMb > 0 ? ramVal / totalRamMb : ramVal / 16384;

  // Warning (>= 65% total system CPU / >= 50% total system RAM)
  // Danger (>= 85% total system CPU / >= 75% total system RAM)
  const cpuColor =
    cpuRatio >= 0.85
      ? "var(--danger)"
      : cpuRatio >= 0.65
        ? "var(--warning)"
        : "var(--default)";

  const ramColor =
    ramRatio >= 0.75
      ? "var(--danger)"
      : ramRatio >= 0.5
        ? "var(--warning)"
        : "var(--default)";

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
          className={`flex items-center gap-1 font-bold ${playing ? "text-accent" : "text-segment"}`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${playing ? "animate-pulse bg-accent" : "bg-segment"}`}
          />
          {playing ? "PLAYING" : "STOPPED"}
        </div>
        {(h?.underrunCount ?? 0) > 0 ? (
          <span className="font-bold text-warning">
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
