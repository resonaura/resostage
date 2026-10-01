/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { SectionRow } from "@/lib/state/types";
import { formatTimeShort } from "@/screens/editor/timeline/ruler/logic/geometry";

/** Neutral marker chrome — section markers do not use per-section accent colours. */
const SECTION_LINE = "rgba(255,255,255,0.22)";
const SECTION_CHIP_BG = "rgba(255,255,255,0.08)";
const SECTION_CHIP_FG = "rgba(255,255,255,0.55)";

interface SectionMarkerProps {
  section: SectionRow;
  left: number;
  availableWidth: number;
  grabSlopPx: number;
  showChip: boolean;
  chipMax: number;
  compact: boolean;
  readOnly: boolean;
  onPointerDown: React.PointerEventHandler<HTMLDivElement>;
  onDoubleClick: React.MouseEventHandler<HTMLDivElement>;
  onContextMenu: React.MouseEventHandler<HTMLDivElement>;
}

/**
 * A section boundary and its clipped label; gesture ownership stays in the lane.
 * The outer box spans to the next marker only to clip the chip and never takes
 * pointers. Only the visible chrome is interactive, keeping the rest of the
 * lane available for creating another section.
 */
export function SectionMarker({
  section,
  left,
  availableWidth,
  grabSlopPx,
  showChip,
  chipMax,
  compact,
  readOnly,
  onPointerDown,
  onDoubleClick,
  onContextMenu,
}: SectionMarkerProps) {
  return (
    <div
      className="pointer-events-none absolute top-0 bottom-0 z-1 flex items-center overflow-hidden"
      style={{
        // Shifted left by the grab slop and padded back by it, so the line
        // lands exactly on `left` and the chip clips at the section boundary.
        left: left - grabSlopPx,
        width: Math.max(1, availableWidth + 1) + grabSlopPx,
        paddingLeft: grabSlopPx,
      }}
    >
      <div
        className="pointer-events-auto flex h-full items-center"
        style={{
          cursor: readOnly ? "default" : "ew-resize",
          // Grabbable slop around a 1px line, without making the marker look heavier.
          marginLeft: -grabSlopPx,
          paddingLeft: grabSlopPx,
          paddingRight: showChip ? 0 : grabSlopPx,
        }}
        title={`${section.name} @ ${formatTimeShort(section.startSeconds)}${readOnly ? "" : " (drag · double-click = cycle · right-click edit)"}`}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <div className="h-full w-px shrink-0" style={{ background: SECTION_LINE }} />
        {showChip && (
          <div
            className="ml-0.5 truncate rounded font-medium leading-none"
            style={{
              maxWidth: chipMax,
              padding: compact ? "1px 3px" : "2px 4px",
              fontSize: compact ? 8 : 9,
              background: SECTION_CHIP_BG,
              color: SECTION_CHIP_FG,
            }}
          >
            {section.name}
          </div>
        )}
      </div>
    </div>
  );
}
