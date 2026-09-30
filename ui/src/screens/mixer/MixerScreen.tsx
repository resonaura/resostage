import { useCallback, useState } from "react";
import type { RenderDialogIntent } from "@/transfer/render/components/RenderAudioDialog";
import { useMixerDensity } from "@/screens/mixer/hooks/useMixerDensity";
import type { WebUiState } from "@/lib/state/types";
import { useIsCompact } from "@/hooks/useMediaQuery";
import { usePluginCatalog } from "@/screens/mixer/plugins/hooks/usePluginCatalog";
import type { StripMenuTarget } from "@/screens/mixer/strips/StripContextMenu";
import { MixerToolbar } from "@/screens/mixer/components/MixerToolbar";
import { MixerClickMasterLane } from "@/screens/mixer/components/MixerClickMasterLane";
import { MixerTrackRack } from "@/screens/mixer/components/MixerTrackRack";
import { MixerSendRack } from "@/screens/mixer/components/MixerSendRack";
import { MixerOverlays, type PluginTarget } from "@/screens/mixer/components/MixerOverlays";
import { useMixerSendCreation } from "@/screens/mixer/hooks/useMixerSendCreation";
import { useMixerStripLayout } from "@/screens/mixer/hooks/useMixerStripLayout";
import { useMixerDirectOutput } from "@/screens/mixer/hooks/useMixerDirectOutput";

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
  const { requestTrackDirectOutput, requestClickDirectOutput } =
    useMixerDirectOutput(state);
  const [menu, setMenu] = useState<StripMenuTarget | null>(null);
  const [pluginTarget, setPluginTarget] = useState<PluginTarget | null>(null);
  const effectCatalog = usePluginCatalog(active);

  const openPlugins = useCallback((stripId: string, stripName: string) => {
    setPluginTarget({ stripId, stripName });
  }, []);

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
