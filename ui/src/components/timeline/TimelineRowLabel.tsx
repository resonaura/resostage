import { memo } from "react";
import { laneHeightPx } from "./laneDimensions";

// Read-only sidebar row for a track that only exists in a non-staged song --
// no mixer controls, since there's no staged track index to drive them with.
export const TimelineRowLabel = memo(function TimelineRowLabel({
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
