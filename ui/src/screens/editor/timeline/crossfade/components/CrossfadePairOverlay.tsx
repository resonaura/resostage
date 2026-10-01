// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useRef } from "react";
import { builder } from "@/lib/state/api";
import type { RegionRow } from "@/lib/state/types";
import { CrossfadeOverlay } from "@/screens/editor/timeline/crossfade/components/CrossfadeOverlay";
import { resizeCrossfade } from "@/screens/editor/timeline/crossfade/logic/crossfadeResize";
import { isCompactLane } from "@/screens/editor/timeline/layout/logic/laneDimensions";
import type { RegionGeom } from "@/screens/editor/timeline/regions/logic/regionDrag";
import type { RegionSelKey } from "@/screens/editor/timeline/regions/logic/regionUtils";
import type { TimelineTool } from "@/screens/editor/timeline/toolbar/logic/tools";

interface PositionedAudioRegion {
  region: RegionRow;
  key: RegionSelKey;
  geom: RegionGeom;
}

interface AudioCrossfadePair {
  earlier: PositionedAudioRegion;
  later: PositionedAudioRegion;
  overlap: number;
}

/** Geometry captured when a crossfade drag begins; see applyResize. */
interface CrossfadeDragBase {
  pairId: string;
  earlier: RegionGeom;
  later: RegionGeom;
  overlap: number;
}

interface CrossfadePairOverlayProps {
  songIndex: number;
  pair: AudioCrossfadePair;
  earlierFileDuration: number;
  laterFileDuration: number;
  pxPerSec: number;
  verticalZoom: number;
  color: string;
  readOnly: boolean;
  tool: TimelineTool;
  regionDragKey: RegionSelKey | null;
  writeGeomDraft: (key: RegionSelKey, geom: RegionGeom) => void;
}

/** Draws and edits the shared overlap handle for two adjacent audio regions. */
export function CrossfadePairOverlay({
  songIndex,
  pair,
  earlierFileDuration,
  laterFileDuration,
  pxPerSec,
  verticalZoom,
  color,
  readOnly,
  tool,
  regionDragKey,
  writeGeomDraft,
}: CrossfadePairOverlayProps) {
  const crossfadeBaseRef = useRef<CrossfadeDragBase | null>(null);
  const { earlier, later, overlap } = pair;
  const pairId = `${earlier.region.id}|${later.region.id}`;

  const applyResize = (
    deltaSeconds: number,
    phase: "start" | "move" | "end",
  ) => {
    // Snapshot on "start" and measure everything against it.
    // The props below are the LIVE geometry, which this gesture is itself
    // changing -- applying each move on top of the previous one compounds,
    // and the crossfade ran away in two frames.
    if (phase === "start") {
      crossfadeBaseRef.current = {
        pairId,
        earlier: { ...earlier.geom },
        later: { ...later.geom },
        overlap,
      };
      return;
    }
    const base = crossfadeBaseRef.current;
    if (!base || base.pairId !== pairId) return;
    const resized = resizeCrossfade(
      {
        sourceOffset: base.earlier.sourceOffset,
        duration: base.earlier.duration,
        fileDuration: earlierFileDuration,
      },
      {
        sourceOffset: base.later.sourceOffset,
        duration: base.later.duration,
        fileDuration: laterFileDuration,
      },
      base.overlap,
      deltaSeconds,
    );
    const nextOverlap = base.overlap + resized.appliedDelta;
    const earlierNext = {
      ...base.earlier,
      duration: resized.earlierDuration,
      fadeOut: nextOverlap,
    };
    const laterNext = {
      ...base.later,
      start: base.later.start + resized.laterStartDelta,
      sourceOffset: resized.laterSourceOffset,
      duration: resized.laterDuration,
      fadeIn: nextOverlap,
    };
    // Draft first either way: the commit round-trips through the engine, and
    // without the draft the pair would snap back for a frame on release.
    writeGeomDraft(earlier.key, earlierNext);
    writeGeomDraft(later.key, laterNext);
    if (phase !== "end") return;
    crossfadeBaseRef.current = null;
    // One gesture id -- the two halves of a crossfade are one edit and have
    // to undo as one.
    const gestureId = crypto.randomUUID();
    void builder.regionUpdate({
      songIndex,
      regionId: earlier.region.id,
      durationSeconds: earlierNext.duration,
      fadeOutSeconds: earlierNext.fadeOut,
      gestureId,
    });
    void builder.regionUpdate({
      songIndex,
      regionId: later.region.id,
      startSeconds: laterNext.start,
      sourceOffsetSeconds: laterNext.sourceOffset,
      durationSeconds: laterNext.duration,
      fadeInSeconds: laterNext.fadeIn,
      gestureId,
    });
  };

  const inset = isCompactLane(verticalZoom) ? 2 : 4;
  return (
    <CrossfadeOverlay
      leftPx={later.geom.start * pxPerSec}
      widthPx={overlap * pxPerSec}
      topInset={inset}
      bottomInset={inset}
      color={color}
      readOnly={readOnly || tool !== "pointer"}
      isActive={regionDragKey === later.key || regionDragKey === earlier.key}
      pxPerSec={pxPerSec}
      onResize={applyResize}
    />
  );
}
