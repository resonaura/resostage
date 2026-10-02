/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { memo, useMemo } from "react";
import type { AutomationLaneRow } from "@/lib/state/types";
import type { TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";
import {
  beatToPixel,
  buildAutomationSvgPaths,
  decimatePointsForViewport,
  getCurveHandlePosition,
  valueToPixel,
} from "../logic/automationCoordinates";
import { formatAutomationValue } from "../logic/automationTargets";
import { useAutomationDrag } from "../hooks/useAutomationDrag";
import type { AutomationTargetOption } from "../logic/types";

export const AutomationLaneOverlay = memo(function AutomationLaneOverlay({
  songIndex,
  lane,
  bpm,
  pxPerSec,
  widthPx,
  heightPx,
  color = "var(--rs-accent, #3b82f6)",
  snapToGrid = true,
  tool = "pointer",
  readOnly = false,
  targetOption,
  scrollLeft = 0,
  viewportWidth = 1000,
}: {
  songIndex: number;
  lane: AutomationLaneRow;
  bpm: number;
  pxPerSec: number;
  widthPx: number;
  heightPx: number;
  color?: string;
  snapToGrid?: boolean;
  tool?: TimelineTool;
  readOnly?: boolean;
  targetOption?: AutomationTargetOption;
  scrollLeft?: number;
  viewportWidth?: number;
}) {
  const {
    activePoints,
    selectedIndices,
    hoverInfo,
    marqueeRect,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  } = useAutomationDrag({
    songIndex,
    lane,
    bpm,
    pxPerSec,
    laneHeight: heightPx,
    snapToGrid,
    tool,
    readOnly,
    targetOption,
  });

  const minValue = targetOption?.minValue ?? 0;
  const maxValue = targetOption?.maxValue ?? 1;

  // LOD decimation for path and point rendering across long timelines
  const visiblePoints = useMemo(() => {
    return decimatePointsForViewport(
      activePoints,
      bpm,
      pxPerSec,
      scrollLeft,
      scrollLeft + viewportWidth,
      300,
    );
  }, [activePoints, bpm, pxPerSec, scrollLeft, viewportWidth]);

  const { strokePath, fillPath } = useMemo(() => {
    return buildAutomationSvgPaths(
      visiblePoints,
      bpm,
      pxPerSec,
      heightPx,
      widthPx,
      minValue,
      maxValue,
    );
  }, [visiblePoints, bpm, pxPerSec, heightPx, widthPx, minValue, maxValue]);

  // Intermediate curve handles between points
  const curveHandles = useMemo(() => {
    const handles: Array<{
      beforeIdx: number;
      afterIdx: number;
      x: number;
      y: number;
      curve: number;
    }> = [];
    const sorted = activePoints
      .map((p, i) => ({ point: p, index: i }))
      .sort((a, b) => a.point.timeBeats - b.point.timeBeats);

    for (let i = 0; i < sorted.length - 1; i++) {
      const p1 = sorted[i];
      const p2 = sorted[i + 1];
      const handle = getCurveHandlePosition(
        p1.point,
        p2.point,
        bpm,
        pxPerSec,
        heightPx,
        minValue,
        maxValue,
      );
      // Viewport culling for handles
      if (
        handle.x >= scrollLeft - 20 &&
        handle.x <= scrollLeft + viewportWidth + 20
      ) {
        handles.push({
          beforeIdx: p1.index,
          afterIdx: p2.index,
          x: handle.x,
          y: handle.y,
          curve: p1.point.curve,
        });
      }
    }
    return handles;
  }, [
    activePoints,
    bpm,
    heightPx,
    maxValue,
    minValue,
    pxPerSec,
    scrollLeft,
    viewportWidth,
  ]);

  return (
    <div
      className="absolute inset-0 pointer-events-auto select-none z-10"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        cursor:
          tool === "eraser"
            ? "crosshair"
            : tool === "pencil"
              ? "crosshair"
              : "default",
      }}
    >
      <svg
        width={widthPx}
        height={heightPx}
        className="absolute inset-0 overflow-visible"
        style={{ color }}
      >
        {/* Fill under automation line */}
        <path d={fillPath} fill="currentColor" fillOpacity={0.12} />

        {/* Automation stroke path */}
        <path
          d={strokePath}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Curve handles */}
        {curveHandles.map((handle) => (
          <circle
            key={`handle:${handle.beforeIdx}-${handle.afterIdx}`}
            cx={handle.x}
            cy={handle.y}
            r={3.5}
            className={`cursor-ns-resize transition-all ${
              Math.abs(handle.curve) > 0.05
                ? "fill-accent stroke-surface"
                : "fill-foreground/40 hover:fill-accent stroke-surface/80"
            }`}
            strokeWidth={1.5}
          />
        ))}

        {/* Breakpoint Nodes */}
        {activePoints.map((point, index) => {
          const px = beatToPixel(point.timeBeats, bpm, pxPerSec);
          const py = valueToPixel(point.value, heightPx, minValue, maxValue);

          // Culling check for off-screen points
          if (px < scrollLeft - 20 || px > scrollLeft + viewportWidth + 20) {
            return null;
          }

          const isSelected = selectedIndices.has(index);

          return (
            <g key={`pt:${index}:${point.timeBeats}`}>
              <circle
                cx={px}
                cy={py}
                r={isSelected ? 5.5 : 4}
                className={
                  isSelected
                    ? "fill-foreground stroke-accent transition-transform"
                    : "fill-surface stroke-current hover:scale-125 transition-transform"
                }
                strokeWidth={2}
              />
            </g>
          );
        })}
      </svg>

      {/* Marquee Selection Rectangle */}
      {marqueeRect && (
        <div
          className="pointer-events-none absolute border border-accent/80 bg-accent/15 z-20"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      )}

      {/* Hover / Drag Readout Tooltip */}
      {hoverInfo && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded bg-surface/90 border border-default/40 px-1.5 py-0.5 text-[10px] font-mono text-foreground shadow-md z-30"
          style={{
            left: hoverInfo.x,
            top: Math.max(16, hoverInfo.y - 8),
          }}
        >
          {hoverInfo.type === "curveHandle"
            ? `Curve: ${hoverInfo.value >= 0 ? "+" : ""}${hoverInfo.value.toFixed(2)}`
            : `${formatAutomationValue(hoverInfo.value, targetOption)} · ${hoverInfo.timeBeats.toFixed(2)} bt`}
        </div>
      )}
    </div>
  );
});
