/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { BusRow, TrackRow } from "@/lib/state/types";

export interface PluginSidechainSourceOption {
  id: string;
  label: string;
}

/**
 * Sidechains may read rendered audio tracks or project buses, never fabricated
 * hardware-output lanes, MIDI-only rows, or the destination itself.
 */
export function pluginSidechainSources(
  tracks: readonly TrackRow[],
  busses: readonly BusRow[],
  destinationStripId: string,
): PluginSidechainSourceOption[] {
  const seen = new Set<string>([destinationStripId]);
  const sources: PluginSidechainSourceOption[] = [];

  for (const track of tracks) {
    if (track.kind === "midi" || track.kind === "externalMidi"
      || track.kind === "lighting" || track.kind === "folder"
      || track.kind === "busTimeline") continue;
    const id = track.stripId?.trim() || track.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    sources.push({ id, label: `Track · ${track.name || id}` });
  }

  for (const bus of busses) {
    if (bus.isDirectOut) continue;
    if (!bus.id || seen.has(bus.id)) continue;
    seen.add(bus.id);
    sources.push({ id: bus.id, label: `Bus · ${bus.name || bus.id}` });
  }

  return sources;
}
