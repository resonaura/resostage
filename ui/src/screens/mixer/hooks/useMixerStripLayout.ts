import { useMemo } from "react";
import type { WebUiState } from "@/lib/state/types";
import { useHorizontalWindow } from "@/screens/mixer/hooks/useHorizontalWindow";
import { isMainBusId } from "@/screens/mixer/logic/mixerIds";
import type { MixerDensity } from "@/screens/mixer/logic/constants";

/**
 * Density-dependent strip pitch: strip width + 8px gap.
 * Narrow: 64px + 8px = 72px
 * Standard: 96px + 8px = 104px
 * Wide: 128px + 8px = 136px
 */
const DENSITY_PITCH_MAP: Record<MixerDensity, number> = {
  narrow: 72,
  standard: 104,
  wide: 136,
};

/**
 * Below this many strips, mount the lot.
 *
 * Windowing is only ever a saving for strips that are off screen, and a pane
 * this short has none on any normal window -- so the threshold costs nothing
 * and keeps small rigs on the simplest possible path. Raise or drop it freely;
 * the windowed and unwindowed renders are identical when everything fits.
 */
const VIRTUALIZE_FROM = 12;

/** Derive the strip collections, solo groups, and visible windows for Mixer. */
export function useMixerStripLayout(state: WebUiState, density: MixerDensity) {
  const auxBusses = state.busses.filter((bus) => bus.isAux);
  const pitchPx = DENSITY_PITCH_MAP[density];
  const trackWindow = useHorizontalWindow({
    count: state.tracks.length,
    pitchPx,
    enabled: state.tracks.length >= VIRTUALIZE_FROM,
  });
  const sendWindow = useHorizontalWindow({
    count: auxBusses.length,
    pitchPx,
    enabled: auxBusses.length >= VIRTUALIZE_FROM,
  });

  // Match the master by its canonical id and nothing else. The old code fell
  // back to "the first non-aux bus" when the id didn't match, which quietly
  // selected an output LANE -- so every control on the master strip was being
  // addressed to the wrong bus index.
  const master = state.busses.find((bus) => isMainBusId(bus.id));
  const masterBusses = master ? [master] : [];
  // Track destination list: master + aux only (no hidden Ext. Out sub-buses).
  // Aux → aux is never offered as a main destination here; track sends only
  // target aux via SendKnobs (no send→send loop).
  const destinationBusses = state.busses.filter(
    (bus) => isMainBusId(bus.id) || bus.isAux,
  );

  // Solo grouping is the engine's rule, not the mixer's: every row arrives
  // tagged with its group and whether anything in that group is soloed, so a
  // strip is drawn dimmed for exactly the reason it is actually silenced.
  const anyTrackSolo =
    state.tracks.some((track) => track.soloActiveInGroup) ||
    (state.click?.soloActiveInGroup ?? false);
  const anyAuxSolo = auxBusses.some((bus) => bus.soloActiveInGroup);

  // Smart aligned mixer racks: align Audio FX slot rows horizontally across the mixer
  const maxPluginSlots = useMemo(() => {
    let maxCount = 0;
    for (const track of state.tracks) {
      const fxCount = track.plugins
        ? track.plugins.filter((plugin) => !plugin.instrument).length
        : 0;
      if (fxCount > maxCount) maxCount = fxCount;
    }
    for (const bus of state.busses) {
      if (bus.plugins && bus.plugins.length > maxCount)
        maxCount = bus.plugins.length;
    }
    if (state.click?.plugins && state.click.plugins.length > maxCount) {
      maxCount = state.click.plugins.length;
    }
    return Math.max(1, maxCount) + 1;
  }, [state.tracks, state.busses, state.click?.plugins]);

  return {
    auxBusses,
    trackWindow,
    sendWindow,
    master,
    masterBusses,
    destinationBusses,
    anyTrackSolo,
    anyAuxSolo,
    maxPluginSlots,
  };
}
