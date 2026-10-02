/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { memo, useMemo, useRef, useState } from "react";
import { ContextMenu, ContextMenuDivider, ContextMenuItem } from "@/components/common/ContextMenu";
import { useAutomationKeyboard } from "@/screens/editor/timeline/automation/hooks/useAutomationKeyboard";
import type { AutomationLaneRow } from "@/lib/state/types";
import type { TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";
import {
  beatToPixel,
  buildAutomationSvgPaths,
  decimatePointsForViewport,
  getCurveHandlePosition,
  valueToPixel,
} from "@/screens/editor/timeline/automation/logic/automationCoordinates";
import { formatAutomationValue } from "@/screens/editor/timeline/automation/logic/automationTargets";
import { useAutomationDrag } from "@/screens/editor/timeline/automation/hooks/useAutomationDrag";
import type { AutomationTargetOption } from "@/screens/editor/timeline/automation/logic/types";

export const AutomationLaneOverlay = memo(function AutomationLaneOverlay({
  songIndex,
  lane,
  resetKey,
  bpm,
  pxPerSec,
  widthPx,
  heightPx,
  color = "var(--accent)",
  snapToGrid = true,
  tool = "pointer",
  readOnly = false,
  targetOption,
  currentValue,
  scrollLeft = 0,
  viewportWidth = 1000,
}: {
  songIndex: number;
  lane: AutomationLaneRow;
  resetKey?: string;
  bpm: number;
  pxPerSec: number;
  widthPx: number;
  heightPx: number;
  color?: string;
  snapToGrid?: boolean;
  tool?: TimelineTool;
  readOnly?: boolean;
  targetOption?: AutomationTargetOption;
  currentValue?: number;
  scrollLeft?: number;
  viewportWidth?: number;
}) {
  const [valueInput, setValueInput] = useState<{ x: number; y: number; initialValue: number } | null>(null);
  const {
    activePoints,
    selectedIndices,
    hoverInfo,
    marqueeRect,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    onContextMenu,
    deleteSelectedPoints,
    smoothSelectedPoints,
    setSelectedCurve,
    setSelectedPointsValue,
    selectAllPoints,
    clearSelection,
    selectionCount,
    error,
    isPending,
  } = useAutomationDrag({
    songIndex,
    lane,
    resetKey,
    bpm,
    pxPerSec,
    laneHeight: heightPx,
    snapToGrid,
    tool,
    readOnly,
    targetOption,
    onEditPointValue: (_idx, point, x, y) => {
      setValueInput({ x, y, initialValue: point.value });
    },
  });

  const surface = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const commandId = `${songIndex}.${lane.id}`;
  const minValue = targetOption?.minValue ?? lane.target.minValue;
  const maxValue = targetOption?.maxValue ?? lane.target.maxValue;
  const handleEditValue = () => {
    if (selectedIndices.size === 0 || readOnly || isPending) return;
    const idx = Array.from(selectedIndices)[0];
    const pt = idx !== undefined ? activePoints[idx] : null;
    if (pt) {
      const px = beatToPixel(pt.timeBeats, bpm, pxPerSec);
      const py = valueToPixel(pt.value, heightPx, minValue, maxValue);
      setValueInput({ x: px, y: py, initialValue: pt.value });
    }
  };
  useAutomationKeyboard(commandId, surface, readOnly, {
    deleteSelectedPoints,
    selectAllPoints,
    clearSelection,
    onEditValue: handleEditValue,
  });
  const pointIndices = useMemo(() => new Map(activePoints.map((point, index) => [point, index])), [activePoints]);

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

    for (let i = 0; i < sorted.length - 1 && handles.length < 300; i++) {
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
      ref={surface} tabIndex={-1} aria-label="Automation lane"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.stopPropagation(); surface.current?.focus({ preventScroll: true }); onPointerDown(event);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={(event) => {
        onContextMenu(event);
        if (!readOnly) setMenu({ x: event.clientX, y: event.clientY });
      }}
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
        {activePoints.length > 0 && <path d={fillPath} fill="currentColor" fillOpacity={0.05} />}

        {/* Automation stroke path */}
        {activePoints.length > 0 && <path
          d={strokePath}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />}

        {/* Empty means no persisted points; baseline never becomes a draggable node. */}
        {activePoints.length === 0 && <line data-automation-baseline="true" x1={scrollLeft}
          x2={Math.min(widthPx, scrollLeft + viewportWidth)}
          y1={valueToPixel(currentValue ?? lane.target.defaultValue, heightPx, minValue, maxValue)}
          y2={valueToPixel(currentValue ?? lane.target.defaultValue, heightPx, minValue, maxValue)}
          stroke="currentColor" strokeDasharray="3 3" strokeOpacity={0.35} strokeWidth={1.5} />}

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
        {visiblePoints.map((point) => {
          const index = pointIndices.get(point) ?? -1;
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

      {targetOption?.disabledReason && <div className="pointer-events-none absolute bottom-1 left-2 text-[9px] text-muted max-w-full truncate"
        title={targetOption.disabledReason}>{targetOption.disabledReason}</div>}
      {(error || isPending) && <div className={`pointer-events-none absolute top-1 left-2 text-[10px] ${error ? "text-danger" : "text-muted"}`}
        role={error ? "alert" : "status"}>{error ?? "Saving automation…"}</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
        <ContextMenuItem disabled={selectionCount === 0 || isPending}
          onClick={() => { handleEditValue(); setMenu(null); }}>Set exact value…</ContextMenuItem>
        <ContextMenuDivider />
        <ContextMenuItem disabled={selectionCount === 0 || isPending} danger shortcutCommand={`automation.${commandId}.delete`}
          onClick={() => { deleteSelectedPoints(); setMenu(null); }}>Delete points</ContextMenuItem>
        <ContextMenuItem disabled={selectionCount < 3 || isPending}
          onClick={() => { smoothSelectedPoints(); setMenu(null); }}>Smooth selection</ContextMenuItem>
        <ContextMenuDivider />
        <ContextMenuItem disabled={selectionCount === 0 || isPending}
          onClick={() => { setSelectedCurve(0); setMenu(null); }}>Linear curve</ContextMenuItem>
        <ContextMenuItem disabled={selectionCount === 0 || isPending}
          onClick={() => { setSelectedCurve(0.5); setMenu(null); }}>Curve up</ContextMenuItem>
        <ContextMenuItem disabled={selectionCount === 0 || isPending}
          onClick={() => { setSelectedCurve(-0.5); setMenu(null); }}>Curve down</ContextMenuItem>
        <ContextMenuDivider />
        <ContextMenuItem shortcutCommand={`automation.${commandId}.select-all`}
          onClick={() => { selectAllPoints(); setMenu(null); }}>Select all points</ContextMenuItem>
      </ContextMenu>}

      {valueInput && (
        <div
          className="absolute z-40 flex items-center gap-1.5 rounded-md border border-default/60 bg-surface/95 px-2 py-1 shadow-lg backdrop-blur-sm"
          style={{
            left: Math.max(8, Math.min(widthPx - 140, valueInput.x - 30)),
            top: Math.max(4, Math.min(heightPx - 32, valueInput.y - 14)),
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={(input) => input?.focus()}
            type="number"
            data-testid="automation-exact-value-input"
            aria-label="Set exact automation value"
            step={targetOption?.domain === "strip" && targetOption.parameterId === "faderGainDb" ? 0.1 : 0.01}
            min={minValue}
            max={maxValue}
            defaultValue={Number(valueInput.initialValue.toFixed(3))}
            className="w-20 rounded bg-background px-1.5 py-0.5 text-xs font-mono text-foreground border border-default focus:border-accent focus:outline-none"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (Number.isFinite(val)) {
                  setSelectedPointsValue(val);
                }
                setValueInput(null);
                surface.current?.focus({ preventScroll: true });
              } else if (e.key === "Escape") {
                setValueInput(null);
                surface.current?.focus({ preventScroll: true });
              }
            }}
            onBlur={(e) => {
              const val = parseFloat(e.target.value);
              if (Number.isFinite(val) && val !== valueInput.initialValue) {
                setSelectedPointsValue(val);
              }
              setValueInput(null);
            }}
          />
          {targetOption?.unit && (
            <span className="text-[10px] text-muted font-mono">{targetOption.unit}</span>
          )}
        </div>
      )}

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
