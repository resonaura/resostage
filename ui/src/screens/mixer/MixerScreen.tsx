import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RenderDialogIntent } from "../../transfer/render/components/RenderAudioDialog";
import { useHorizontalWindow } from "./hooks/useHorizontalWindow";
import { useMixerDensity } from "./hooks/useMixerDensity";
import { builder, mixer } from "../../lib/state/api";
import type { WebUiState } from "../../lib/state/types";
import { useIsCompact } from "../../hooks/useMediaQuery";
import { usePluginCatalog } from "./plugins/hooks/usePluginCatalog";
import { extOutTarget, isMainBusId } from "./logic/mixerIds";
import { patchClickFields } from "./logic/mixerUtils";
import {
  resolvePendingBusJobs,
  type PendingBusJob,
} from "./logic/pendingBusJobs";
import type { StripMenuTarget } from "./strips/StripContextMenu";
import { MixerToolbar } from "./components/MixerToolbar";
import { type MixerDensity } from "./logic/constants";
import { MixerClickMasterLane } from "./components/MixerClickMasterLane";
import { MixerTrackRack } from "./components/MixerTrackRack";
import { MixerSendRack } from "./components/MixerSendRack";
import { MixerOverlays, type PluginTarget } from "./components/MixerOverlays";

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

export function MixerScreen({
  state,
  active,
  onRender,
}: {
  state: WebUiState;
  active: boolean;
  onRender: (intent: RenderDialogIntent) => void;
}) {
  const compact = useIsCompact();
  const { density, updateDensity } = useMixerDensity();

  const auxBusses = state.busses.filter((b) => b.isAux);
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
  const master = state.busses.find((b) => isMainBusId(b.id));
  const masterBusses = master ? [master] : [];
  // Track destination list: master + aux only (no hidden Ext. Out sub-buses).
  // Aux → aux is never offered as a main destination here; track sends only
  // target aux via SendKnobs (no send→send loop).
  const destinationBusses = state.busses.filter(
    (b) => isMainBusId(b.id) || b.isAux,
  );
  const pendingBusJobs = useRef<PendingBusJob[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [menu, setMenu] = useState<StripMenuTarget | null>(null);
  const [pluginTarget, setPluginTarget] = useState<PluginTarget | null>(null);
  const effectCatalog = usePluginCatalog(active);

  const openPlugins = useCallback((stripId: string, stripName: string) => {
    setPluginTarget({ stripId, stripName });
  }, []);

  useEffect(() => {
    if (pendingBusJobs.current.length === 0) return;
    pendingBusJobs.current = resolvePendingBusJobs(
      pendingBusJobs.current,
      state.busses,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.busses]);

  function queueBusJob(finalize: (busId: string, index: number) => void) {
    pendingBusJobs.current.push({
      knownIds: new Set(state.busses.map((b) => b.id)),
      finalize,
    });
    void builder.busAdd();
  }

  function requestAddSend() {
    const label = `Send ${auxBusses.length + 1}`;
    // A freshly-added send points at Master (same outs as master) so its
    // destination reads "Master" by default, not an awkward Ext. Out on some
    // stray free channel (which made a just-added send look broken/unrouted).
    const startChannel = master?.startChannel ?? 0;
    queueBusJob((_busId, index) => {
      void builder.busUpdate({
        index,
        name: label,
        channels: 2,
        startChannel,
        gainDb: 0,
        mute: false,
        solo: false,
        isAux: true,
      });
    });
  }

  /**
   * Output lanes are fabricated by the engine from the device's active output
   * channels (never persisted — see BusRow.isDirectOut). Lanes are always
   * mono, so a stereo pick is a pair of them. We only ever route to these —
   * never create project busses for Ext. Out.
   */
  function directBusIdFor(startChannel: number, pair: boolean): string {
    return extOutTarget(startChannel, pair);
  }

  // Stable identities: every strip is memoised (see TrackStrip), and a handler
  // rebuilt each render would defeat that on its own.
  const requestTrackDirectOutput = useCallback(
    (
      trackIndex: number,
      _mono: boolean,
      startChannel: number,
      pair: boolean,
    ) => {
      // Always switch: the lane id is deterministic from the channel and the
      // engine's routing drops any lane that isn't currently present (shadow /
      // unavailable) to silence without rejecting. Gating on the live bus list
      // here made Ext. Out feel dead on tracks (race the moment a lane isn't
      // yet in state.busses), while master -- a plain project bus -- always
      // switched fine.
      void mixer.setTrackBus(trackIndex, directBusIdFor(startChannel, pair));
    },
    [],
  );

  const requestClickDirectOutput = useCallback(
    (startChannel: number, pair: boolean) => {
      patchClickFields(stateRef.current, {
        clickBusId: directBusIdFor(startChannel, pair),
      });
    },
    [],
  );

  // Solo grouping is the engine's rule, not the mixer's: every row arrives
  // tagged with its group and whether anything in that group is soloed, so a
  // strip is drawn dimmed for exactly the reason it is actually silenced.
  const anyTrackSolo =
    state.tracks.some((tr) => tr.soloActiveInGroup) ||
    (state.click?.soloActiveInGroup ?? false);
  const anyAuxSolo = auxBusses.some((b) => b.soloActiveInGroup);
  const songIndex = state.songIndex >= 0 ? state.songIndex : 0;

  // Smart aligned mixer racks: align Audio FX slot rows horizontally across the mixer
  const maxPluginSlots = useMemo(() => {
    let maxCount = 0;
    for (const t of state.tracks) {
      const fxCount = t.plugins
        ? t.plugins.filter((p) => !p.instrument).length
        : 0;
      if (fxCount > maxCount) maxCount = fxCount;
    }
    for (const b of state.busses) {
      if (b.plugins && b.plugins.length > maxCount) maxCount = b.plugins.length;
    }
    if (state.click?.plugins && state.click.plugins.length > maxCount) {
      maxCount = state.click.plugins.length;
    }
    return Math.max(1, maxCount) + 1;
  }, [state.tracks, state.busses, state.click?.plugins]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <MixerToolbar
        trackCount={state.tracks.length}
        busCount={state.busses.length}
        density={density}
        onDensityChange={updateDensity}
      />

      <div
        className={`flex min-h-0 flex-1 rounded-xl border border-default/30 bg-background p-1.5 sm:p-3 ${
          compact ? "overflow-x-auto" : "overflow-hidden"
        }`}
      >
        {state.tracks.length === 0 && state.busses.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center px-4 py-6 text-center text-sm text-foreground/40">
            No tracks staged in this project.
          </div>
        ) : (
          <>
            <MixerTrackRack
              state={state}
              compact={compact}
              density={density}
              contentRef={trackWindow.contentRef}
              window={trackWindow.window}
              destinationBusses={destinationBusses}
              auxBusses={auxBusses}
              anySoloInGroup={anyTrackSolo}
              pluginCatalog={effectCatalog}
              isRecording={state.recording ?? false}
              targetPluginSlots={maxPluginSlots}
              onDirectOutput={requestTrackDirectOutput}
              onOpenPlugins={openPlugins}
              onMenuTarget={setMenu}
              songIndex={songIndex}
            />

            <div className="mx-2 w-px shrink-0 self-stretch bg-default/40" />

            <MixerSendRack
              state={state}
              compact={compact}
              density={density}
              auxBusses={auxBusses}
              master={master}
              anySoloInGroup={anyAuxSolo}
              pluginCatalog={effectCatalog}
              targetPluginSlots={maxPluginSlots}
              contentRef={sendWindow.contentRef}
              visibleWindow={sendWindow.window}
              onAddSend={requestAddSend}
              onOpenPlugins={openPlugins}
              onMenuTarget={setMenu}
            />

            <div className="mx-2 w-px shrink-0 self-stretch bg-default/40" />

            <MixerClickMasterLane
              state={state}
              density={density}
              targetPluginSlots={maxPluginSlots}
              pluginCatalog={effectCatalog}
              master={master}
              masterBusses={masterBusses}
              onDirectOutput={requestClickDirectOutput}
              onOpenPlugins={openPlugins}
              onMenuTarget={setMenu}
            />
          </>
        )}
      </div>

      <MixerOverlays
        state={state}
        songIndex={songIndex}
        menu={menu}
        pluginTarget={pluginTarget}
        onRender={onRender}
        onCloseMenu={() => setMenu(null)}
        onClosePlugins={() => setPluginTarget(null)}
      />
    </div>
  );
}
