// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { laneHeightPx } from "@/screens/editor/timeline/layout/logic/laneDimensions";

export interface TrackHeaderLayout {
  height: number;
  showVolume: boolean;
  showPan: boolean;
  showMeter: boolean;
  verticalPadding: number;
  horizontalPadding: number;
  nameSize: number;
  buttonSize: number;
  buttonFontSize: number;
  knobSize: number;
  meterHeight: number;
  faderHeight: number;
  swatchHeight: number;
  swatchWidth: number;
}

/**
 * Resolve track-header density from the shared timeline lane height.
 *
 * The combined fader row is also the meter, so the standalone meter only
 * appears when the lane is too short to fit that row. Meter height is
 * quantized to avoid ResizeObserver churn and canvas flashes during zoom.
 */
export function getTrackHeaderLayout(verticalZoom: number): TrackHeaderLayout {
  const height = laneHeightPx(verticalZoom);
  // Density tiers are keyed to lane height (LANE_HEIGHT=56 at zoom 1).
  const showVolume = height >= 48;
  const showPan = height >= 36;
  // The fader row IS the meter, so the standalone bar is only for lanes too
  // short to fit that row -- two meters on one track would just be the same
  // number twice.
  const showMeter = height >= 28 && !showVolume;
  const verticalPadding =
    height < 32 ? 2 : height < 48 ? 3 : height < 80 ? 4 : 6;
  const horizontalPadding = height < 36 ? 6 : 8;
  const nameSize = height < 32 ? 10 : height < 64 ? 12 : 13;
  const buttonSize = showVolume
    ? height < 64
      ? 18
      : 20
    : height < 36
      ? 16
      : 18;
  const buttonFontSize = showVolume
    ? height < 64
      ? 8.5
      : 9.5
    : height < 36
      ? 7.5
      : 8.5;
  const knobSize = showVolume
    ? height < 64
      ? 18
      : 20
    : height < 48
      ? 15
      : 18;
  // Quantize meter height so vertical zoom doesn't thrash ResizeObserver
  // (and flash the canvas meters) on every sub-step.
  const meterHeight =
    Math.round(Math.max(12, height - verticalPadding * 2 - 4) / 4) * 4;
  // Bar height; the handle is drawn a few px proud of it (see MeterFader).
  const faderHeight = height < 64 ? 12 : height < 96 ? 14 : 16;
  const swatchHeight = height < 32 ? 10 : height < 64 ? 12 : 14;
  const swatchWidth = height < 32 ? 5 : 6;

  return {
    height,
    showVolume,
    showPan,
    showMeter,
    verticalPadding,
    horizontalPadding,
    nameSize,
    buttonSize,
    buttonFontSize,
    knobSize,
    meterHeight,
    faderHeight,
    swatchHeight,
    swatchWidth,
  };
}
