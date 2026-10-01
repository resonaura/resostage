// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import type { HTMLAttributes, ReactNode } from "react";
import { withHexAlpha } from "@/lib/theme/cssColor";
import { dimHexColor } from "@/screens/editor/timeline/regions/logic/colors";

type TimelineRegionFrameProps = HTMLAttributes<HTMLDivElement> & {
  color: string;
  compact: boolean;
  selected: boolean;
  dimmed?: boolean;
  muted?: boolean;
  children: ReactNode;
};

/** Shared audio/MIDI region shell: track tint, selection, compact fill, and dimming. */
export function TimelineRegionFrame({
  color,
  compact,
  selected,
  dimmed = false,
  muted = false,
  children,
  style,
  ...props
}: TimelineRegionFrameProps) {
  return (
    <div
      {...props}
      style={{
        border: compact
          ? selected
            ? "2px solid #fff"
            : `1px solid ${dimHexColor(color, muted ? 0.52 : 0.68, 1.2)}`
          : selected
            ? `2px solid ${color}`
            : `1.5px solid ${withHexAlpha(color, "55")}`,
        background: compact
          ? dimHexColor(color, muted ? 0.48 : 0.64, muted ? 1.05 : 1.22)
          : selected
            ? withHexAlpha(color, "30")
            : withHexAlpha(color, "12"),
        boxShadow:
          selected && !compact
            ? `0 0 0 1px ${withHexAlpha(color, "aa")}, 0 0 10px ${withHexAlpha(color, "44")}`
            : selected && compact
              ? "0 0 0 1px rgba(255,255,255,0.5)"
              : undefined,
        opacity: dimmed ? 0.35 : 1,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
