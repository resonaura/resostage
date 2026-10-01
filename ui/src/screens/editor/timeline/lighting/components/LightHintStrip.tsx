// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { roleColor } from "@/lib/theme";
import type { SongRow } from "@/lib/state/types";
import { LightCueBody } from "@/screens/light/cues/components/LightCueBody";
import {
  adaptCueToTheme,
  lightCueSelectionStyle,
} from "@/screens/light/cues/logic/appearance";
import { themeAdaptedColor } from "@/screens/light/logic/tintFilter";
import { useThemeVersion } from "@/hooks/useThemeVersion";

// Audio mode: a dimmed, non-interactive strip near the top showing that light
// content exists on the timeline without offering any click targets.
export function LightHintStrip({
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  scrollState,
  contentWidth,
  height,
  trackColor,
}: {
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  scrollState: { scrollLeft: number; viewportWidth: number };
  contentWidth: number;
  height: number;
  trackColor: (trackId: string) => string;
}) {
  // One filter for the whole strip, recomputed only when the theme moves --
  // there can be hundreds of cues on screen and the chain is identical for
  // every one of them.
  // Subscribed, not memoised. The resolved colour used to be cached in a
  // useMemo keyed on this version and went stale often enough to notice;
  // roleColor is already a cached DOM probe, so re-resolving it once per
  // render of one component costs nothing and cannot be out of date.
  useThemeVersion();
  const tint = roleColor("master");

  const viewStart = scrollState.scrollLeft;
  const viewEnd = scrollState.scrollLeft + scrollState.viewportWidth;
  return (
    <div
      className="pointer-events-none relative shrink-0 border-b border-default/30 bg-surface/20"
      style={{ width: contentWidth, height }}
    >
      {songs.map((song, i) => {
        const segStart = songOffsets[i] * pxPerSec;
        const segEnd = segStart + songLengths[i] * pxPerSec;
        if (viewEnd <= segStart || viewStart >= segEnd) return null;
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0"
            style={{ left: segStart, width: songLengths[i] * pxPerSec }}
          >
            {(song.lightCues ?? []).map((cue) => {
              const leftPx = cue.startSeconds * pxPerSec;
              const widthPx = Math.max(3, cue.durationSeconds * pxPerSec);
              if (
                leftPx + widthPx < viewStart - segStart ||
                leftPx > viewEnd - segStart
              )
                return null;
              return (
                <div
                  key={cue.id}
                  className="absolute top-1 bottom-1 rounded-sm overflow-hidden"
                  style={{
                    left: leftPx,
                    width: widthPx,
                    // Quiet reference strip (player / audio mode): the cue
                    // keeps its brightness but takes its hue from the theme,
                    // so the strip reads as one calm layer instead of as a
                    // second, louder palette. Computed rather than filtered
                    // -- see ../logic/tintFilter for the two CSS approaches
                    // this replaces and why each failed.
                    ...lightCueSelectionStyle(
                      false,
                      themeAdaptedColor(trackColor(cue.trackId), tint),
                    ),
                    opacity: 0.22,
                  }}
                >
                  <LightCueBody
                    cue={adaptCueToTheme(cue, tint)}
                    pxPerSec={pxPerSec}
                    widthPx={widthPx}
                    showLabel={false}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
