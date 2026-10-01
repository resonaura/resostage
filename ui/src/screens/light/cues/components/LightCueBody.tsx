/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { LightCueRow } from "@/lib/state/types";
import { EFFECT_META, effectUsesOwnColor } from "@/screens/light/logic/lightEffectMeta";
import type { EffectType } from "@/screens/light/components/LightSidePanel";
import { CUE_EDGE_PX } from "@/screens/light/cues/logic/appearance";

/** Slanted-fade clip path sized to a cue's fadeIn/fadeOut (Cue Block spec).
 * Fades share the cue duration without overlapping (same clamp as the side
 * panel sliders / lightCueInterpolation). */
function cueClipPath(
  cue: Pick<LightCueRow, "durationSeconds"> & {
    fade: Pick<LightCueRow["fade"], "inSeconds" | "outSeconds">;
  },
  pxPerSec: number,
): string | undefined {
  const duration = Math.max(0, cue.durationSeconds);
  const fadeIn = Math.min(Math.max(0, cue.fade.inSeconds), duration);
  const fadeOut = Math.min(Math.max(0, cue.fade.outSeconds), Math.max(0, duration - fadeIn));
  const fadeInPx = fadeIn * pxPerSec;
  const fadeOutPx = fadeOut * pxPerSec;
  if (fadeInPx <= 0 && fadeOutPx <= 0) return undefined;
  return `polygon(${fadeInPx}px 0, calc(100% - ${fadeOutPx}px) 0, 100% 100%, 0 100%)`;
}

/** Shared fill for timeline cues and player/hint previews. */
function lightCueFill(
  cue: Pick<LightCueRow, "intensity"> & {
    color: Pick<LightCueRow["color"], "r" | "g" | "b">;
    effect: Pick<LightCueRow["effect"], "type">;
    gradient: Pick<LightCueRow["gradient"], "preset">;
  },
): { background: string; opacity: number; isOwnColor: boolean } {
  const cueEffectType = cue.effect.type as EffectType;
  const isOwnColor = effectUsesOwnColor(cueEffectType, cue.gradient.preset);
  return {
    isOwnColor,
    background: isOwnColor
      ? "rgb(80, 85, 100)"
      : `rgb(${cue.color.r},${cue.color.g},${cue.color.b})`,
    opacity: Math.max(isOwnColor ? 0.45 : 0.12, cue.intensity),
  };
}

/**
 * Decorative cue body (fill + fade clip + optional label). Used by both the
 * interactive timeline lane and the non-interactive hint/player preview so
 * the two never diverge (borders, colors, fade shape).
 */
export function LightCueBody({
  cue,
  pxPerSec,
  widthPx,
  label,
  showLabel = true,
}: {
  cue: LightCueRow;
  pxPerSec: number;
  widthPx: number;
  label?: string;
  showLabel?: boolean;
}) {
  const fill = lightCueFill(cue);
  const clip = cueClipPath(cue, pxPerSec);
  const labelText =
    (label ?? cue.label) ||
    (cue.effect.type && cue.effect.type !== "none"
      ? EFFECT_META[cue.effect.type as EffectType]?.label || cue.effect.type
      : "");
  const labelShown = showLabel && Boolean(labelText) && widthPx > 24;

  return (
    <>
      <div
        className="absolute inset-0 rounded-sm pointer-events-none"
        style={{
          background: fill.background,
          opacity: fill.opacity,
          clipPath: clip,
          // Flipping between theme-adapted and true colours is a deliberate
          // switch, not a state change to be noticed -- so the colours cross
          // over rather than cutting.
          transition:
            "background-color 260ms ease-out, background 260ms ease-out",
        }}
      />
      {labelShown && (
        <span
          className="absolute top-0.5 left-1.5 truncate text-[9px] font-semibold pointer-events-none select-none"
          style={{
            color: "#ffffffdd",
            textShadow: "0 1px 2px rgba(0,0,0,0.8)",
            maxWidth: `calc(100% - ${CUE_EDGE_PX + 2}px)`,
          }}
        >
          {labelText}
        </span>
      )}
    </>
  );
}
