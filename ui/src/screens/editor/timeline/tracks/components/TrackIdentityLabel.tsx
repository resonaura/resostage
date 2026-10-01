// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { Mic, Music } from "lucide-react";
import type { TrackRow } from "@/lib/state/types";

/** Shared identity row for the roomy and compact timeline track headers. */
export function TrackIdentityLabel({
  track,
  color,
  nameSize,
  swatchHeight,
  swatchWidth,
}: {
  track: TrackRow;
  color: string;
  nameSize: number;
  swatchHeight: number;
  swatchWidth: number;
}) {
  const name = track.name || track.id;

  return (
    <>
      <span
        className="shrink-0 rounded-sm"
        style={{
          height: swatchHeight,
          width: swatchWidth,
          background: color,
          opacity: track.mute ? 0.35 : 1,
        }}
      />
      {track.kind === "instrument" ? (
        <Music size={11} className="shrink-0 text-purple-400" />
      ) : (
        <Mic size={11} className="shrink-0 text-foreground/40" />
      )}
      <span
        className={`min-w-0 flex-1 truncate font-semibold text-foreground/90 ${
          track.mute ? "line-through opacity-40" : ""
        }`}
        style={{ fontSize: nameSize }}
        title={name}
      >
        {name}
      </span>
    </>
  );
}
