/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import {
  rowsSameExceptLevels,
  sameExceptLevels,
} from "@/lib/audio/levelFields";
import type { TrackStripProps } from "@/screens/mixer/strips/types";

/**
 * A strip is expensive -- two routing selects, a send knob per aux, a fader --
 * and none of it depends on how loud the track currently is. The default
 * shallow compare would still re-render all of it on every telemetry frame,
 * because `t` and `meters` are new objects whenever a peak moves; see
 * lib/levelFields.
 */
export function areTrackStripPropsEqual(
  prev: TrackStripProps,
  next: TrackStripProps,
): boolean {
  return (
    prev.index === next.index &&
    prev.density === next.density &&
    prev.targetPluginSlots === next.targetPluginSlots &&
    prev.anySoloInGroup === next.anySoloInGroup &&
    prev.settings === next.settings &&
    prev.isRecording === next.isRecording &&
    prev.onDirectOutput === next.onDirectOutput &&
    prev.onOpenPlugins === next.onOpenPlugins &&
    prev.pluginCatalog === next.pluginCatalog &&
    // The bus lists are `.filter()` results, so they are new arrays every
    // render even when nothing moved -- compare them by content.
    rowsSameExceptLevels(prev.destinationBusses, next.destinationBusses) &&
    sameExceptLevels(prev.t, next.t) &&
    rowsSameExceptLevels(prev.allBusses, next.allBusses) &&
    rowsSameExceptLevels(prev.auxBusses, next.auxBusses) &&
    rowsSameExceptLevels(prev.meters, next.meters)
  );
}
