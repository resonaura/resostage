// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { TriangleAlert } from "lucide-react";
import type { LightFixtureRow, LightTrackRow } from "@/lib/state/types";

// Sidebar row for a light track — clickable to open settings in LightSidePanel.
// Height tracks verticalZoom (passed as `height`); typography/padding scale
// with it so the left rail stays aligned with light lanes at any zoom.
export function LightTrackHeader({
  track,
  color,
  height,
  selected,
  onSelect,
  onContextMenu,
}: {
  track: LightTrackRow;
  index?: number;
  fixtures?: LightFixtureRow[];
  color: string;
  height: number;
  selected?: boolean;
  onSelect?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const h = Math.max(22, Math.round(height));
  const padX = h < 36 ? 8 : 12;
  const nameSize = h < 32 ? 10 : h < 64 ? 12 : 13;
  const metaSize = Math.max(8, nameSize - 2);
  const swatchH = h < 32 ? 10 : 14;
  const swatchW = h < 32 ? 6 : 8;
  const iconSize = h < 36 ? 9 : 10;
  return (
    <div
      className={`flex items-center gap-2 border-b border-default/15 select-none overflow-hidden cursor-pointer transition-colors ${
        selected
          ? "tint--subtle border-l-2 border-l-accent"
          : "bg-surface/20 hover:bg-surface/40"
      }`}
      style={{ height: h, padding: `0 ${padX}px` }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title="Click to edit track in side panel (Right-click for context menu)"
    >
      <span
        className="shrink-0 rounded-sm"
        style={{ height: swatchH, width: swatchW, background: color }}
      />
      <span
        className="min-w-0 flex-1 truncate font-medium text-foreground/80"
        style={{ fontSize: nameSize }}
        title={track.name}
      >
        {track.name}
      </span>
      {track.fixtureIds.length === 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 font-mono text-warning"
          style={{ fontSize: metaSize }}
          title="No fixtures assigned -- cues on this track won't drive anything until you check at least one fixture below"
        >
          <TriangleAlert size={iconSize} />
          0f
        </span>
      ) : (
        <span
          className="shrink-0 font-mono text-foreground/30"
          style={{ fontSize: metaSize }}
        >
          {track.fixtureIds.length}f
        </span>
      )}
    </div>
  );
}
