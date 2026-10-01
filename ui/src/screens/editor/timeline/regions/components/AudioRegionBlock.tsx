/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { PeakLevelData, RegionRow } from "@/lib/state/types";
import { TrackWaveformLane } from "@/screens/editor/timeline/waveform/components/TrackWaveformLane";
import { FadeCurveOverlay } from "@/screens/editor/timeline/regions/components/FadeCurveOverlay";
import { RegionLoopBoundaries } from "@/screens/editor/timeline/regions/components/RegionLoopBoundaries";
import { TimelineRegionFrame } from "@/screens/editor/timeline/regions/components/TimelineRegionFrame";
import { isCompactLane, laneHeightPx } from "@/screens/editor/timeline/layout/logic/laneDimensions";
import type { RegionDragMode, RegionGeom } from "@/screens/editor/timeline/regions/logic/regionDrag";
import {
  regionEdgeCursor,
  regionEdgeMode,
  regionFadeHandleAt,
  regionStretchEdge,
} from "@/screens/editor/timeline/regions/logic/regionDrag";
import type { TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";
import type { RegionSelKey, RegionUiState } from "@/screens/editor/timeline/regions/logic/regionUtils";

export function AudioRegionBlock({
  songRegion,
  songName,
  songIndex,
  rowName,
  rowColor,
  /** Whole-region dim: track mute, region mute, or solo-isolate. */
  dimmed = false,
  thisRegionSelKey,
  isRegionSelected,
  regionUi,
  geom,
  leftPx,
  regionWidth,
  peakLevels,
  peaksLoading,
  fileDuration,
  regScrollLeft,
  regViewportWidth,
  maxSourceDur,
  pxPerSec,
  verticalZoom,
  gestureActive,
  readOnly,
  tool,
  isActivelyDragging,
  onSelectRegion,
  onBeginDrag,
  onContextMenu,
  crossfadeIn = false,
  crossfadeOut = false,
  invertPolarity = false,
}: {
  invertPolarity?: boolean;
  songRegion: RegionRow;
  songName: string;
  songIndex: number;
  rowName: string;
  rowColor: string;
  dimmed?: boolean;
  thisRegionSelKey: RegionSelKey;
  isRegionSelected: boolean;
  regionUi: RegionUiState;
  geom: RegionGeom;
  leftPx: number;
  regionWidth: number;
  peakLevels: PeakLevelData[];
  peaksLoading: boolean;
  fileDuration: number;
  regScrollLeft: number;
  regViewportWidth: number;
  maxSourceDur: number;
  pxPerSec: number;
  verticalZoom: number;
  gestureActive: boolean;
  readOnly: boolean;
  /** Active timeline tool -- decides what a pointer over the region means. */
  tool: TimelineTool;
  isActivelyDragging: boolean;
  onSelectRegion: (
    key: RegionSelKey,
    e: React.PointerEvent | React.MouseEvent,
  ) => void;
  onBeginDrag: (e: React.PointerEvent, mode: RegionDragMode) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** This fade is half of a crossfade -- CrossfadeOverlay draws it instead. */
  crossfadeIn?: boolean;
  crossfadeOut?: boolean;
}) {
  // Suppress unused when callers pass for future culling hooks.
  void isActivelyDragging;
  void songRegion;
  void thisRegionSelKey;
  void onSelectRegion;

  const compactLane = isCompactLane(verticalZoom);

  const onRegionPointerDown = (e: React.PointerEvent) => {
    if (readOnly) return;
    // Primary button only -- right-click is context menu.
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    // The fade's own endpoint first: it is inside the region, so the corner
    // hit test below would never see it.
    const fadeHandle = regionFadeHandleAt(
      localX,
      regionWidth,
      geom.fadeIn * pxPerSec,
      geom.fadeOut * pxPerSec,
    );
    if (fadeHandle) {
      onBeginDrag(e, fadeHandle);
      return;
    }
    if (e.altKey && (e.metaKey || e.ctrlKey)) {
      onBeginDrag(e, "slip");
      return;
    }
    const mode = regionEdgeMode(localX, localY, regionWidth, rect.height);
    // Trim-start only useful when there's earlier source to pull.
    if (mode === "trimStart" && geom.sourceOffset <= 0.0001) {
      onBeginDrag(e, "move");
      return;
    }
    onBeginDrag(e, mode);
  };

  // Clip gain rides in the label rather than getting its own badge: it is
  // rarely set, and when it is, it is the thing that explains why a region
  // sounds different from its neighbours -- so it belongs where the eye
  // already goes, not in a corner that has to be hunted for.
  const clipGainDb = songRegion.gainDb ?? 0;
  const gainTag =
    Math.abs(clipGainDb) > 0.05
      ? ` ${clipGainDb > 0 ? "+" : ""}${clipGainDb.toFixed(1)}dB`
      : "";
  const labelText = `${regionUi.muted ? "[M] " : ""}${rowName}${geom.loop ? " ↺" : ""}${gainTag}`;
  // Compact: white on solid strip. Normal: track accent over the waveform.
  const labelColor = compactLane ? "#fff" : rowColor;
  const laneH = laneHeightPx(verticalZoom);
  // Left inset + chip pad scale with lane height — fixed pl-1/px-1.5 ate half
  // the strip at min compact (~22px) and looked absurdly padded.
  const compactInsetL = Math.max(1, Math.min(4, Math.round(laneH * 0.1)));
  const compactChipPadX = Math.max(1, Math.min(4, Math.round(laneH * 0.12)));
  const compactFont = Math.max(7, Math.min(11, laneH - 10));

  return (
    <div key={songRegion.id}>
      <TimelineRegionFrame
        color={rowColor}
        compact={compactLane}
        selected={isRegionSelected}
        muted={regionUi.muted}
        dimmed={dimmed}
        className={`absolute overflow-hidden transition-opacity duration-300 ease-out ${
          compactLane
            ? // flex + items-center: real vertical centering (top% + translate
              // fought line-height/padding and still looked top-heavy).
              "top-0.5 bottom-0.5 rounded-sm flex items-center"
            : "top-1 bottom-1 rounded-md"
        } ${readOnly ? "pointer-events-none" : "pointer-events-auto"}`}
        style={{
          left: leftPx,
          width: regionWidth,
          cursor: readOnly
            ? "default"
            : tool === "stretch"
              ? "default"
              : "grab",
          zIndex: isRegionSelected ? 2 : 1,
        }}
        title={`${rowName} – Song ${songIndex + 1}: ${songName}${geom.loop ? " [loop]" : ""}`}
        // Marks the region for the lane's empty-space handlers: a click that
        // landed on a region is not a click on the lane behind it.
        data-region-block=""
        onPointerDown={onRegionPointerDown}
        onPointerMove={(e) => {
          // Drag geometry is driven by window listeners.
          // Here we only update the edge-zone cursor.
          if (isActivelyDragging || readOnly) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const localX = e.clientX - rect.left;
          // With the stretch tool the region has one job and two places to
          // do it, so the height-banded trim/fade/loop cursors would be
          // describing gestures that are not available.
          const c =
            e.altKey && (e.metaKey || e.ctrlKey)
              ? "ew-resize"
              : tool === "stretch"
                ? regionStretchEdge(localX, regionWidth)
                  ? "ew-resize"
                  : "default"
                : regionFadeHandleAt(
                      localX,
                      regionWidth,
                      geom.fadeIn * pxPerSec,
                      geom.fadeOut * pxPerSec,
                    )
                  ? "col-resize"
                  : regionEdgeCursor(
                      localX,
                      e.clientY - rect.top,
                      regionWidth,
                      rect.height,
                    );
          (e.currentTarget as HTMLElement).style.cursor = c;
        }}
        onContextMenu={onContextMenu}
      >
        {!compactLane && regViewportWidth > 0 && (
          <TrackWaveformLane
            levels={peakLevels}
            durationSeconds={fileDuration}
            regionFile={songRegion.source.file}
            gestureActive={gestureActive}
            verticalZoom={verticalZoom}
            contentWidth={regionWidth}
            scrollLeft={regScrollLeft}
            viewportWidth={regViewportWidth}
            pxPerSec={pxPerSec}
            color={rowColor}
            // Parent region already fades opacity; don't double-dim peaks.
            muted={false}
            sourceOffsetSec={geom.sourceOffset}
            speed={geom.speed}
            reverse={songRegion.playback?.reverse ?? false}
            embedded
            loop={geom.loop}
            loopLengthSec={geom.loopLengthSeconds}
            invertPolarity={invertPolarity}
          />
        )}
        <div
          className={
            compactLane
              ? "pointer-events-none relative z-3 max-w-[min(90%,14rem)] select-none shrink-0"
              : "pointer-events-none absolute left-0.5 top-px z-3 max-w-[min(90%,14rem)] select-none"
          }
          style={compactLane ? { paddingLeft: compactInsetL } : undefined}
        >
          <span
            className="inline-block max-w-full truncate rounded-md font-semibold leading-none"
            style={{
              color: labelColor,
              fontSize: compactLane ? compactFont : 10,
              // Compact: flex-centered, pad scales with lane height.
              // Normal: tight top/left against the region chrome.
              paddingTop: compactLane ? 0 : 1,
              paddingBottom: compactLane ? 0 : 1,
              paddingLeft: compactLane ? compactChipPadX : 3,
              paddingRight: compactLane ? compactChipPadX : 3,
              // Blur only — no solid dark fill.
              background: "transparent",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
            }}
            title={labelText}
          >
            {labelText}
          </span>
        </div>
        {!compactLane && peaksLoading && regionWidth > 40 && (
          <div
            className="absolute bottom-0.5 left-2 text-[8px] pointer-events-none select-none animate-pulse"
            style={{ color: rowColor, opacity: 0.5 }}
          >
            peaks…
          </div>
        )}

        {geom.fadeIn > 0.001 && !crossfadeIn && (
          <FadeCurveOverlay
            side="in"
            widthPx={Math.max(4, geom.fadeIn * pxPerSec)}
            heightPct={100}
            curve={geom.fadeInCurve}
            color={rowColor}
            readOnly={readOnly}
            onPointerDown={(e) => onBeginDrag(e, "fadeInCurve")}
          />
        )}
        {geom.fadeOut > 0.001 && !crossfadeOut && (
          <FadeCurveOverlay
            side="out"
            widthPx={Math.max(4, geom.fadeOut * pxPerSec)}
            heightPct={100}
            curve={geom.fadeOutCurve}
            color={rowColor}
            readOnly={readOnly}
            onPointerDown={(e) => onBeginDrag(e, "fadeOutCurve")}
          />
        )}

        <RegionLoopBoundaries
          enabled={geom.loop}
          durationPx={regionWidth}
          loopLengthPx={
            (geom.loopLengthSeconds && geom.loopLengthSeconds > 0
              ? geom.loopLengthSeconds
              : maxSourceDur) * pxPerSec
          }
          color={rowColor}
        />
      </TimelineRegionFrame>
    </div>
  );
}
