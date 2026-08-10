import { withHexAlpha } from "../../lib/cssColor";
import type { PeakLevelData, RegionRow } from "../../lib/types";
import { TrackWaveformLane } from "../TrackWaveformLane";
import { dimHexColor } from "./colors";
import { FadeCurveOverlay } from "./FadeCurveOverlay";
import { isCompactLane, laneHeightPx } from "./laneDimensions";
import type { RegionDragMode, RegionGeom } from "./regionDrag";
import { regionEdgeCursor, regionEdgeMode } from "./regionDrag";
import type { RegionSelKey, RegionUiState } from "./regionUtils";

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
  isActivelyDragging,
  onSelectRegion,
  onBeginDrag,
  onContextMenu,
  crossfadeIn = false,
  crossfadeOut = false,
}: {
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
      <div
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
          border: compactLane
            ? isRegionSelected
              ? "2px solid #fff"
              : `1px solid ${dimHexColor(rowColor, regionUi.muted ? 0.52 : 0.68, 1.2)}`
            : isRegionSelected
              ? `2px solid ${rowColor}`
              : `1.5px solid ${withHexAlpha(rowColor, "55")}`,
          background: compactLane
            ? dimHexColor(
                rowColor,
                regionUi.muted ? 0.48 : 0.64,
                regionUi.muted ? 1.05 : 1.22,
              )
            : isRegionSelected
              ? withHexAlpha(rowColor, "30")
              : withHexAlpha(rowColor, "12"),
          boxShadow:
            isRegionSelected && !compactLane
              ? `0 0 0 1px ${withHexAlpha(rowColor, "aa")}, 0 0 10px ${withHexAlpha(rowColor, "44")}`
              : isRegionSelected && compactLane
                ? "0 0 0 1px rgba(255,255,255,0.5)"
                : undefined,
          cursor: readOnly ? "default" : "grab",
          // Dim the WHOLE region chrome (border/fill/label/waveform), not just
          // the peaks canvas — mute + solo-isolate both go through here.
          opacity: dimmed ? 0.35 : 1,
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
          const c = regionEdgeCursor(
            e.clientX - rect.left,
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
          />
        )}
        <div
          className={
            compactLane
              ? "pointer-events-none relative z-[3] max-w-[min(90%,14rem)] select-none shrink-0"
              : "pointer-events-none absolute left-0.5 top-px z-[3] max-w-[min(90%,14rem)] select-none"
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

        {geom.loop &&
          (() => {
            const cycleLen =
              geom.loopLengthSeconds && geom.loopLengthSeconds > 0
                ? geom.loopLengthSeconds
                : maxSourceDur;
            if (cycleLen <= 0.05 || geom.duration <= cycleLen + 0.01)
              return null;
            return Array.from({
              length: Math.floor(geom.duration / cycleLen),
            }).map((_, li) => {
              const x = (li + 1) * cycleLen * pxPerSec;
              if (x <= 2 || x >= regionWidth - 2) return null;
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
                      borderLeft: "4px solid transparent",
                      borderRight: "4px solid transparent",
                      borderTop: `6px solid ${rowColor}`,
                      opacity: 0.9,
                    }}
                  />
                  <div
                    className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2"
                    style={{ background: rowColor, opacity: 0.4 }}
                  />
                  <div
                    className="absolute left-1/2 bottom-0 -translate-x-1/2"
                    style={{
                      width: 0,
                      height: 0,
                      borderLeft: "4px solid transparent",
                      borderRight: "4px solid transparent",
                      borderBottom: `6px solid ${rowColor}`,
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
}
