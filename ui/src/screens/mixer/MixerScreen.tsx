import { useCallback, useRef, useState } from "react";
import type { RenderDialogIntent } from "../../transfer/render/components/RenderAudioDialog";
import { useMixerDensity } from "./hooks/useMixerDensity";
import { mixer } from "../../lib/state/api";
import type { WebUiState } from "../../lib/state/types";
import { useIsCompact } from "../../hooks/useMediaQuery";
import { usePluginCatalog } from "./plugins/hooks/usePluginCatalog";
import { extOutTarget } from "./logic/mixerIds";
import { patchClickFields } from "./logic/mixerUtils";
import type { StripMenuTarget } from "./strips/StripContextMenu";
import { MixerToolbar } from "./components/MixerToolbar";
import { MixerClickMasterLane } from "./components/MixerClickMasterLane";
import { MixerTrackRack } from "./components/MixerTrackRack";
import { MixerSendRack } from "./components/MixerSendRack";
import { MixerOverlays, type PluginTarget } from "./components/MixerOverlays";
import { useMixerSendCreation } from "./hooks/useMixerSendCreation";
import { useMixerStripLayout } from "./hooks/useMixerStripLayout";

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

  const {
    auxBusses,
    trackWindow,
    sendWindow,
    master,
    masterBusses,
    destinationBusses,
    anyTrackSolo,
    anyAuxSolo,
    maxPluginSlots,
  } = useMixerStripLayout(state, density);
  const { requestAddSend } = useMixerSendCreation({
    busses: state.busses,
    auxBusses,
    master,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [menu, setMenu] = useState<StripMenuTarget | null>(null);
  const [pluginTarget, setPluginTarget] = useState<PluginTarget | null>(null);
  const effectCatalog = usePluginCatalog(active);

  const openPlugins = useCallback((stripId: string, stripName: string) => {
    setPluginTarget({ stripId, stripName });
  }, []);

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

  const songIndex = state.songIndex >= 0 ? state.songIndex : 0;

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
